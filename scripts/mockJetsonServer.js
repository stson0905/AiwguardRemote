// 실제 Jetson Orin Nano 보드 없이 ROI 침범/알람 파이프라인을 검증하기 위한 모의 TCP 서버.
// (보드가 TCP 서버이고 VMS가 접속하는 방향 — 설정의 mode 'client' 검증용)
// VMS 서버가 TCP 클라이언트로 이 서버(127.0.0.1:<port>)에 접속하도록 설정(tcp연결 설정)하면
// 원을 그리며 움직이는 가짜 "water" 침수 폴리곤을 주기적으로 전송해 ROI 침범률/알람을 재현한다.
// 메시지 포맷은 실제 보드에서 확인된 형식과 동일하다 (docs/PROTOCOL.md 참고).
//
// 반대 방향(윈도우 추론 프로그램이 VMS로 접속해 밀어넣는 mode 'server')은 mockWindowsClient.js 참고.
//
// 사용법: node scripts/mockJetsonServer.js [port=7070] [cam=1]

import net from 'node:net';
import { makeDetectionFrame } from './mockFrame.js';

const port = Number(process.argv[2]) || 7070;
const cam = process.argv[3] || '1';

const server = net.createServer((socket) => {
  console.log(`[mockJetson] VMS 서버 접속됨: ${socket.remoteAddress}:${socket.remotePort}`);
  let frameIdx = 0;

  const timer = setInterval(() => {
    socket.write(JSON.stringify(makeDetectionFrame(cam, frameIdx++)) + '\n');
  }, 400);

  socket.on('close', () => {
    clearInterval(timer);
    console.log('[mockJetson] 접속 종료');
  });
  socket.on('error', () => clearInterval(timer));
});

server.listen(port, () => {
  console.log(`[mockJetson] 모의 Jetson TCP 서버 대기 중: 0.0.0.0:${port} (cam=${cam})`);
  console.log('[mockJetson] VMS 설정 > TCP 연결에서 모드를 "접속 (VMS→소스)"로 두고 대상을 127.0.0.1:' + port + ' 로 지정하세요.');
  console.log(`[mockJetson] VMS 채널 설정에서 "cam ID"를 ${cam} 로 지정한 채널에 ROI를 그리면 확인 가능.`);
});
