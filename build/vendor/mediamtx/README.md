# MediaMTX 바이너리 (설치 패키지에 동봉됨)

`mediamtx.exe`는 용량이 커서(약 55MB) 저장소에 커밋하지 않습니다(.gitignore 대상). 설치 패키지를
빌드하려면 이 폴더에 `mediamtx.exe`를 직접 받아 넣어야 합니다.

## 받는 방법

1. https://github.com/bluenviron/mediamtx/releases 에서 최신(또는 검증된) Windows amd64 버전
   (`mediamtx_v*_windows_amd64.zip`)을 받습니다. 이 프로젝트는 **v1.19.3**로 빌드/검증했습니다.
2. 압축을 풀어 나온 `mediamtx.exe`를 이 폴더(`build/vendor/mediamtx/`)에 넣습니다.
3. `mediamtx.yml`, `LICENSE-MediaMTX.txt`는 이미 이 폴더에 있으므로 그대로 두면 됩니다.

이후 `npm run build:installer` (또는 `powershell -File build/build-all.ps1`)를 실행하면
`build/out/AIWGuardVMS-Setup-<version>.exe` 설치 패키지가 만들어집니다.

## 라이선스

MediaMTX는 MIT 라이선스 오픈소스이며, 이 폴더의 `LICENSE-MediaMTX.txt`에 원문을 동봉해 함께 배포합니다.
