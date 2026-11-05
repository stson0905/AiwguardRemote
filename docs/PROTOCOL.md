# 추론 소스 → VMS TCP 좌표 프로토콜 (Jetson Orin Nano / 윈도우)

> 2026-08-27: 실제 보드(192.168.30.110:7070)에 접속해 확인한 **실제 포맷**으로 갱신함.
> 최초 설계 당시 가정했던 bbox 기반 NDJSON은 실제와 달라 폐기하고 아래 세그멘테이션 폴리곤 포맷으로 교체함.
> 2026-09-03: 윈도우용 추론 프로그램 지원을 위해 **연결 방향 두 가지를 모두 지원**하도록 확장함.
> 메시지 포맷은 Jetson/윈도우가 동일하므로 파서는 하나(`server/tcp/parser.js`)를 공유한다.

## 연결 방식 (두 방향 모두 지원)

설정 > **TCP 연결** 탭에서 소스마다 모드를 고릅니다. 두 모드를 동시에 여러 개 등록해도 됩니다
(예: Jetson 보드 2대는 접속 모드, 윈도우 추론 PC 3대는 하나의 수신 대기 포트로).

| 모드 | 의미 | 언제 쓰나 | 설정값 |
|---|---|---|---|
| `client` — 접속 (VMS→소스) | VMS가 TCP 클라이언트로 소스에 접속 | 소스가 TCP **서버**인 경우 (Jetson 보드 기본) | `ip`=소스 IP, `port`=소스 포트 (기본 192.168.30.110:7070) |
| `server` — 수신 대기 (소스→VMS) | VMS가 포트를 열고 소스의 접속을 기다림 | 소스가 TCP **클라이언트**인 경우 (윈도우 추론 프로그램) | `ip`=바인딩 주소(`0.0.0.0`=모든 NIC), `port`=열 포트 (기본 7100) |

- `client` 모드: 접속이 끊기면 지수 백오프(1s → 최대 30s)로 자동 재접속합니다.
- `server` 모드: **한 포트에 여러 대가 동시에 접속**할 수 있고, 각 접속은 독립적으로 파싱됩니다.
  포트 바인딩이 실패하면(다른 프로그램이 이미 그 포트를 쓰는 경우 등) 상태가 "오류"로 표시되고
  같은 백오프로 다시 시도합니다. 다른 PC에서 접속하려면 **윈도우 방화벽에서 해당 포트(기본 7100)를 열어야** 합니다
  (설치 마법사의 "방화벽 포트 허용" 항목에 포함되어 있음).
- 상태 표시: 접속 모드는 `연결됨/연결중/끊김/오류`, 수신 대기 모드는 `대기중(접속 없음)/수신중(N대)/오류`.

## 소스별 메시지 포맷 요약

두 소스 모두 **줄바꿈(`\n`)으로 구분된 JSON 한 줄 = 한 프레임**(NDJSON)이며, 공통적으로
**카메라 번호 + 0~1로 정규화된 `water`/`road` 폴리곤**을 보냅니다. 필드명만 아래처럼 다르고,
[server/tcp/parser.js](../server/tcp/parser.js)가 두 형태를 모두 받아들입니다.

| | Jetson Orin Nano | 윈도우 AI W-Guard (DATA 모드) |
|---|---|---|
| 연결 | 보드가 TCP 서버 (기본 192.168.30.110:7070) | 프로그램이 TCP 서버 (기본 **9100**, `config.cfg`의 `DATA_SERVER_PORT`) |
| VMS 설정 모드 | 접속 (VMS→소스) | 접속 (VMS→소스) |
| `type` | `"detect"` | `"detection"` (접속 직후 `"hello"` 한 줄 먼저 옴 — VMS는 무시) |
| 카메라 번호 | `cam` | `channel` |
| 프레임 순번 | `frame_idx` | `frame` |
| 해상도 | `frame:{w,h}` | `width`, `height` |
| 폴리곤 | `water`, `road` | `water`, `road` (**`DATA_SEND_POLYGONS = true`일 때만**) |
| 기타 | `area_roi`(보드 자체 ROI, 참고용) | `water_levels`, `flood_area`(프로그램 자체 ROI 기준 비율%), `warning`, `state` |

윈도우 프로그램의 `water_levels`/`flood_area`는 **그 프로그램 안에서 설정한 ROI** 기준으로 이미 계산된
비율이라 VMS는 사용하지 않습니다. VMS는 항상 웹 화면에서 그린 자기 ROI와 `water` 폴리곤으로 침범률을
계산합니다(두 소스의 동작이 완전히 같아짐).

