// 추론 좌표 NDJSON 파서 (docs/PROTOCOL.md 참고)
// 두 종류의 추론 소스를 모두 이해한다 — 공통점은 "카메라 번호 + 0~1로 정규화된 water/road 폴리곤"이다.
// (연결 방향은 소스마다 다를 수 있음 — server/tcp/tcpSourceManager.js 참고)
//
// 1) Jetson Orin Nano (2026-08-27 실측):
// {"type":"detect","cam":1,"title":"경기하천1","ts_ms":1787807110485,"frame_idx":31915,
//  "frame":{"w":1578,"h":884},"area_roi":{"poly":[[x,y],...],"warning_pct":50}|null,
//  "water":[[[x,y],...],...],"road":[[[x,y],...],...]}
//
// 2) 윈도우 AI W-Guard (DATA 모드, 2026-09-04 실측):
// {"type":"detection","channel":1,"title":"T1","ts_ms":1788509208762,"frame":28975,
//  "width":1578,"height":884,"state":"ok","water_levels":[...],"flood_area":{...}|null,
//  "warning":false,"water":[[[x,y],...],...],"road":[[[x,y],...],...]}
//   - 카메라 번호 필드명이 cam이 아니라 channel
//   - frame이 크기 객체가 아니라 프레임 "번호"이고, 해상도는 width/height로 따로 옴
//   - 접속 직후 {"type":"hello",...} 인사 메시지를 한 번 보냄 (카메라 번호가 없으므로 그냥 무시된다)
//   - water/road 폴리곤은 DATA_SEND_POLYGONS=true 일 때만 실려 온다
//   - water_levels/flood_area(이미 계산된 비율%)는 그 프로그램 자체 ROI 기준이라 VMS는 쓰지 않는다
//     (VMS는 항상 화면에서 그린 자기 ROI와 water 폴리곤으로 침범률을 계산한다)
//
// 3) 유속 서비스 (flow_service/, 2026-09-21~):
// {"type":"flow","camera":3,"title":"T3","ts_ms":...,"frame":464,"width":1280,"height":720,"state":"ok",
//  "fps":15,"window_ms":3000,"pairs":9,"grid":[16,9],"cells":[[vx,vy,fb,r],...]}
//   - 카메라 번호 필드가 일부러 channel/cam 이 아니라 camera 다. 예전 VMS는 channel/cam 이 있으면 무조건
//     물 탐지 좌표로 읽어서, 폴리곤 0개 = 침범률 0%(알람 해제)로 오인할 수 있기 때문이다.
//   - 결과는 kind:'flow' 로 따로 올라가며 침수 판정(roiEngine)에는 절대 들어가지 않는다(tcpSourceManager 참고).
import { StringDecoder } from 'node:string_decoder';

/** 개행 없이 이만큼 쌓이면 비정상 송신으로 보고 버린다 (정상 프레임은 커야 수십 KB). */
const MAX_PENDING_CHARS = 1_000_000;
/**
 * 좌표 소수 자릿수. 소스는 double 전체 자릿수(예 0.123456789012345)를 보내는데, 정규화 좌표 0.0001은
 * 4K 가로 해상도에서도 0.4px 미만이라 판정(ROI를 32x32/64밴드로 표본화)에는 아무 영향이 없다.
 * 반면 브라우저로 중계하는 프레임 JSON 크기는 절반 가까이 줄어든다(폴리곤 점마다 문자열이 실리므로).
 */
const COORD_SCALE = 10_000;

/**
 * @param {string} line
 * @returns {{kind:'detection', cam:string, title:string, ts:number, frameIdx:number, frame:{w:number,h:number}|null,
 *            areaRoi:{poly:number[][], warningPct:number}|null, objects:Array<{cls:string, polygon:number[][]}>}
 *          |{kind:'flow', cam:string, grid:{cols:number,rows:number}, cells:Array<Array<number|null>>}|null}
 */
export function parseLine(line) {
  // 윈도우 쪽 송신기가 스트림 맨 앞에 UTF-8 BOM을 붙여 보내는 경우가 있어 제거한다
  // (붙어 있으면 JSON.parse가 실패해 첫 프레임이 통째로 버려짐).
  const trimmed = line.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;

  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'flow') return parseFlow(raw);
  // 카메라 번호: Jetson은 cam, 윈도우 AI W-Guard는 channel.
  // 둘 다 없는 줄(hello 등 제어 메시지)은 좌표가 아니므로 조용히 버린다.
  const cam = raw.cam ?? raw.channel;
  if (cam === undefined || cam === null) return null;

  const objects = [];
  for (const poly of normalizePolygonList(raw.water)) objects.push({ cls: 'water', polygon: poly });
  for (const poly of normalizePolygonList(raw.road)) objects.push({ cls: 'road', polygon: poly });

  return {
    kind: 'detection',
    cam: String(cam),
    title: typeof raw.title === 'string' ? raw.title : null,
    ts: Number.isFinite(raw.ts_ms) ? raw.ts_ms : Date.now(),
    frameIdx: normalizeFrameIndex(raw),
    frame: normalizeFrameSize(raw),
    areaRoi: normalizeAreaRoi(raw.area_roi),
    objects
  };
}

const MAX_FLOW_GRID = 64;

