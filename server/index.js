// crashGuard는 반드시 첫 번째 import — 아래 모듈들이 로드 중에 던지는 오류까지 잡아서
// 콘솔 창이 그냥 닫혀버리는 대신 원인이 보이도록 한다.
import { fatalExit, markStarted } from './util/crashGuard.js';

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

import { APP_ROOT } from './util/appRoot.js';
import { getLanIp } from './util/network.js';
import { store } from './config/store.js';
import { tcpSourceManager } from './tcp/tcpSourceManager.js';
import { camObserver } from './tcp/camObserver.js';
import { RoiEngine } from './roi/roiEngine.js';
import { FlowEngine } from './roi/flowEngine.js';
import { eventLog } from './events/eventLog.js';
import { WsHub } from './ws/wsHub.js';
import { createApiRouter } from './routes/api.js';
import { syncAllChannels } from './media/mediamtxClient.js';

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json({ limit: '2mb' }));

// 웹 UI 정적 파일은 실행파일(또는 프로젝트 루트) 옆의 public/ 에서 읽는다.
// 이게 없으면 서버는 멀쩡히 뜨는데 브라우저에서 화면만 404가 되어 원인을 찾기 어려우므로,
// 기동 시 한 번 확인해서 콘솔과 브라우저 양쪽에 무엇이 잘못됐는지 분명히 알려준다.
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const hasWebUi = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
app.use(express.static(PUBLIC_DIR));
app.use('/alarm-assets', express.static(store.alarmsDir()));

const server = http.createServer(app);
const roiEngine = new RoiEngine(store);
const flowEngine = new FlowEngine(store, roiEngine); // 유속(m/s) ROI 알람은 roiEngine의 같은 상태머신으로 판정

const wsHub = new WsHub(server, {
  store,
  tcpSourceManager,
  mediamtxCfgGetter: () => store.get().mediamtx,
  // 접속 시점에 이미 진행 중인(아직 확인 안 된) 알람을 새 브라우저에도 그대로 띄우기 위해 넘긴다.
  activeAlarmsGetter: () => roiEngine.getActiveAlarms(),
  // 확인 여부와 무관하게 지금 경보 상태인 채널×ROI — 화면 밖 채널의 경보를 페이지 지도에 표시하는 데 쓴다.
  alarmingGetter: () => roiEngine.getAlarmingRois()
});

