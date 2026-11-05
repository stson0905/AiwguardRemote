// 추론 소스(Jetson Orin Nano 보드 / 윈도우 추론 PC 등)로부터 TCP로 추론 좌표를 수신하는 매니저.
// 두 가지 연결 방향을 모두 지원한다 (docs/PROTOCOL.md 참고):
//
//   mode 'client'  : VMS가 TCP 클라이언트로 소스(IP:Port)에 접속한다.  ← Jetson 보드 기본 방식
//   mode 'server'  : VMS가 포트를 열고 대기하고, 소스가 접속해서 밀어넣는다. ← 윈도우 추론 프로그램 대응
//                    한 리스너에 여러 대(여러 PC/여러 cam)가 동시에 접속해도 된다.
//
// 두 모드/두 플랫폼 모두 메시지 포맷(NDJSON)은 동일하므로 파서(LineFrameDecoder)는 그대로 공유한다.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { LineFrameDecoder } from './parser.js';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
/**
 * TCP keepalive 첫 probe까지의 유휴 시간. 보드 전원이 꺼지거나 케이블이 빠지면 FIN이 오지 않아
 * 소켓이 영원히 'connected'로 남는다(상태등은 초록인데 좌표는 안 오는 상태). OS가 probe로 상대가
 * 없어졌음을 알아채면 close가 발생해 재접속 로직이 돈다. 데이터가 계속 오는 동안에는 probe가 나가지 않는다.
 */
const KEEPALIVE_DELAY_MS = 15_000;

class BaseSourceHandle {
  constructor(manager, conn) {
    this.manager = manager;
    // 스냅샷 보관 — store.config는 in-place로 변경되므로 라이브 참조를 들고 있으면 항상 "자기 자신과 비교"가 되어 변경 감지가 깨진다.
    this.conn = { ...conn };
    this.status = 'disconnected'; // disconnected | connecting | connected | listening | error
    this.detail = null;
    this.backoff = MIN_BACKOFF_MS;
    this.timer = null;
    this.stopped = false;
  }

  /** 현재 이 소스에 붙어 있는 상대 수 (client 모드는 0 또는 1) */
  get peerCount() {
    return 0;
  }

  _setStatus(status, detail = null) {
    this.status = status;
    this.detail = detail;
    this.manager.emit('status', {
      connId: this.conn.id,
      status,
      detail,
      peers: this.peerCount
    });
  }

  /**
   * 소켓 하나에 대한 줄 단위 디코더 — 물 탐지 좌표는 detection, 유속 격자는 flow 이벤트로 나눠 올린다.
   * 유속 메시지가 detection으로 새면 폴리곤 0개인 탐지로 읽혀 침범률 0%(알람 해제)가 되므로 반드시 갈라 둔다.
   */
  _makeDecoder() {
    return new LineFrameDecoder((msg) => {
      this.manager.emit(msg.kind === 'flow' ? 'flow' : 'detection', { connId: this.conn.id, ...msg });
    });
  }

  _debugLog(peer, chunk) {
    if (!process.env.TCP_DEBUG) return;
    const text = chunk.toString('utf-8').slice(0, 300);
    console.log(`[tcp:${this.conn.id}${peer ? '/' + peer : ''}] recv ${chunk.length}B: ${JSON.stringify(text)}`);
  }

  _scheduleRetry(fn) {
    if (this.stopped) return;
    this.timer = setTimeout(fn, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }
}

/** mode 'client': VMS가 소스에 접속한다 (Jetson 보드가 TCP 서버인 경우). */
class OutboundSourceHandle extends BaseSourceHandle {
  constructor(manager, conn) {
    super(manager, conn);
    this.socket = null;
    this.decoder = this._makeDecoder();
  }

  get peerCount() {
    return this.status === 'connected' ? 1 : 0;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this._setStatus('disconnected');
  }

  _connect() {
    if (this.stopped) return;
    this._setStatus('connecting');
    const socket = net.createConnection({ host: this.conn.ip, port: this.conn.port });
    this.socket = socket;

    socket.on('connect', () => {
      this.backoff = MIN_BACKOFF_MS;
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      this._setStatus('connected');
    });
    socket.on('data', (chunk) => {
      this._debugLog(null, chunk);
      this.decoder.push(chunk);
    });
    socket.on('error', (err) => {
      this._setStatus('error', err.message);
    });
    socket.on('close', () => {
      if (this.status !== 'error') this._setStatus('disconnected');
      this.socket = null;
      if (!this.stopped && this.conn.autoReconnect !== false) {
        this._scheduleRetry(() => this._connect());
      }
    });
  }
}

/** mode 'server': VMS가 포트를 열고 소스(윈도우 추론 프로그램 등)의 접속을 기다린다. */
class InboundSourceHandle extends BaseSourceHandle {
  constructor(manager, conn) {
    super(manager, conn);
    this.server = null;
    this.sockets = new Set();
  }