/**
 * 유속 서비스의 격자 결과. 칸(cell) = [vx, vy, fb, r] — vx/vy는 정규화 좌표/초(프레임 가로·세로 대비 초당 이동량),
 * fb는 forward-backward 일관성(0~1), r은 프레임 간격을 2배로 늘렸을 때의 속도비(실제 흐름이면 1 근처).
 * 값이 없는 칸(움직임이 너무 작음 등)은 null. 칸 수가 격자와 안 맞는 줄은 통째로 버린다(해석을 추측하지 않는다).
 */
function parseFlow(raw) {
  const cam = raw.camera;
  if (cam === undefined || cam === null) return null;
  const cols = Math.trunc(Number(raw.grid?.[0]));
  const rows = Math.trunc(Number(raw.grid?.[1]));
  if (!(cols >= 1 && cols <= MAX_FLOW_GRID && rows >= 1 && rows <= MAX_FLOW_GRID)) return null;
  const list = Array.isArray(raw.cells) ? raw.cells : [];
  if (list.length !== 0 && list.length !== cols * rows) return null;
  const cells = list.map((c) => (Array.isArray(c)
    ? [finiteOr(c[0]), finiteOr(c[1]), finiteOr(c[2]), finiteOr(c[3])]
    : [null, null, null, null]));
  return {
    kind: 'flow',
    cam: String(cam),
    title: typeof raw.title === 'string' ? raw.title : null,
    ts: Number.isFinite(raw.ts_ms) ? raw.ts_ms : Date.now(),
    frameIdx: Number.isFinite(raw.frame) ? raw.frame : null,
    frame: normalizeFrameSize(raw),
    state: typeof raw.state === 'string' ? raw.state : null,
    fps: Number.isFinite(raw.fps) ? raw.fps : null,
    windowMs: Number.isFinite(raw.window_ms) ? raw.window_ms : null,
    pairs: Number.isFinite(raw.pairs) ? raw.pairs : 0,
    grid: { cols, rows },
    cells
  };
}

function finiteOr(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 프레임 순번: Jetson은 frame_idx, 윈도우는 frame(숫자) */
function normalizeFrameIndex(raw) {
  if (Number.isFinite(raw.frame_idx)) return raw.frame_idx;
  if (Number.isFinite(raw.frame)) return raw.frame;
  return null;
}

/** 원본 해상도(참고용): Jetson은 frame:{w,h}, 윈도우는 width/height */
function normalizeFrameSize(raw) {
  if (raw.frame && Number.isFinite(raw.frame.w) && Number.isFinite(raw.frame.h)) {
    return { w: raw.frame.w, h: raw.frame.h };
  }
  if (Number.isFinite(raw.width) && Number.isFinite(raw.height)) {
    return { w: raw.width, h: raw.height };
  }
  return null;
}

function normalizePolygonList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const poly of list) {
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const pts = poly
      .map((p) => (Array.isArray(p) && p.length === 2 ? [clamp01(Number(p[0])), clamp01(Number(p[1]))] : null))
      .filter(Boolean);
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}

function normalizeAreaRoi(areaRoi) {
  if (!areaRoi || !Array.isArray(areaRoi.poly) || areaRoi.poly.length < 3) return null;
  const poly = normalizePolygonList([areaRoi.poly])[0];
  if (!poly) return null;
  return { poly, warningPct: Number.isFinite(areaRoi.warning_pct) ? areaRoi.warning_pct : null };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  const v = Math.min(1, Math.max(0, n));
  return Math.round(v * COORD_SCALE) / COORD_SCALE;
}

/**
 * 소켓에서 들어오는 바이트 스트림을 줄 단위로 잘라 파싱하는 누적 버퍼.
 * TCP는 메시지 경계를 보장하지 않으므로 개행이 나올 때까지 버퍼링한다.
 *
 * - StringDecoder를 쓰는 이유: 한글 title 같은 멀티바이트 문자가 TCP 세그먼트 경계에서 반으로 잘려 오면
 *   `chunk.toString()`은 그 자리를 U+FFFD로 깨뜨린다. StringDecoder는 잘린 바이트를 다음 chunk와 이어 붙인다.
 * - 한 chunk 안의 여러 줄은 한 번에 처리하고 남은 꼬리만 한 번 잘라낸다(줄마다 문자열을 새로 만들지 않는다).
 * - 콜백(onMessage)에서 난 예외는 여기서 막는다. 소켓 'data' 핸들러까지 올라가면 uncaughtException이 되어
 *   프레임 하나 때문에 서버 전체가 죽는다.
 */
export class LineFrameDecoder {
  constructor(onMessage) {
    this.decoder = new StringDecoder('utf-8');
    this.buffer = '';
    this.onMessage = onMessage;
    this._lastErrorAt = 0;
  }

  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    let start = 0;
    let idx;
    while ((idx = this.buffer.indexOf('\n', start)) >= 0) {
      this._handleLine(this.buffer.slice(start, idx));
      start = idx + 1;
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    // 개행 없이 무한정 쌓이는 것을 방지 (비정상 송신 대비)
    if (this.buffer.length > MAX_PENDING_CHARS) {
      this.buffer = '';
    }
  }

  _handleLine(line) {
    const parsed = parseLine(line);
    if (!parsed) return;
    try {
      this.onMessage(parsed);
    } catch (err) {
      // 같은 오류가 프레임마다 반복되면 로그가 넘치므로 5초에 한 번만 찍는다.
      const now = Date.now();
      if (now - this._lastErrorAt > 5000) {
        this._lastErrorAt = now;
        console.error('[tcp] 프레임 처리 중 오류 (해당 프레임은 건너뜀):', err?.stack || err);
      }
    }
  }
}
