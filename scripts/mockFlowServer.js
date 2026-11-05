// 유속 서비스(flow_service/)를 흉내내는 모의 TCP 서버 — "정답 유속을 아는" 가상 카메라로 m/s 환산과 유속 알람을 검증한다.
//
// 가상 카메라: 수면 위 5m, 화면 중앙이 수평 아래 25°, 화각 가로 70° / 세로 42°. 수면은 카메라 앞쪽(+Y, 멀어지는 방향)으로
// 흐르고, 속도는 0.5 → 2.5 → 0.5 m/s 를 PERIOD 초마다 반복한다(삼각파). 칸마다 실제 수면 속도를 원근 투영해
// 화면 속도(정규화 좌표/초)로 바꿔 보낸다 — VMS 가 올바른 보정으로 환산하면 이 정답 속도가 그대로 나와야 한다.
// 메시지에 들어 있는 debug_true_mps 는 검증용(VMS 는 모르는 필드라 무시한다).
//
// 사용법: node scripts/mockFlowServer.js [port=7200] [camera=3] [period초=60]
//   시작하면 보정에 쓸 기준점(화면 위치 + 실제 좌표)을 출력한다. VMS 타일의 "유속보정"에서 그 값을 넣거나
//   PUT /api/channels/:id/flow-calibration 에 그대로 보내면 된다.

import net from 'node:net';

const port = Number(process.argv[2]) || 7200;
const camera = Number(process.argv[3]) || 3;
const PERIOD = Number(process.argv[4]) || 60;
const COLS = 16, ROWS = 9;

const Hc = 5, tilt = 25 * Math.PI / 180;
const fx = 0.5 / Math.tan(35 * Math.PI / 180), fy = 0.5 / Math.tan(21 * Math.PI / 180);
const F = [0, Math.cos(tilt), -Math.sin(tilt)], U = [0, Math.sin(tilt), Math.cos(tilt)], R = [1, 0, 0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 수면(Z=0) 위 점 → 정규화 영상 좌표 */
function project([X, Y]) {
  const p = [X, Y, -Hc];
  const z = dot(F, p);
  return [0.5 + fx * dot(R, p) / z, 0.5 - fy * dot(U, p) / z];
}
/** 정규화 영상 좌표 → 수면 위 점 (시선이 수면과 만나지 않으면 null = 지평선 위) */
function unproject([x, y]) {
  const cx = (x - 0.5) / fx, cy = -(y - 0.5) / fy;
  const dir = [R[0] * cx + U[0] * cy + F[0], R[1] * cx + U[1] * cy + F[1], R[2] * cx + U[2] * cy + F[2]];
  if (dir[2] >= -1e-6) return null;
  const t = Hc / -dir[2];
  return [dir[0] * t, dir[1] * t];
}

function trueSpeed(tSec) {
  const ph = (tSec % PERIOD) / PERIOD;
  const tri = ph < 0.5 ? ph * 2 : 2 - ph * 2;
  return 0.5 + 2.0 * tri;
}

function makeCells(speed) {
  const dirV = [0.15, 1]; // 약간 비스듬히 멀어지는 방향
  const n = Math.hypot(...dirV);
  const V = [dirV[0] / n * speed, dirV[1] / n * speed];
  const cells = [];
  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      const P = unproject([(j + 0.5) / COLS, (i + 0.5) / ROWS]);
      if (!P || P[1] > 80) { cells.push([null, null, null, null]); continue; }
      const dt = 1e-3;
      const a = project([P[0] - V[0] * dt / 2, P[1] - V[1] * dt / 2]);
      const b = project([P[0] + V[0] * dt / 2, P[1] + V[1] * dt / 2]);
      cells.push([round((b[0] - a[0]) / dt, 6), round((b[1] - a[1]) / dt, 6), 0.97, 0.95]);
    }
  }
  return cells;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// 보정용 기준점: 수면 위 실제 좌표(가까운 쪽 폭 8m, 25m 앞까지) + 가상 카메라에서의 화면 위치
const GCP_WORLD = [[-4, 6], [4, 6], [5, 25], [-5, 25], [0, 12]];
const gcps = GCP_WORLD.map((w) => {
  const [ix, iy] = project(w);
  return { ix: round(ix, 5), iy: round(iy, 5), X: w[0], Y: w[1] };
});

const t0 = Date.now();
let frame = 0;
const hello = JSON.stringify({
  type: 'hello', service: 'AI W-Guard Flow (mock)', version: 'mock', publish_interval_ms: 1000,
  grid: [COLS, ROWS], fps: 15, window_ms: 3000, unit: 'normalized/s', cell_fields: ['vx', 'vy', 'fb', 'r'],
  cameras: [{ camera, title: `T${camera}` }]
}) + '\n';

const server = net.createServer((socket) => {
  console.log(`[mockFlow] 클라이언트 접속: ${socket.remoteAddress}:${socket.remotePort}`);
  socket.write(hello);
  const timer = setInterval(() => {
    const speed = trueSpeed((Date.now() - t0) / 1000);
    frame += 15;
    socket.write(JSON.stringify({
      type: 'flow', camera, title: `T${camera}`, ts: new Date().toISOString(), ts_ms: Date.now(),
      frame, width: 1280, height: 720, state: 'ok', fps: 15, window_ms: 3000, pairs: 9,
      grid: [COLS, ROWS], cells: makeCells(speed), debug_true_mps: round(speed, 3)
    }) + '\n');
  }, 1000);
  socket.on('close', () => { clearInterval(timer); console.log('[mockFlow] 접속 종료'); });
  socket.on('error', () => clearInterval(timer));
});

server.listen(port, () => {
  console.log(`[mockFlow] 모의 유속 서비스 대기 중: 0.0.0.0:${port} (camera ${camera}, 속도 0.5~2.5m/s, 주기 ${PERIOD}초)`);
  console.log(`[mockFlow] t0=${t0} (정답 유속 = 0.5 + 2.0 x 삼각파((ts_ms - t0)/1000 / ${PERIOD}))`);
  console.log('[mockFlow] 보정 기준점 (좌표 방식, PUT /api/channels/:id/flow-calibration 본문):');
  console.log(JSON.stringify({ method: 'coords', points: gcps }));
});