> **윈도우 프로그램 쪽 필수 설정**: `AI W-Guard`의 `config.cfg`에 `SERVICE_MODE = DATA`,
> `DATA_SEND_POLYGONS = true`가 있어야 합니다. 폴리곤 전송은 2026-09-04에 추가된 기능이므로
> 그 이전 빌드에서는 좌표가 오지 않아 침범률이 항상 0%가 됩니다.

실제 수신 예(윈도우, 폴리곤 포함):

```json
{"type":"detection","channel":1,"title":"T1","ts":"2026-09-04T17:20:32.385","ts_ms":1788510032385,
 "frame":45,"width":1578,"height":884,"state":"ok","water_levels":[],"flood_area":null,"warning":false,
 "water":[[[0.2028,0.9038],[0.1977,0.8948],"..."]],"road":[]}
```

## 메시지 포맷 (Jetson 실측)

줄바꿈(`\n`)으로 구분된 JSON 한 줄 = 한 프레임의 탐지 결과 (NDJSON). 실제 수신 예:

```json
{
  "type": "detect",
  "cam": 1,
  "title": "경기하천1",
  "ts_ms": 1787807110485,
  "frame_idx": 31915,
  "frame": { "w": 1578, "h": 884 },
  "area_roi": { "poly": [[0.5057,0.1861],[0.437,0.5259],[0.6411,0.5194],[0.6536,0.1472]], "warning_pct": 50 },
  "avg_window_sec": 20,
  "alarm_interval_min": 1,
  "water": [[[0.1857,0.914],[0.1857,0.9253], "..."]],
  "road": [[[0.2438,0.8306],[0.2359,0.8194], "..."]]
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `cam` | number | 소스(보드/윈도우 프로그램)가 매기는 카메라 번호. **채널 관리 화면의 "cam ID"와 일치해야** 해당 채널로 매칭됨 (channel_id 문자열이 아님) |
| `title` | string | 보드 쪽 카메라 이름(참고용, VMS 채널 제목과 다를 수 있음) |
| `ts_ms` | number | epoch ms |
| `frame_idx` | number | 프레임 순번 |
| `frame.w/h` | number | 원본 프레임 픽셀 해상도(참고용 — 좌표 자체는 이미 정규화되어 있어 필수는 아님) |
| `water` | 폴리곤 배열의 배열 | **침수(물) 감지 세그멘테이션 폴리곤들.** 각 폴리곤은 `[x,y]` 정규화 좌표(0~1, 좌상단 기준) 점 목록. 폴리곤이 여러 개(블롭) 나올 수 있음 |
| `road` | 폴리곤 배열의 배열 | 도로 영역 세그멘테이션(참고용). VMS는 기본적으로 알람 계산에 사용하지 않음 |
| `area_roi` | `{poly, warning_pct}` \| `null` | **보드 자체가 갖고 있는 ROI/경고 임계값(참고용).** VMS는 이 값을 쓰지 않고, 웹 UI에서 그린 ROI/임계값을 그대로 사용함. 보드측 설정과 다를 수 있음을 유의 |

## ROI 판정 기준 (ROI마다 선택)

ROI에는 `thresholdMode`가 있고, 값에 따라 판정에 쓰는 값과 단위가 완전히 달라집니다.

| `thresholdMode` | 판정값 | 임계값 필드 | 히스테리시스 |
|---|---|---|---|
| `percent` (기본) | 침범률(%) — 아래 정의 | `threshold` (%) | `alarmSettings.hysteresisPct` |
| `height` | 물높이(m) — 교각 수위표 눈금 판독 | `thresholdM` (m) | `alarmSettings.hysteresisM` |

`height` 모드 ROI는 `heightScale: {bottomY, bottomM, topY, topM}`을 함께 갖습니다.
`bottomY/topY`는 사용자가 **실제로 보이는 눈금 위에 끌어다 놓은 기준선 두 개의 화면 세로 위치**(정규화 y),
`bottomM/topM`은 그 자리의 눈금값(m)입니다. 이 두 점이 화면 세로 위치 ↔ 미터를 잇는 기준자가 됩니다.
`bottomY/topY`가 `null`이면 ROI 폴리곤 bbox의 아래/위 경계를 기준선으로 봅니다(기준선 개념이 없던 설정 호환).

> ROI 경계가 아니라 임의 위치에 기준선을 두는 이유: ROI의 아래쪽은 대개 물에 잠겨 눈금이 보이지 않아
> 그 지점의 눈금값을 사람이 알 수 없고, 어림짐작하면 판독값이 실제 눈금과 어긋납니다.

**판독 방식**: ROI를 가로 띠(band) 64개로 나눠 각 띠가 water 폴리곤으로 얼마나 찼는지 세고,
**아래에서 위로** 훑어 물로 찬 구간이 끊기는 지점을 수면선으로 잡은 뒤,
`물높이 = bottomM + (하단 기준선에서 수면선까지의 높이 ÷ 두 기준선 간격) × (topM - bottomM)` 로 환산합니다
([server/roi/waterLevel.js](../server/roi/waterLevel.js)). 판독값은 `alarmSettings.levelSmoothSec`
초 동안의 **중앙값**으로 평활화됩니다(파도로 인한 알람 깜빡임 방지).

**채널 구독(브라우저 → 서버, v0.4.2)**: 브라우저는 화면에 띄운 채널이 바뀔 때마다
`{"type":"subscribe","channelIds":["1-yhbz", ...]}`를 보내고, 서버는 `frame`/`flow` 메시지를 **구독한 채널만** 그 브라우저에 보낸다
(아무 브라우저도 보고 있지 않은 채널은 직렬화도 하지 않음). 구독을 한 번도 안 보낸 클라이언트는 예전처럼 전부 받는다.
`alarm`/`alarm_clear`/`config_updated`/`tcp_status`는 구독과 상관없이 항상 전부 보낸다 — 침범률·유속 판정과 알람은
서버가 **모든 채널**에 대해 수행하므로 화면에 안 보이는 채널도 감지·알람은 그대로 동작한다.

프레임 브로드캐스트(`type:"frame"`, 서버 → 브라우저 WebSocket)의 상위 필드:

```jsonc
{"type":"frame",
 "channelId":"1-yhbz",
 "ts":1788509208790,       // 서버 도착 시각(ms). 쿨다운/재알림/평활화 등 모든 시간 판단은 이 시각 기준
 "sourceTs":1788509208762, // 소스가 보낸 ts_ms (진단용 — 보드 시계가 어긋나 있어도 판정에는 영향 없음)
 "objectCount":2,          // 이 프레임의 탐지 폴리곤 수
 "objects":[...],          // "탐지 오버레이 표시"(detectionSettings.showOverlay)가 켜져 있을 때만 실린다.
                           // 꺼져 있으면(기본) 필드 자체가 없다 — 폴리곤은 메시지에서 가장 큰 부분이라 전송량을 아낀다.
 "intrusions":[...]}       // ROI별 판정 결과 (아래)
