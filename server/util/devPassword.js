// 개발자 모드(설정 화면의 자세한 설명 팁 표시) 잠금 해제용 비밀번호 확인.
//
// 비밀번호는 저장소 루트의 `pwd.dat`에 평문 한 줄로 둔다. 빌드(build/build-server.mjs)가 그 값을
// 읽어 SHA-256 해시를 exe 안에 심고, pwd.dat 자체는 설치 패키지에 넣지 않는다.
//
// **이 파일에는 평문 비밀번호를 절대 두지 말 것.**
// 이 파일은 통째로 exe에 번들되므로 평문 상수를 두면 배포본을 문자열 검색하는 것만으로 비밀번호가
// 그대로 드러난다(0.2.0 빌드에서 실제로 그렇게 만들었다가 산출물 검사에서 잡았다).
// 평문을 아는 곳은 pwd.dat와 빌드 스크립트뿐이고, 배포본에는 해시만 들어간다.
//
// 확인은 반드시 서버에서 한다. 브라우저에는 해시조차 내려보내지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './appRoot.js';

export const PWD_FILE_PATH = path.join(APP_ROOT, 'pwd.dat');

/** 기본 비밀번호의 SHA-256 — pwd.dat도 빌드 해시도 없을 때의 최후 기본값 (평문은 README 참고). */
const DEFAULT_DEV_PASSWORD_SHA256 = '316dd924a354fc5dc4fc91f07585a0bf7c1dcffd1475d97f89d9f163a5838a66';

// 빌드 시 esbuild가 이 식별자를 실제 해시 문자열로 치환한다(build-server.mjs의 define).
// 개발 모드(순수 ESM)에서는 치환되지 않으며, 선언되지 않은 식별자라도 typeof는 예외를 던지지 않는다.
const BUILD_HASH = typeof __DEV_PASSWORD_SHA256__ !== 'undefined' ? __DEV_PASSWORD_SHA256__ : null;

// pwd.dat를 만드는 일은 빌드 스크립트가 맡는다(평문을 아는 쪽이 거기뿐이므로).
// 파일이 없어도 위 기본 해시로 정상 동작하므로, 여기서는 그 사실만 한 번 알려준다.
if (!BUILD_HASH && !fs.existsSync(PWD_FILE_PATH)) {
  console.log(`[dev-mode] ${PWD_FILE_PATH} 가 없어 기본 비밀번호를 사용합니다 (npm run build:server 시 자동 생성됩니다).`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf-8').digest('hex');
}

/** pwd.dat의 첫 줄(앞뒤 공백 제거)이 비밀번호. 없거나 비어 있으면 null. */
function readPasswordFile() {
  try {
    const raw = fs.readFileSync(PWD_FILE_PATH, 'utf-8');
    // 메모장 등이 붙이는 UTF-8 BOM을 제거해야 비밀번호가 어긋나지 않는다.
    return raw.replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * 지금 유효한 비밀번호 해시.
 * 우선순위: pwd.dat(있으면) > 빌드 시 심은 해시 > 기본 비밀번호 해시.
 * 매 요청마다 파일을 읽으므로 서버를 재시작하지 않고도 비밀번호를 바꿀 수 있고,
 * 배포본 옆에 pwd.dat를 두면 재빌드 없이 비밀번호를 교체할 수 있다.
 */
function currentHash() {
  const filePw = readPasswordFile();
  if (filePw) return sha256(filePw);
  return BUILD_HASH || DEFAULT_DEV_PASSWORD_SHA256;
}

/** 입력한 비밀번호가 맞는지 확인한다. 길이가 같은 해시끼리 상수 시간 비교. */
export function verifyDevPassword(password) {
  if (typeof password !== 'string' || password === '') return false;
  const a = Buffer.from(sha256(password), 'hex');
  const b = Buffer.from(currentHash(), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 진단용 — 비밀번호가 어디서 왔는지(평문은 절대 노출하지 않는다). */
export function devPasswordSource() {
  if (readPasswordFile()) return `pwd.dat (${PWD_FILE_PATH})`;
  if (BUILD_HASH) return '빌드 시 내장된 해시';
  return '기본값';
}