app.use('/api', createApiRouter({ store, tcpSourceManager, roiEngine, eventLog, camObserver, wsHub }));
// API 오류는 화면이 읽을 수 있는 JSON으로 돌려준다(잘못된 JSON 본문 400, 업로드 크기 초과 413, 그 외 500).
// 이 미들웨어가 없으면 라우터 안에서 새는 오류가 요청을 매달아 두거나 HTML 스택트레이스로 돌아간다.
app.use('/api', (err, req, res, next) => {
  const status = err?.status || err?.statusCode || (err?.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl} 처리 실패:`, err?.stack || err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: status >= 500 ? '서버 내부 오류: ' + (err?.message || err) : (err?.message || '잘못된 요청') });
});

// public/이 없을 때만 동작하는 안내 페이지 (있으면 위의 express.static이 먼저 index.html을 내보낸다)
if (!hasWebUi) {
  app.get('/', (req, res) => {
    res.status(500).type('html').send(`<!doctype html><html lang="ko"><meta charset="utf-8">
<title>AIWGuard VMS — 웹 UI 파일 없음</title>
<body style="font-family:system-ui;background:#0d1117;color:#d8e0ea;padding:32px;line-height:1.7">
<h2>웹 UI 파일(public/)을 찾을 수 없습니다</h2>
<p>서버는 정상적으로 실행 중이지만, 화면을 그릴 정적 파일이 실행파일 옆에 없습니다.</p>
<p>찾은 경로: <code style="color:#ffb020">${PUBLIC_DIR}</code></p>
<p>해결: 이 폴더에 저장소의 <code>public/</code> 폴더를 통째로 복사하거나, 설치 마법사로 설치한
<code>aiwguard-vms.exe</code>를 실행하세요. (<code>npm run build:server</code>는 빌드 시 public/을 자동으로 함께 복사합니다.)</p>
</body></html>`);
  });
}

// ---- 이벤트 파이프라인 배선 ----
tcpSourceManager.on('detection', (msg) => {
  // 채널에 매핑되지 않은 cam 번호도 여기서는 기록해 둔다 — roiEngine은 그런 좌표를 조용히 버리므로,
  // 설정 화면에서 "실제로 들어오는 번호"를 보여주려면 매칭 전에 관찰해야 한다.
  camObserver.record(msg);
  roiEngine.handleDetection(msg);
});
// 유속 격자(flow_service/)는 침수 판정과 완전히 다른 경로로 흐른다 — roiEngine에는 절대 넘기지 않는다.
tcpSourceManager.on('flow', (msg) => {
  camObserver.record(msg);
  flowEngine.handle(msg);
});
tcpSourceManager.on('status', (evt) => wsHub.broadcast({ type: 'tcp_status', ...evt }));

roiEngine.on('frame', ({ objects, ...frame }) => {
  // 탐지 폴리곤(objects)은 프레임 메시지에서 가장 큰 부분인데(폴리곤 정점 수백 개), 화면은 "탐지 오버레이 표시"를
  // 켰을 때만 그린다. 꺼져 있으면(기본값) 개수만 보내 브라우저마다 초당 수십 KB~수백 KB의 중계 트래픽과
  // JSON 직렬화/파싱을 없앤다. 침범률 계산은 이미 서버에서 끝났으므로 판정에는 영향이 없다.
  const showOverlay = !!store.get().detectionSettings?.showOverlay;
  wsHub.broadcast({
    type: 'frame',
    ...frame,
    objectCount: objects.length,
    ...(showOverlay ? { objects } : {})
  });
});
flowEngine.on('flow', ({ cells, ...flow }) => {
  // 격자 칸(16x9 x 4값, 약 4KB)은 화면에 화살표를 그릴 때만 필요하다. 꺼져 있으면 ROI 결과만 보낸다.
  const showVectors = store.get().flowSettings?.showVectors !== false;
  wsHub.broadcast({ type: 'flow', ...flow, ...(showVectors ? { cells } : {}) });
});
roiEngine.on('alarm', (evt) => {
  const record = eventLog.add(evt);
  // 나중에 접속/새로고침한 화면에서도 이 알람이 다시 뜨도록 id가 붙은 레코드를 기억시킨다.
  roiEngine.rememberActiveAlarm(record);
  wsHub.broadcast({ type: 'alarm', event: record });
  const measured = evt.mode === 'height'
    ? `수위 ${evt.levelM}m >= ${evt.thresholdM}m (침범률 ${evt.ratePct}%)`
    : evt.mode === 'velocity'
      ? `유속 ${evt.speedMps}m/s >= ${evt.thresholdMps}m/s`
      : `${evt.ratePct}% >= ${evt.threshold}%`;
  console.log(`[ALARM] ${evt.channelTitle} / ${evt.roiName} / ${measured} -> "${evt.label}"`);
});
roiEngine.on('alarm_clear', (evt) => wsHub.broadcast({ type: 'alarm_clear', ...evt }));

store.on('change', (cfg) => {
  tcpSourceManager.reload(cfg.tcpConnections);
  wsHub.broadcast({ type: 'config_updated', config: cfg });
});

// ---- 기동 ----
tcpSourceManager.reload(store.get().tcpConnections);
syncAllChannels(store.get().mediamtx, store.get().channels).catch(() => {});

// 포트가 이미 쓰이고 있으면(대개 VMS가 이미 실행 중) 여기서 잡지 않으면 프로세스가 스택트레이스만
// 남기고 즉사한다 — 콘솔 창은 그와 동시에 닫혀서 사용자에겐 "실행하자마자 종료"로만 보인다.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fatalExit(`웹 화면 포트 ${PORT}이(가) 이미 사용 중이라 서버를 시작할 수 없습니다.`, [
      'AIWGuard VMS가 이미 실행 중일 수 있습니다 — 작업 관리자에서 aiwguard-vms.exe 를 확인하세요.',
      `이미 실행 중이라면 브라우저에서 http://localhost:${PORT} 로 접속하면 됩니다.`,
      '다른 프로그램이 이 포트를 쓰고 있다면, PORT 환경변수로 다른 포트를 지정해 실행할 수 있습니다 (예: set PORT=8081).'
    ], err.message);
    return;
  }
  if (err.code === 'EACCES') {
    fatalExit(`웹 화면 포트 ${PORT}을(를) 열 권한이 없습니다.`, [
      '1024 미만 포트이거나 보안 정책으로 막혀 있을 수 있습니다. PORT 환경변수로 다른 포트를 지정해 보세요.'
    ], err.message);
    return;
  }
  fatalExit('웹 서버를 시작하지 못했습니다.', [], err.stack || err.message);
});

server.listen(PORT, () => {
  // 여기까지 왔으면 기동은 성공 — 이후의 런타임 예외는 crashGuard가 종료 대신 로그로 처리한다.
  markStarted();
  const lanIp = getLanIp();
  const urls = [`http://localhost:${PORT}`];
  if (lanIp) urls.push(`http://${lanIp}:${PORT}`);
  console.log(`AIWGuard VMS 서버가 실행 중입니다: ${urls.join(', ')}`);
  if (!hasWebUi) {
    console.error('');
    console.error('  [경고] 웹 UI 파일이 없어 브라우저에 화면이 뜨지 않습니다.');
    console.error(`         찾은 경로: ${path.join(PUBLIC_DIR, 'index.html')}`);
    console.error('         이 실행파일과 같은 폴더에 public/ 폴더가 함께 있어야 합니다.');
    console.error('');
  }

  // 추론 소스는 두 방향 모두 지원한다 — VMS가 접속(client) / VMS가 포트를 열고 대기(server)
  const conns = store.get().tcpConnections.filter((c) => c.enabled !== false);
  const outbound = conns.filter((c) => c.mode !== 'server').map((c) => `${c.ip}:${c.port}`);
  const inbound = conns.filter((c) => c.mode === 'server').map((c) => `${c.ip}:${c.port}`);
  console.log(`추론 좌표 접속 대상(VMS→소스): ${outbound.join(', ') || '(없음)'}`);
  console.log(`추론 좌표 수신 대기(소스→VMS): ${inbound.join(', ') || '(없음)'}`);
});

// ---- 종료 ----
// server.close()는 열린 연결(브라우저 WebSocket, keep-alive HTTP)이 모두 끝나야 콜백을 부른다. 관제 화면은
// 항상 붙어 있으므로 그냥 기다리면 Ctrl+C를 눌러도 프로세스가 안 끝난다 — 연결을 직접 끊고, 그래도 안 끝나면
// 잠시 뒤 강제 종료한다.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} 수신 — 서버를 종료합니다.`);
  tcpSourceManager.stopAll();
  wsHub.close();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