```

`intrusions[]` 항목은 모드에 따라 이렇게 실립니다:

```jsonc
// percent 모드
{"roiId":"roi_x","roiName":"둔치","mode":"percent","ratePct":63.2}
// height 모드 (ratePct도 참고용으로 함께 옴)
{"roiId":"roi_y","roiName":"수위표","mode":"height","ratePct":20.3,
 "levelM":0.76,          // 판정에 쓰인 물높이(m, 평활화됨)
 "waterY":0.6373,        // 화면에 수면선을 그릴 정규화 y
 "waterYRaw":0.6390,     // 평활화 전 수면선 y (기준선 보정 화면이 저장 전 값으로 다시 환산할 때 씀)
 "thresholdM":0.7,
 "detected":true,        // ROI 안에서 물을 찾았는지
 "saturated":null}       // "below"=수면이 ROI 아래, "above"=ROI 위로 넘침 (그 바깥 수위는 알 수 없음)
```

알람 이벤트에는 `mode`와 함께 그 모드에서 실제로 쓰인 값만 채워집니다
(`percent`면 `ratePct`/`threshold`, `height`면 `levelM`/`thresholdM` — 안 쓰인 쪽은 `null`).

### 침범률(%) 정의 (세그멘테이션 기반)

`침범률(%) = ROI 폴리곤 면적 중 water 폴리곤(들)과 겹치는 면적 ÷ ROI 폴리곤 전체 면적 × 100`

즉 "ROI 영역이 얼마나 침수로 뒤덮였는가"를 의미합니다. ROI마다 임계값(%)을 설정하고, 침범률이
임계값 이상이 되면 알람이 발생합니다(히스테리시스/쿨다운 설정으로 반복 스팸 방지).
ROI의 "감지 클래스" 필터를 비워두면 기본적으로 `water` 폴리곤만 사용합니다(`road`는 참고용 표시만 됨).

침범률 계산은 항상 원본(water/road) 폴리곤 기준으로 이뤄지며 바뀌지 않습니다(정확도 우선). 설정 > 알람 설정
탭의 "탐지 오버레이 표시" 체크박스는 그 탐지 폴리곤을 화면에 그림으로 그려서 보여줄지 여부만 결정하는
순수 표시 옵션이며(기본값: 표시 안 함), 계산 결과에는 전혀 영향을 주지 않습니다.

## 채널 ↔ cam 매핑 (+ 소스 구분)

소스는 `channel_id` 같은 문자열이 아니라 정수 `cam` 번호로 카메라를 식별합니다. 따라서 VMS 채널 등록 시
**채널/RTSP 관리 화면에서 "cam ID"를 실제 소스의 `cam` 값과 동일하게 입력**해야 좌표가 해당 채널로
연결됩니다 (channel_id는 MediaMTX path 이름 등 내부 용도로만 쓰이는 별개의 값).

소스가 여러 개면 **cam 번호가 겹칠 수 있습니다**(Jetson도 `cam:1`, 윈도우 프로그램도 `cam:1`).
이때는 채널의 **"소스"** 열에서 해당 TCP 소스를 지정하면 그 소스에서 온 좌표만 그 채널로 들어갑니다
(`channels[].sourceId`). 비워두면(기본, "모든 소스") 어느 소스에서 오든 cam 번호만 맞으면 받습니다.
같은 cam 번호에 대해 **소스를 지정한 채널이 우선**하고, 없으면 "모든 소스" 채널이 받습니다.

TCP 소스에 **"번호 기준"**(`tcpConnections[].pairedSourceId`)을 지정하면, 그 소스가 보내는 번호를 지정한
소스의 번호로 보고 매칭합니다. 유속 서비스처럼 AI W-Guard와 같은 채널 번호를 보내는 보조 소스용입니다 —
채널의 "소스"가 AI W-Guard로 한정돼 있어도 같은 채널에 붙습니다. 한 단계만 따라가며, 체인(기준 소스가 또
다른 소스를 따름)은 API가 거부합니다. 규칙은 `server/roi/roiEngine.js`의 `findChannelForCam` +
`matchSourceIdOf` 한 곳에만 있습니다(침수 판정·유속·설정 화면 수신 현황이 공유).

## 유속 서비스 메시지 (`type: "flow"`, 2026-09-21~)

추론 서버에서 별도로 도는 유속 서비스(`flow_service/`, 기본 포트 7200)가 보냅니다. 침수 감지 엔진과 독립된
프로그램이며, VMS에서는 "접속" 모드 TCP 소스로 추가하고 **번호 기준을 AI W-Guard 소스로 지정**합니다.

```json
{"type":"hello","service":"AI W-Guard Flow","version":"1.0.0","publish_interval_ms":1000,
 "grid":[16,9],"fps":15,"window_ms":3000,"unit":"normalized/s","cell_fields":["vx","vy","fb","r"],
 "cameras":[{"camera":3,"title":"T3"},{"camera":4,"title":"T4"}]}

