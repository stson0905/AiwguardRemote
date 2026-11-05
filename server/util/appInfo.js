// 앱 버전 문자열. 설정 > Help 탭에 표시된다.
//
// 배포용 exe에는 package.json이 들어 있지 않으므로, 빌드 시 esbuild가 __APP_VERSION__을
// 실제 버전 문자열로 치환해 넣는다(build/build-server.mjs의 define).
// 개발 모드에서는 치환되지 않으므로 프로젝트 루트의 package.json을 그대로 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './appRoot.js';

const BUILD_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf-8')).version || null;
  } catch {
    return null;
  }
}

export const APP_VERSION = BUILD_VERSION || readPackageVersion() || '개발 빌드';
export const APP_NAME = 'AIWGuard VMS';