  get peerCount() {
    return this.sockets.size;
  }

  start() {
    this.stopped = false;
    this._listen();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const socket of this.sockets) {
      socket.removeAllListeners();
      socket.destroy();
    }
    this.sockets.clear();
    if (this.server) {
      this.server.removeAllListeners();
      this.server.close(() => {});
      this.server = null;
    }
    this._setStatus('disconnected');
  }

  _listen() {
    if (this.stopped) return;
    const host = this.conn.ip && this.conn.ip.trim() ? this.conn.ip.trim() : '0.0.0.0';
    const server = net.createServer((socket) => this._onSocket(socket));
    this.server = server;

    server.on('error', (err) => {
      // 포트 충돌(EADDRINUSE) 등. 실패한 서버 객체는 재사용할 수 없으므로 버리고 새로 만든다.
      this._setStatus('error', err.message);
      server.removeAllListeners();
      try { server.close(() => {}); } catch { /* 이미 닫혀 있으면 무시 */ }
      if (this.server === server) this.server = null;
      this._scheduleRetry(() => this._listen());
    });

    server.listen(this.conn.port, host, () => {
      this.backoff = MIN_BACKOFF_MS;
      this._setStatus(this.sockets.size > 0 ? 'connected' : 'listening');
    });
  }

  _onSocket(socket) {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    const decoder = this._makeDecoder();
    this.sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
    console.log(`[tcp:${this.conn.id}] 추론 소스 접속됨: ${peer}`);
    this._setStatus('connected');

    socket.on('data', (chunk) => {
      this._debugLog(peer, chunk);
      decoder.push(chunk);
    });
    socket.on('error', () => { /* close에서 정리된다 */ });
    socket.on('close', () => {
      this.sockets.delete(socket);
      console.log(`[tcp:${this.conn.id}] 추론 소스 접속 종료: ${peer}`);
      if (!this.stopped) this._setStatus(this.sockets.size > 0 ? 'connected' : 'listening');
    });
  }
}

export class TcpSourceManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, BaseSourceHandle>} */
    this.handles = new Map();
  }

  /** config.tcpConnections 목록을 기준으로 소스를 (재)구성한다. 변경분만 반영. */
  reload(connections) {
    const list = Array.isArray(connections) ? connections : [];
    const nextIds = new Set(list.filter((c) => c.enabled !== false).map((c) => c.id));

    // 제거되었거나 비활성화된 소스 정리
    for (const [id, handle] of this.handles) {
      if (!nextIds.has(id)) {
        handle.stop();
        this.handles.delete(id);
      }
    }

    for (const conn of list) {
      if (conn.enabled === false) continue;
      const existing = this.handles.get(conn.id);
      if (existing) {
        // 모드/주소/포트가 바뀌면 소켓을 새로 열어야 한다 (라벨 등 나머지는 재접속 없이 반영).
        const changed =
          modeOf(existing.conn) !== modeOf(conn) ||
          existing.conn.ip !== conn.ip ||
          existing.conn.port !== conn.port;
        if (changed) {
          existing.stop();
          this.handles.delete(conn.id);
          this._create(conn);
        } else {
          existing.conn = { ...conn };
        }
      } else {
        this._create(conn);
      }
    }
  }

  _create(conn) {
    const handle = modeOf(conn) === 'server'
      ? new InboundSourceHandle(this, conn)
      : new OutboundSourceHandle(this, conn);
    this.handles.set(conn.id, handle);
    handle.start();
  }

  stopAll() {
    for (const handle of this.handles.values()) handle.stop();
    this.handles.clear();
  }

  /** { connId: status } — 프론트의 상태 표시등용 */
  getStatuses() {
    const out = {};
    for (const [id, handle] of this.handles) out[id] = handle.status;
    return out;
  }

  /** { connId: {status, detail, peers} } — 수신 대기(server) 모드의 접속 대수까지 포함 */
  getDetails() {
    const out = {};
    for (const [id, handle] of this.handles) {
      out[id] = { status: handle.status, detail: handle.detail, peers: handle.peerCount };
    }
    return out;
  }
}

function modeOf(conn) {
  return conn.mode === 'server' ? 'server' : 'client';
}

export const tcpSourceManager = new TcpSourceManager();