{"type":"flow","camera":4,"title":"T4","ts":"2026-09-21T15:54:20.103","ts_ms":1789975460103,
 "frame":448,"width":1280,"height":720,"state":"ok","fps":15,"window_ms":3000,"pairs":9,
 "grid":[16,9],"cells":[[0.00123,-0.03021,1.0,0.94], [null,null,null,null], ...]}
```

| 필드 | 설명 |
|---|---|
| `camera` | 카메라 번호. **일부러 `channel`/`cam`이 아닙니다** — 예전 VMS는 그 필드가 있으면 물 탐지 좌표로 읽어 폴리곤 0개(침범률 0%, 알람 해제)로 오인할 수 있어서, 예전 VMS가 모르는 이름을 씁니다(예전 VMS에서는 조용히 무시됨). |
| `state` | `ok`(최근 표본 있음) / `waiting`(프레임은 오는데 표본 없음) / `connecting` / `reconnecting` |
| `pairs` | 최근 `window_ms` 안에 모인 표본(프레임 쌍) 수. 칸 값은 이 표본들의 중앙값 |
| `cells` | 격자 `grid=[가로,세로]` 칸을 위→아래, 왼→오른쪽 순서로. 칸 = `[vx, vy, fb, r]`, 값이 없으면 `null` |
| `vx`, `vy` | 정규화 좌표/초 — 초당 이동량 ÷ 프레임 가로(세로). px/s = `vx*width`, `vy*height`. 화면 기준(오른쪽/아래가 +) |
| `fb` | forward-backward 일관성(0~1): 앞으로 구한 이동을 거꾸로 되돌렸을 때 1px 안에 돌아오는 픽셀 비율 |
| `r` | 간격 일관성: 프레임 간격을 2배로 늘렸을 때의 속도 ÷ 1배 속도. 실제 떠내려가는 무늬면 1 근처, 제자리 물결·맑은 물 바닥 무늬면 0.5 근처 |

VMS는 `flowSettings.fbMin`(기본 0.8) / `rMin`(기본 0.7) 이상인 칸만 "믿을 수 있는 칸"으로 보고, ROI 안(칸 중심 기준)
칸들의 중앙값으로 ROI 유속(px/s, 방향)을 냅니다(`server/roi/flowEngine.js`). 유속 메시지는 침수 판정 경로와 완전히
분리돼(`tcpSourceManager`가 `flow` 이벤트로 따로 올림) 침범률·물높이 알람에 영향을 주지 않습니다.
**px/s는 화면상 속도라 실제 m/s가 아닙니다** — 비스듬한 카메라는 같은 물살도 화면 위쪽(먼 곳)이 느려 보입니다
(실측: 같은 하천 근경 50px/s, 원경 11px/s).

**m/s 환산(v0.3.2~)**: 채널에 유속 보정(`channels[].flowCalib`)이 있으면 칸마다 화면 속도를 실제 수면 속도 벡터로 바꾼 뒤
ROI 안 성분별 중앙값의 크기를 `speedMps`로 냅니다. 보정은 수면 높이의 기준점 4~8개(화면 위치 ↔ 실제 X,Y m 또는 줄자 거리 6개)로
구한 호모그래피이며, 계산·검증은 `public/js/homography.js` 한 곳(서버 `PUT /api/channels/:id/flow-calibration`과 화면 미리보기가 공유)에
있습니다. 판정 기준이 유속(`thresholdMode:'velocity'`, `thresholdMps`)인 ROI는 이 값을 `alarmSettings.flowSmoothSec` 동안의
중앙값으로 평활해 침범률·물높이와 같은 알람 상태머신(쿨다운·`hysteresisMps`·확인·재알림)으로 판정합니다.
알람 이벤트에는 `mode:'velocity'`, `speedMps`, `thresholdMps`가 실립니다(CSV 끝 열에도 추가).

## 검증용 모의 송신기

실제 소스 없이 두 방향 모두 파이프라인을 검증할 수 있습니다.

```bash
# 1) Jetson 포맷 + 접속(VMS→소스) 모드 검증 — 보드처럼 TCP 서버로 대기
node scripts/mockJetsonServer.js 7070 1
#    VMS 설정 > TCP 연결에서 모드 "접속", 대상 127.0.0.1:7070

