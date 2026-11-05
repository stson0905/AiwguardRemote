// 치명적 오류를 사람이 읽을 수 있게 만들어 주는 안전망.
//
// 배포판(aiwguard-vms.exe)은 콘솔 창으로 실행되기 때문에, 프로세스가 죽는 순간 창도 같이 닫혀버려서
// 사용자 눈에는 "실행하면 바로 종료됨"으로만 보이고 원인은 전혀 안 보인다(포트 충돌, 데이터 폴더
// 쓰기 권한 없음 등이 실제로 이렇게 나타났음). 그래서 여기서 오류를 한 번에 받아 원인과 해결 방법을
// 찍고, 콘솔(TTY)이면 키를 누를 때까지 창을 붙잡아 둔다.
//
// 이 모듈은 **server/index.js의 첫 번째 import**여야 한다 — ESM도 esbuild CJS 번들도 import 순서대로
// 평가되므로, 그래야 store.js 등 다른 모듈이 로드되는 도중에 던지는 예외까지 잡을 수 있다.

const HOLD_TIMEOUT_MS = 120_000; // 콘솔을 붙잡아 두는 최대 시간 (자동 실행 환경에서 영원히 안 죽도록)
/** 같은 런타임 오류가 반복될 때(프레임마다 등) 콘솔이 넘치지 않도록 하는 최소 출력 간격 */
const RUNTIME_LOG_INTERVAL_MS = 5_000;

/**
 * 기동이 끝났는지. server/index.js가 listen 성공 직후 markStarted()로 켠다.
 *
 * 기동 전 오류(포트 충돌, 데이터 폴더 권한 등)는 서버가 쓸모없는 상태이므로 원인을 보여주고 종료한다.
 * 반면 기동 후 런타임에 새는 예외(프레임 하나의 처리 오류, 타이머 콜백의 예외 등)로 관제 서버 전체가
 * 죽어버리면 누가 알아채고 다시 켜 줄 때까지 감시가 통째로 멈춘다 — 그쪽이 훨씬 큰 사고다.
 * 그래서 기동 후에는 오류를 눈에 띄게 찍되 프로세스는 계속 돌린다. (재접속/재시도 로직이 상태를 회복한다.)
 */
let started = false;
let lastRuntimeLogAt = 0;
let suppressedRuntimeErrors = 0;

export function markStarted() {
  started = true;
}

function logRuntimeError(kind, err) {
  const now = Date.now();
  if (now - lastRuntimeLogAt < RUNTIME_LOG_INTERVAL_MS) {
    suppressedRuntimeErrors += 1;
    return;
  }
  lastRuntimeLogAt = now;
  console.error('');
  console.error(`  [런타임 오류] ${kind} — 서버는 계속 실행됩니다. 증상이 이어지면 프로그램을 다시 시작하세요.`);
  if (suppressedRuntimeErrors > 0) {
    console.error(`  (직전 ${RUNTIME_LOG_INTERVAL_MS / 1000}초 동안 같은 종류의 오류 ${suppressedRuntimeErrors}건 생략)`);
    suppressedRuntimeErrors = 0;
  }
  console.error(`  ${err?.stack || err}`);
  console.error('');
}

/** 오류 메시지를 눈에 띄게 출력한 뒤 (콘솔이면 키 입력을 기다렸다가) 종료한다. */
export function fatalExit(title, hints = [], detail = null) {
  console.error('');
  console.error('============================================================');
  console.error(`  [오류] ${title}`);
  if (detail) console.error(`  상세: ${detail}`);
  for (const hint of hints) console.error(`  - ${hint}`);
  console.error('============================================================');
  holdConsoleThenExit(1);
}

function holdConsoleThenExit(code) {
  // 배치/서비스로 실행되어 콘솔이 없으면(리다이렉트 포함) 기다릴 이유가 없다.
  if (!process.stdin.isTTY) {
    process.exit(code);
    return;
  }
  console.error('');
  console.error('  이 창은 내용을 읽을 수 있도록 열어 두었습니다. 아무 키나 누르면 닫힙니다.');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { process.stdin.setRawMode(false); } catch { /* 이미 닫혔으면 무시 */ }
    process.exit(code);
  };
  try { process.stdin.setRawMode(true); } catch { /* raw 모드가 안 되면 엔터 입력으로 대체 */ }
  process.stdin.resume();
  process.stdin.once('data', finish);
  setTimeout(finish, HOLD_TIMEOUT_MS);
}

process.on('uncaughtException', (err) => {
  if (started) {
    logRuntimeError('처리되지 않은 예외', err);
    return;
  }
  const hints = [];
  const text = `${err?.code || ''} ${err?.message || err}`;
  if (/EACCES|EPERM|denied/i.test(text)) {
    hints.push('설정/로그 폴더에 쓸 권한이 없는 것 같습니다. 관리자 권한으로 실행하거나 설치 마법사로 다시 설치해 보세요.');
  }
  hints.push('이 메시지를 그대로 담당자에게 전달하면 원인 파악에 도움이 됩니다.');
  fatalExit('예기치 못한 오류로 서버를 시작하지 못했습니다.', hints, err?.stack || String(err));
});

process.on('unhandledRejection', (reason) => {
  if (started) {
    logRuntimeError('처리되지 않은 Promise 오류', reason);
    return;
  }
  fatalExit('처리되지 않은 오류가 발생했습니다.', [], reason?.stack || String(reason));
});
