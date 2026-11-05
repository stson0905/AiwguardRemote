; AIWGuard VMS Windows 설치 마법사 (Inno Setup)
; 빌드 방법: build\build-all.ps1 을 실행하면 서버 exe 빌드 -> 이 스크립트 컴파일까지 한 번에 처리됩니다.
; 수동 컴파일: "ISCC.exe installer\aiwguard-vms.iss" (build\out\aiwguard-vms.exe가 먼저 만들어져 있어야 함)

#define MyAppName "AIWGuard VMS"
#define MyAppVersion "0.5.2"
#define MyAppPublisher "AIWGuard"
#define MyAppExeName "aiwguard-vms.exe"
#define RepoRoot ".."

[Setup]
; 업그레이드 인식을 위한 고정 GUID (버전이 바뀌어도 절대 변경하지 말 것)
AppId={{9C6C9C7E-9C6B-4E9A-8A2C-6C7B7B9B9F1A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\AIWGuardVMS
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir={#RepoRoot}\build\out
OutputBaseFilename=AIWGuardVMS-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "autostart"; Description: "Windows 시작 시 VMS 서버 && MediaMTX 자동 실행"; GroupDescription: "자동 시작"; Flags: unchecked
Name: "firewall"; Description: "Windows 방화벽에서 VMS 웹(8080)/추론 수신(7100)/MediaMTX(9997,8889,8888) 포트 허용"; GroupDescription: "네트워크"; Flags: unchecked
Name: "desktopicon"; Description: "바탕화면 아이콘 만들기"; GroupDescription: "바로가기"; Flags: unchecked

[Dirs]
; {app}(보통 C:\Program Files\...)는 관리자 권한 없이는 쓰기가 안 되므로, 설정/이벤트로그 등
; 앱이 실행 중 계속 써야 하는 데이터는 여기 별도 폴더에 저장한다(server/util/appRoot.js와 짝을 이룸).
; 일반(비관리자) 사용자도 실행 시 문제없이 쓸 수 있도록 Users 그룹에 수정 권한을 미리 부여해 둔다.
Name: "{commonappdata}\AIWGuardVMS"; Permissions: users-modify

[Files]
; 주의: 저장소 루트의 pwd.dat(개발자 모드 비밀번호 평문)는 여기에 절대 추가하지 말 것.
; 빌드(build/build-server.mjs)가 그 값을 SHA-256 해시로 만들어 exe 안에 심으므로 배포본에는
; 평문이 들어갈 필요가 없다. 아래 목록은 파일을 하나씩 명시하므로 pwd.dat는 자동으로 제외된다.
;
; --- 서버 본체 (Node.js 없이 단독 실행되는 SEA exe) ---
Source: "{#RepoRoot}\build\out\aiwguard-vms.exe"; DestDir: "{app}"; Flags: ignoreversion

; --- 프론트엔드 정적 파일 ---
Source: "{#RepoRoot}\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- MediaMTX (RTSP -> WebRTC 변환) ---
Source: "{#RepoRoot}\build\vendor\mediamtx\mediamtx.exe"; DestDir: "{app}\mediamtx"; Flags: ignoreversion
Source: "{#RepoRoot}\build\vendor\mediamtx\LICENSE-MediaMTX.txt"; DestDir: "{app}\mediamtx"; Flags: ignoreversion
; mediamtx.yml은 사용자가 직접 손댈 수 있는 설정 파일이라, 이미 있으면(=업그레이드 재설치) 덮어쓰지 않는다.
Source: "{#RepoRoot}\build\vendor\mediamtx\mediamtx.yml"; DestDir: "{app}\mediamtx"; Flags: onlyifdoesntexist

; --- 문서 ---
Source: "{#RepoRoot}\docs\PROTOCOL.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "{#RepoRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion

; --- 실행/제어용 배치 스크립트 ---
Source: "launch-vms.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "launch-mediamtx.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "launch-all.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "launch-minimized.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName} 서버 시작"; Filename: "{app}\launch-vms.bat"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\MediaMTX 시작 (RTSP 영상 변환)"; Filename: "{app}\launch-mediamtx.bat"; WorkingDir: "{app}\mediamtx"
Name: "{group}\{#MyAppName} 웹 화면 열기"; Filename: "http://localhost:8080"
Name: "{group}\제거"; Filename: "{uninstallexe}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\launch-all.bat"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
; Windows 시작 시 자동 실행 — 시작프로그램 폴더에 바로가기 생성 (콘솔 창이 열림). 설치가 admin 권한으로
; 진행되므로 특정 사용자가 아닌 모든 사용자 공용 폴더(common)를 사용한다.
Name: "{commonstartup}\{#MyAppName} 자동시작"; Filename: "{app}\launch-all.bat"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: autostart

[Run]
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""AIWGuard VMS Web"" dir=in action=allow protocol=TCP localport=8080"; Flags: runhidden; Tasks: firewall
; 윈도우 추론 프로그램 등 외부 소스가 VMS로 좌표를 밀어넣는(수신 대기 모드) 기본 포트
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""AIWGuard Detection Inbound"" dir=in action=allow protocol=TCP localport=7100"; Flags: runhidden; Tasks: firewall
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""AIWGuard MediaMTX API"" dir=in action=allow protocol=TCP localport=9997"; Flags: runhidden; Tasks: firewall
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""AIWGuard MediaMTX WHEP"" dir=in action=allow protocol=TCP localport=8889"; Flags: runhidden; Tasks: firewall
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""AIWGuard MediaMTX HLS"" dir=in action=allow protocol=TCP localport=8888"; Flags: runhidden; Tasks: firewall
Filename: "{app}\launch-all.bat"; Description: "설치 후 바로 시작"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""AIWGuard VMS Web"""; Flags: runhidden; RunOnceId: "DelFwWeb"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""AIWGuard Detection Inbound"""; Flags: runhidden; RunOnceId: "DelFwDetect"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""AIWGuard MediaMTX API"""; Flags: runhidden; RunOnceId: "DelFwApi"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""AIWGuard MediaMTX WHEP"""; Flags: runhidden; RunOnceId: "DelFwWhep"
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""AIWGuard MediaMTX HLS"""; Flags: runhidden; RunOnceId: "DelFwHls"

[UninstallDelete]
; {commonappdata}\AIWGuardVMS (설정/이벤트로그/업로드 알람음)는 사용자 자산이므로 여기 넣지 않는다 —
; Inno이 [Dirs]로 만든 폴더는 제거 시 비어있을 때만 삭제를 시도하므로, 안에 데이터 파일이 남아있는 한
; 자동으로는 지워지지 않는다(의도된 동작).
Type: filesandordirs; Name: "{app}\public"




