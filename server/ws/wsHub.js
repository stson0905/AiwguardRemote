// 연결된 브라우저들에게 실시간 상태(탐지 프레임, 알람, 연결상태, 설정변경)를 브로드캐스트한다.
// 클라이언트 -> 서버 명령은 REST API로 처리하므로 이 허브는 순수 push 채널이다.
//
// 24시간 켜 두는 관제 화면을 상대하므로 두 가지 안전장치를 둔다.
//  - 하트비트(ping/pong): 브라우저가 죽거나 네트워크가 끊겨도 TCP는 FIN 없이 조용히 사라질 수 있다.
//    그러면 서버는 그 소켓을 산 것으로 알고 계속 send()해 보내기 버퍼가 무한정 쌓인다. 일정 시간 pong이
//    없으면 소켓을 끊어 그 메모리를 회수한다.
//  - 백프레셔: 느린 클라이언트(백그라운드 탭, 약한 무선 링크)에 프레임이 밀리면 최신 프레임만 의미가 있는
//    'frame' 메시지는 건너뛴다. 알람/설정 변경처럼 빠뜨리면 안 되는 메시지는 항상 보낸다.
import { WebSocketServer } from 'ws';

const HEARTBEAT_MS = 30_000;
/** 이보다 많이 밀려 있는 클라이언트에는 최신 프레임만 의미 있는 메시지를 건너뛴다 */
const MAX_BUFFERED_BYTES = 1_000_000;
/** 건너뛰어도 되는(다음 것이 곧 오는) 메시지 종류 */
const DROPPABLE_TYPES = new Set(['frame', 'flow']);
/**
 * 화면 표시용이라 "그 채널을 지금 화면에 띄운 브라우저"에만 보내면 되는 메시지 종류.
 * 침수/유속 판정과 알람은 서버(roiEngine)가 모든 채널에 대해 이미 끝냈으므로, 안 보이는 채널의
 * 프레임을 보내지 않아도 감지·알람에는 아무 영향이 없다. 128채널이면 초당 수백 건의 JSON 전송/파싱이 줄어든다.
 */
const PER_CHANNEL_TYPES = new Set(['frame', 'flow']);
/** 구독 목록 최대 길이(브라우저 한 화면은 많아야 36칸) — 잘못된/악의적 메시지로 메모리를 쓰지 않게 */
const MAX_SUBSCRIBE = 256;

export class WsHub {
  constructor(server, { store, tcpSourceManager, mediamtxCfgGetter, activeAlarmsGetter, alarmingGetter }) {
    this.alarmingGetter = alarmingGetter || (() => []);
    // 브라우저→서버로는 구독 목록(작은 JSON)만 오므로 수신 크기를 작게 제한한다.
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
    this.store = store;
    this.tcpSourceManager = tcpSourceManager;
    this.activeAlarmsGetter = activeAlarmsGetter || (() => []);

    // ws는 붙어 있는 http 서버의 오류(포트 충돌 등)를 자기 'error' 이벤트로 다시 던진다.
    // 여기서 받아두지 않으면 EventEmitter 규칙상 예외로 터져서, http 서버 쪽에 준비해 둔
    // 친절한 안내(server/index.js의 server.on('error'))가 나오기도 전에 프로세스가 죽는다.
    this.wss.on('error', () => { /* 실제 처리는 http 서버의 error 핸들러가 담당 */ });

    this.wss.on('connection', (socket) => {
      socket.isAlive = true;
      socket.droppedFrames = 0;
      // 이 브라우저가 지금 화면에 띄운 채널(Set). null = 아직 구독을 안 보낸 클라이언트(구버전 화면 포함) → 전부 보낸다.
      socket.subs = null;
      socket.on('pong', () => { socket.isAlive = true; });
      socket.on('message', (data) => this._onClientMessage(socket, data));
      socket.on('error', () => {});
      this._send(socket, {
        type: 'init',
        config: this.store.get(),
        tcpStatus: this.tcpSourceManager.getStatuses(),
        // 수신 대기(server) 모드에서 지금 몇 대가 붙어 있는지 등 부가 정보
        tcpDetails: this.tcpSourceManager.getDetails(),
        // 이미 진행 중인(아직 확인 안 된) 알람 — 알람은 발생 "순간"에만 브로드캐스트되므로
        // 이걸 같이 보내지 않으면 침수 중에 새로고침한 화면에는 팝업이 하나도 뜨지 않는다.
        activeAlarms: this.activeAlarmsGetter(),
        // 확인됐어도 아직 경보 상태인 채널×ROI (페이지 지도/채널 목록의 빨간 표시용)
        alarming: this.alarmingGetter()
      });
    });

    this.heartbeat = setInterval(() => this._checkHeartbeats(), HEARTBEAT_MS);
    // 이 타이머 때문에 프로세스가 못 끝나는 일은 없어야 한다(종료는 http 서버가 결정).
    this.heartbeat.unref?.();
  }

  _checkHeartbeats() {
    for (const client of this.wss.clients) {
      if (client.isAlive === false) {
        // 직전 ping에 pong이 없었다 — 죽은 연결로 보고 즉시 끊는다(정상 close 핸드셰이크를 기다리지 않음).
        client.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.readyState === 1 /* OPEN */) {
        try { client.ping(); } catch { /* 닫히는 중이면 다음 주기에 정리된다 */ }
      }
    }
  }

  /** 브라우저가 보내는 메시지 — 지금은 {type:'subscribe', channelIds:[...]} 하나뿐. 모르는 것은 무시한다. */
  _onClientMessage(socket, data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg?.type !== 'subscribe') return;
    if (!Array.isArray(msg.channelIds)) { socket.subs = null; return; }
    socket.subs = new Set(msg.channelIds.slice(0, MAX_SUBSCRIBE).filter((id) => typeof id === 'string'));
  }

  _anyoneWatching(channelId) {
    for (const c of this.wss.clients) if (!c.subs || c.subs.has(channelId)) return true;
    return false;
  }

  broadcast(message) {
    if (this.wss.clients.size === 0) return; // 볼 사람이 없으면 직렬화도 하지 않는다
    const perChannel = PER_CHANNEL_TYPES.has(message.type) && message.channelId != null;
    // 아무도 이 채널을 보고 있지 않으면 직렬화도 생략한다(안 보이는 채널이 대부분인 128채널 구성에서 효과가 크다).
    if (perChannel && !this._anyoneWatching(message.channelId)) return;
    const payload = JSON.stringify(message);
    const droppable = DROPPABLE_TYPES.has(message.type);
    for (const client of this.wss.clients) {
      if (client.readyState !== 1 /* OPEN */) continue;
      if (perChannel && client.subs && !client.subs.has(message.channelId)) continue;
      if (droppable && client.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.droppedFrames++;
        continue;
      }
      client.send(payload);
    }
  }

  _send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  /** 서버 종료 시 — 열린 연결을 즉시 끊어야 http 서버의 close()가 기다리지 않고 끝난다. */
  close() {
    clearInterval(this.heartbeat);
    for (const client of this.wss.clients) {
      try { client.terminate(); } catch { /* 무시 */ }
    }
    this.wss.close();
  }
}
