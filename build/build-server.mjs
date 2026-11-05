// server/ 전체(+ node_modules 의존성)를 esbuild로 CJS 단일 파일로 번들한 뒤
// Node.js SEA(Single Executable Application) 기능으로 aiwguard-vms.exe 하나로 패키징한다.
// 결과물은 대상 PC에 Node.js가 설치되어 있지 않아도 그대로 실행된다.
//
// 사용법: node build/build-server.mjs
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'build', 'out');
const PUBLIC_SRC = path.join(ROOT, 'public');
const PUBLIC_DEST = path.join(OUT_DIR, 'public');
const BUNDLE_PATH = path.join(OUT_DIR, 'server.cjs');
const BLOB_PATH = path.join(OUT_DIR, 'sea-prep.blob');
const EXE_PATH = path.join(OUT_DIR, 'aiwguard-vms.exe');
const SEA_CONFIG_PATH = path.join(ROOT, 'build', 'sea-config.json');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const PKG_PATH = path.join(ROOT, 'package.json');
// 개발자 모드 비밀번호는 저장소 루트의 pwd.dat에서 읽는다(server/util/devPassword.js와 짝).
const PWD_FILE_PATH = path.join(ROOT, 'pwd.dat');
const DEFAULT_DEV_PASSWORD = 'admin1357!!';

/**
 * pwd.dat의 비밀번호를 읽어 SHA-256 해시로 만든다. 이 해시만 exe에 심고, pwd.dat 파일 자체는
 * 설치 패키지에 넣지 않는다(installer/aiwguard-vms.iss의 [Files]는 파일을 명시적으로만 나열한다).
 * 그래서 배포본에는 평문 비밀번호가 어디에도 남지 않는다.
 */
function resolveDevPassword() {
  let pw = null;
  if (fs.existsSync(PWD_FILE_PATH)) {
    // 메모장 등이 붙이는 UTF-8 BOM을 제거해야 비밀번호가 어긋나지 않는다.
    pw = fs.readFileSync(PWD_FILE_PATH, 'utf-8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim() || null;
  }
  if (!pw) {
    // 파일이 없거나 비어 있으면 기본 비밀번호로 새로 만들어 둔다 — 다음 빌드부터는 이 파일이 기준이 된다.
    pw = DEFAULT_DEV_PASSWORD;
    fs.writeFileSync(PWD_FILE_PATH, `${pw}\n`, 'utf-8');
    console.log(`      pwd.dat가 없어 기본 비밀번호로 새로 만들었습니다: ${PWD_FILE_PATH}`);
  }
  return pw;
}

/**
 * 배포 산출물에 평문 비밀번호가 섞여 들어가지 않았는지 확인한다.
 * server/ 어딘가에 평문 상수를 두면 번들을 통해 exe에 그대로 실려 나가는데(0.2.0 빌드 중 실제로
 * 발생), 이건 눈으로는 안 보이므로 빌드가 직접 막는다. 걸리면 빌드를 실패시킨다.
 */
function assertNoPlaintextPassword(password) {
  const needle = Buffer.from(password, 'utf-8');
  for (const file of [BUNDLE_PATH, EXE_PATH]) {
    if (!fs.existsSync(file)) continue;
    if (fs.readFileSync(file).includes(needle)) {
      throw new Error(
        `${file} 안에 개발자 모드 비밀번호가 평문으로 들어 있습니다.\n` +
        '       server/ 코드 어딘가에 비밀번호 문자열이 상수로 박혀 있다는 뜻입니다 ' +
        '(server/util/devPassword.js는 해시만 가져야 합니다).\n' +
        '       그대로 배포하면 exe를 문자열 검색하는 것만으로 비밀번호가 드러납니다.'
      );
    }
  }
  console.log('      배포 산출물에 평문 비밀번호 없음 확인 (해시만 포함)');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const version = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8')).version;
  const devPassword = resolveDevPassword();
  const devPasswordHash = crypto.createHash('sha256').update(devPassword, 'utf-8').digest('hex');
  // 비밀번호가 실제로 반영됐는지 확인할 수 있도록 출처와 해시 앞부분만 찍는다(평문은 절대 찍지 않는다).
  console.log(`[0/5] 버전 ${version} / 개발자 모드 비밀번호: pwd.dat 적용됨 (sha256 ${devPasswordHash.slice(0, 12)}...)`);

  console.log('[1/5] esbuild로 server/ 전체를 단일 CJS 파일로 번들...');
  await build({
    entryPoints: [path.join(ROOT, 'server', 'index.js')],
    outfile: BUNDLE_PATH,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // 배포본에는 package.json도 pwd.dat도 없으므로, 버전과 비밀번호 해시는 여기서 코드에 박아 넣는다.
    // (server/util/appInfo.js, server/util/devPassword.js가 typeof로 이 값들의 존재를 확인한다)
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __DEV_PASSWORD_SHA256__: JSON.stringify(devPasswordHash)
    },
    // node: 접두사 내장 모듈(node:fs 등)은 esbuild가 자동으로 external 처리한다.
    logLevel: 'info'
  });

  console.log('[2/5] Node SEA blob 생성...');
  for (const f of [BLOB_PATH, EXE_PATH]) {
    if (!fs.existsSync(f)) continue;
    try {
      fs.rmSync(f);
    } catch (err) {
      // 실행 중인 exe는 Windows가 잠그기 때문에 지울 수 없다. 여기서 멈추지 않으면
      // 옛날 exe가 그대로 남아 설치 패키지에 들어가 버린다(실제로 겪은 문제).
      throw new Error(
        `${f} 를 지울 수 없습니다 — 이 파일이 실행 중이거나 다른 프로그램이 잡고 있습니다.\n` +
        '       실행 중인 aiwguard-vms.exe를 먼저 종료한 뒤 다시 빌드하세요 ' +
        '(작업 관리자 또는 taskkill /IM aiwguard-vms.exe /F).\n' +
        `       원본 오류: ${err.message}`
      );
    }
  }
  execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG_PATH], {
    cwd: ROOT,
    stdio: 'inherit'
  });

  console.log('[3/5] node.exe 복사...');
  fs.copyFileSync(process.execPath, EXE_PATH);

  console.log('[4/5] postject로 blob 주입...');
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
      EXE_PATH,
      'NODE_SEA_BLOB',
      BLOB_PATH,
      '--sentinel-fuse',
      SENTINEL_FUSE,
      '--overwrite'
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );

  // exe는 자기 옆의 public/ 폴더에서 웹 UI 정적 파일을 읽는다(server/util/appRoot.js의 APP_ROOT).
  // 이걸 같이 안 두면 서버는 정상 기동하는데 브라우저에서 화면만 404로 안 뜬다 — 실제로 겪은 문제.
  // 설치 패키지는 저장소의 public/을 따로 담지만, 빌드한 exe를 그 자리에서 바로 실행할 수 있도록 여기서도 복사한다.
  console.log('[5/5] 웹 UI(public/)를 exe 옆으로 복사...');
  fs.rmSync(PUBLIC_DEST, { recursive: true, force: true });
  fs.cpSync(PUBLIC_SRC, PUBLIC_DEST, { recursive: true });

  assertNoPlaintextPassword(devPassword);

  console.log(`\n완료: ${EXE_PATH}`);
  console.log(`      (웹 UI: ${PUBLIC_DEST} — exe와 같은 폴더에 함께 있어야 화면이 뜹니다)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
