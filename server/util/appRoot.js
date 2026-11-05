// 앱의 두 가지 기준 폴더를 계산한다.
//  - APP_ROOT  : 정적 파일(public/) 등 "읽기 전용" 자원의 기준 폴더 — 실행파일과 같은 위치
//  - DATA_ROOT : config.json/events.log/alarms/ 등 "쓰기 가능해야 하는" 사용자 데이터 폴더
//
// 개발 모드(`node server/index.js`, 순수 ESM)에서는 둘 다 프로젝트 루트 하위(데이터는 project/data/)다.
//
// 배포용 Windows 설치 패키지(Node SEA로 패키징된 aiwguard-vms.exe, esbuild가 CJS로 번들)에서는
// 설치 위치가 흔히 `C:\Program Files\...` 인데, 이 폴더는 관리자 권한 없이는 쓰기가 안 된다.
// 그래서 APP_ROOT(실행파일 옆, public/)는 그대로 두되, 쓰기가 필요한 DATA_ROOT는
// `%ProgramData%\AIWGuardVMS`(설치 스크립트가 일반 사용자도 쓸 수 있게 권한을 미리 설정해 둠)로 분리한다.
// 이 분리를 빼먹으면 Program Files에 설치했을 때 앱이 데이터 파일을 못 써서 시작하자마자 죽는다
// (2026-08-27 실제로 겪은 문제 — 절대 다시 합치지 말 것).
//
// 주의: 이 파일은 개발 모드에서는 순수 ESM으로 실행되지만, 배포 빌드에서는 esbuild가 CJS로
// 번들링한다. CJS 번들에서 `import.meta.url`을 참조하면 값이 비어(undefined) 즉시 오류가 나므로,
// `typeof require`로 두 환경을 구분해 CJS 번들에서는 그 코드 경로 자체를 타지 않게 한다.
// (SEA는 오직 CJS 번들 형태로만 배포되므로, `require`가 존재하지 않는 ESM 개발 모드에서는
// SEA로 실행 중일 수 없다 — 이 사실 덕분에 아래 분기만으로 충분하다.)
import path from 'node:path';

function isRunningAsSea() {
  if (typeof require === 'undefined') return false; // ESM 개발 모드 — SEA일 수 없음
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

/** 개발(ESM) 모드에서만 호출됨 — 프로젝트 루트 경로를 import.meta.url 기준으로 계산 */
function devRoot() {
  const url = import.meta.url;
  const filePath = new URL(url).pathname;
  const normalized = process.platform === 'win32' ? filePath.replace(/^\/([A-Za-z]:)/, '$1') : filePath;
  const __dirname = path.dirname(decodeURIComponent(normalized));
  return path.join(__dirname, '..', '..'); // server/util -> 프로젝트 루트
}

function getAppRoot() {
  if (isRunningAsSea()) return path.dirname(process.execPath);
  // CJS 번들(server.cjs)을 SEA 없이 그냥 `node`로 직접 실행하는 경우(빌드 검증용) — Node가
  // CJS 모듈에 기본 제공하는 __dirname을 그대로 쓴다(esbuild가 만든 번들 파일 위치 기준).
  if (typeof __dirname !== 'undefined') return path.join(__dirname, '..', '..');
  return devRoot(); // 순수 ESM 개발 모드
}

function getDataRoot(appRoot) {
  if (isRunningAsSea()) {
    // 설치 스크립트(installer/aiwguard-vms.iss)가 [Dirs]에서 이 폴더에 일반 사용자 쓰기 권한을 부여해 둔다.
    const base = process.env.PROGRAMDATA || appRoot;
    return path.join(base, 'AIWGuardVMS');
  }
  return path.join(appRoot, 'data'); // 개발 모드: 프로젝트 루트 하위 data/ (기존 동작 그대로)
}

export const APP_ROOT = getAppRoot();
export const DATA_ROOT = getDataRoot(APP_ROOT);
