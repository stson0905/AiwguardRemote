// 윈도우용 추론 프로그램을 흉내내는 모의 송신기 — VMS가 열어둔 포트로 접속해서 좌표를 밀어넣는다.
// (설정의 mode 'server' = "수신 대기 (소스→VMS)" 검증용. 반대 방향은 mockJetsonServer.js 참고)
// 메시지 포맷은 Jetson 보드와 동일한 NDJSON이다 (docs/PROTOCOL.md 참고).
//
// 사용법: node scripts/mockWindowsClient.js [host=127.0.0.1] [port=7100] [cam=1]

import net from 'node:net';
import { makeDetectionFrame } from './mockFrame.js';

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3]) || 7100;
const cam = process.argv[4] || '1';

let frameIdx = 0;
let timer = null;

function connect() {
  console.log(`[mockWindows] VMS로 접속 시도: ${host}:${port} (cam=${cam})`);
  const socket = net.createConnection({ host, port });

  socket.on('connect', () => {
    console.log('[mockWindows] 접속 성공 — 좌표 전송 시작');
    timer = setInterval(() => {
      socket.write(JSON.stringify(makeDetectionFrame(cam, frameIdx++, '윈도우모의채널')) + '\n');
    }, 400);
  });

  socket.on('error', (err) => console.log(`[mockWindows] 오류: ${err.message}`));
  socket.on('close', () => {
    if (timer) clearInterval(timer);
    timer = null;
    console.log('[mockWindows] 접속 종료 — 2초 후 재시도');
    setTimeout(connect, 2000);
  });
}

connect();