# 2) 윈도우 AI W-Guard 포맷 검증 — hello + detection(폴리곤 포함)을 그대로 흉내
node scripts/mockWinGuardServer.js 9100 4
#    VMS 설정 > TCP 연결에서 모드 "접속", 대상 127.0.0.1:9100

# 3) 수신 대기(소스→VMS) 모드 검증 — 소스가 VMS로 접속해 밀어넣는 경우
node scripts/mockWindowsClient.js 127.0.0.1 7100 1
#    VMS 설정 > TCP 연결에서 모드 "수신 대기", 포트 7100, 사용 체크

# 4) 유속 서비스 + m/s 보정 + 유속 알람 검증 — 정답 유속(0.5~2.5m/s 반복)을 아는 가상 카메라 결과를 보낸다
node scripts/mockFlowServer.js 7200 3 60
#    VMS 설정 > TCP 연결에서 모드 "접속", 대상 127.0.0.1:7200, 번호 기준 = cam 3 을 받는 소스
#    시작할 때 출력되는 기준점 JSON 을 PUT /api/channels/:id/flow-calibration 에 보내면(또는 타일 "유속보정"에 입력)
#    ROI 유속이 정답 유속과 같게 나와야 한다(2026-09-21 검증: 최대 오차 0.05%)
```

채널의 "cam ID"를 `1`로 지정하고 그 채널에 ROI를 그리면, 원을 그리며 움직이는 가짜 water 폴리곤이
전송되어 ROI 침범률/알람 팝업/사운드를 바로 확인할 수 있습니다.
