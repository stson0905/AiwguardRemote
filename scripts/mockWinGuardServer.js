// 윈도우 추론 프로그램(AI W-Guard, SERVICE_MODE=DATA)을 흉내내는 모의 TCP 서버.
// 실제 프로그램과 동일하게 접속 직후 hello 한 줄을 보내고, 이후 채널별로 detection 줄을 주기 전송한다.
// (실제 프로그램은 TCP 서버이므로 VMS 설정에서 모드는 "접속 (VMS→소스)", 기본 포트는 9100)
//
// 메시지 형태(실측 기준, docs/PROTOCOL.md 참고):
//   {"type":"hello","service":"AI W-Guard","mode":"DATA","publish_interval_ms":1000,
//    "channels":[{"channel":1,"title":"T1"},...],"water_level_roi_count":1}
//   {"type":"detection","channel":1,"title":"T1","ts_ms":...,"frame":123,"width":1578,"height":884,
//    "state":"ok","water_levels":[],"flood_area":null,"warning":false,
//    "water":[[[x,y],...]],"road":[]}
//
// 사용법: node scripts/mockWinGuardServer.js [port=9100] [channels=4]

import net from 'node:net';
import { makeDetectionFrame } from './mockFrame.js';

const port = Number(process.argv[2]) || 9100;
const channelCount = Number(process.argv[3]) || 4;

const channels = Array.from({ length: channelCount }, (_, i) => ({ channel: i + 1, title: `T${i + 1}` }));
const helloLine = JSON.stringify({
  type: 'hello',
  service: 'AI W-Guard',
  mode: 'DATA',
  publish_interval_ms: 1000,
  channels,
  water_level_roi_count: 1
}) + '\n';

let frameIdx = 0;

const server = net.createServer((socket) => {
  console.log(`[mockWinGuard] 클라이언트 접속: ${socket.remoteAddress}:${socket.remotePort}`);
  socket.write(helloLine);

  const timer = setInterval(() => {
    for (const ch of channels) {
      // 폴리곤 자체는 Jetson 모의 송신기와 같은 생성기를 쓰고, 겉포장만 AI W-Guard 형식으로 바꾼다.
      const base = makeDetectionFrame(ch.channel, frameIdx, 'T');
      const msg = {
        type: 'detection',
        channel: ch.channel,
        title: ch.title,
        ts: new Date().toISOString(),
        ts_ms: Date.now(),
        frame: frameIdx,          // 윈도우 포맷에서 frame은 "프레임 번호"
        width: 1578,
        height: 884,
        state: 'ok',
        water_levels: [],
        flood_area: null,
        warning: false,
        water: base.water,        // 0~1 정규화 폴리곤 (수정된 프로그램이 보내는 것과 같은 형태)
        road: []
      };
      socket.write(JSON.stringify(msg) + '\n');
    }
    frameIdx++;
  }, 400);

  socket.on('close', () => { clearInterval(timer); console.log('[mockWinGuard] 접속 종료'); });
  socket.on('error', () => clearInterval(timer));
});

server.listen(port, () => {
  console.log(`[mockWinGuard] 모의 AI W-Guard DATA 서버 대기 중: 0.0.0.0:${port} (채널 1~${channelCount})`);
  console.log(`[mockWinGuard] VMS 설정 > TCP 연결에서 모드 "접속 (VMS→소스)", 대상 127.0.0.1:${port} 로 지정하세요.`);
  console.log('[mockWinGuard] 채널의 "cam ID"를 1~' + channelCount + ' 로 맞추고 ROI를 그리면 침범률이 계산됩니다.');
});
