// JSON 파일 기반 설정 저장소. 동시 쓰기 충돌을 피하기 위해 임시파일에 쓴 뒤 rename(원자적 교체)한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_ROOT } from '../util/appRoot.js';

const DATA_DIR = DATA_ROOT;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ALARMS_DIR = path.join(DATA_DIR, 'alarms');

export const MAX_CHANNELS = 128; // 화면 public/js/settingsPanel.js의 MAX_CHANNELS와 같은 값이어야 한다
/**
 * 화면에서 고를 수 있는 분할 수. 화면(public/css/style.css의 .grid-N)이 그릴 줄 아는 값과 반드시 같아야 한다.
 *   8 = 4x4 격자에서 0번 칸이 왼쪽 위 3x3을 차지하는 "큰 화면 1 + 작은 화면 7" (오른쪽 열 3 + 아래 줄 4)
 *  36 = 6열 x 6행 (16:9 모니터 1대 기준)
 * (v0.2.5에 있던 32분할(8x4)은 사용자 요청으로 v0.2.6에서 제거 — 저장돼 있던 32는 migrate가 36으로 바꾼다)
 * (9분할(3x3)은 사용자 요청으로 8분할로 교체 — 저장돼 있던 9는 migrate가 8로 바꾼다)
 */
export const LAYOUT_OPTIONS = [1, 4, 8, 16, 36];
const DEFAULT_LAYOUT = 16;
/** 없어진 분할을 "가장 비슷한 모양"으로 옮기는 표. 여기에 없으면 아래 규칙(그보다 크거나 같은 것 중 최소)을 따른다. */
const LEGACY_LAYOUTS = { 9: 8 };

/**
 * 지원하지 않는 분할 값을 지원하는 값으로 바꾼다. 없어진 분할(32 등)이 저장돼 있으면 화면이 그리드 모양을 몰라
 * 타일이 한 줄로 늘어서 버리므로, 로드할 때 반드시 보정해야 한다.
 * 보이던 칸이 안 보이게 되지 않도록 "그보다 크거나 같은 것 중 가장 작은 값"을 고른다(32 -> 36).
 */
export function normalizeLayout(layout) {
  const n = Number(layout);
  if (!Number.isFinite(n)) return DEFAULT_LAYOUT;
  if (LAYOUT_OPTIONS.includes(n)) return n;
  if (LEGACY_LAYOUTS[n]) return LEGACY_LAYOUTS[n];
  return LAYOUT_OPTIONS.find((o) => o >= n) ?? Math.max(...LAYOUT_OPTIONS);
}

/**
 * 관제 화면 배치 = 분할 수(layout) 하나 + 등록된 모든 채널의 표시 순서(order).
 * 화면 페이지는 따로 저장하지 않고 화면이 order를 layout개씩 잘라 만든다(12채널: 4분할 3쪽, 8분할 2쪽, 16/36분할 1쪽).
 * order는 항상 "지금 등록된 채널 전부, 중복 없이"여야 하므로 저장할 때마다(store.update) 이 함수로 맞춘다:
 * 없어진 채널은 빼고, 새로 등록된 채널은 채널 목록 순서대로 뒤에 붙인다.
 * (예전의 수동 화면 페이지 layoutPages는 사용자 요청으로 이 방식으로 교체 — migrate 참고)
 */
export function normalizeDisplay(display, channels) {
  const ids = channels.map((c) => c.channelId);
  const known = new Set(ids);
  const order = [];
  for (const id of Array.isArray(display?.order) ? display.order : []) {
    if (known.has(id) && !order.includes(id)) order.push(id);
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  // 사용자분할: custom이 켜져 있으면 화면은 8분할 모양으로 customOrder(사용자가 고른 채널, 고른 순서)만 보여준다.
  // order와 달리 "전부"일 필요가 없으므로 없어진 채널/중복만 걸러낸다. 꺼져 있어도 고른 목록은 보존한다.
  const customOrder = [];
  for (const id of Array.isArray(display?.customOrder) ? display.customOrder : []) {
    if (known.has(id) && !customOrder.includes(id)) customOrder.push(id);
  }
  return { layout: normalizeLayout(display?.layout), order, custom: display?.custom === true, customOrder };
}

/**
 * 추론 소스(TCP) 항목 정규화.
 * mode 'client' = VMS가 소스로 접속(Jetson 보드 기본), mode 'server' = VMS가 포트를 열고 소스의 접속을 대기
 * (윈도우 추론 프로그램처럼 소스가 클라이언트인 경우). mode가 없던 예전 설정은 'client'로 취급한다.
 * server 모드에서 ip는 "접속 대상"이 아니라 "바인딩할 주소"(0.0.0.0 = 모든 NIC)를 뜻한다.
 *
 * pairedSourceId(채널 번호 기준 소스): 이 소스가 보내는 카메라 번호를 "다른 소스의 번호 체계"로 해석하라는 뜻.
 * 유속 서비스처럼 AI W-Guard와 같은 번호(3, 4…)를 쓰는 보조 소스용이다 — 채널 표의 "소스"가 AI W-Guard로
 * 한정돼 있어도 같은 채널에 붙는다. null(기본)이면 자기 자신 기준(기존 동작).
 */
export function normalizeTcpConnection(conn) {
  const mode = conn.mode === 'server' ? 'server' : 'client';
  const paired = typeof conn.pairedSourceId === 'string' && conn.pairedSourceId && conn.pairedSourceId !== conn.id
    ? conn.pairedSourceId
    : null;
  return {
    ...conn,
    mode,
    ip: (conn.ip ?? '').toString().trim() || (mode === 'server' ? '0.0.0.0' : ''),
    port: Number(conn.port) || 0,
    label: conn.label || (mode === 'server' ? `수신대기 :${conn.port}` : `${conn.ip}:${conn.port}`),
    enabled: conn.enabled !== false,
    autoReconnect: conn.autoReconnect !== false,
    pairedSourceId: paired
  };
}

/**
 * ROI 항목 정규화.
 * thresholdMode = 'percent'(기본, ROI 면적 대비 침범률 %) | 'height'(교각 수위표 눈금 기준 물높이 m).
 * height 모드에서는 heightScale과 thresholdM(임계 수위)을 쓴다.
 *   heightScale.bottomY/bottomM = 하단(최하) 기준선의 화면 위치와 그 자리의 눈금값
 *   heightScale.topY/topM       = 상단 기준선의 화면 위치와 그 자리의 눈금값
 *   (Y가 null이면 ROI의 아래/위 경계를 기준선으로 본다 — 기준선 개념이 없던 예전 설정 호환)
 * 모드를 오가며 바꿔도 상대편 설정값은 지우지 않고 그대로 보존한다(되돌렸을 때 다시 입력하지 않도록).
 */
export function normalizeRoi(roi) {
  const scale = roi.heightScale || {};
  return {
    ...roi,
    // 'velocity' = 유속(m/s) — 유속 서비스 결과 + 채널의 유속 보정(channels[].flowCalib)으로 판정한다(v0.3.2~).
    thresholdMode: ['height', 'velocity'].includes(roi.thresholdMode) ? roi.thresholdMode : 'percent',
    heightScale: {
      topM: finiteOrNull(scale.topM),
      bottomM: finiteOrNull(scale.bottomM),
      topY: finiteOrNull(scale.topY),
      bottomY: finiteOrNull(scale.bottomY)
    },
    thresholdM: finiteOrNull(roi.thresholdM),
    thresholdMps: finiteOrNull(roi.thresholdMps)
  };
}

function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function defaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    channels: [],
    rois: [],
    tcpConnections: [
      {
        id: 'tcp_default',
        mode: 'client', // VMS가 보드로 접속
        ip: '192.168.30.110',
        port: 7070,
        label: 'Jetson Orin Nano #1',
        enabled: true,
        autoReconnect: true
      },
      {
        id: 'tcp_inbound_default',
        mode: 'server', // 윈도우 추론 프로그램 등이 VMS로 접속해 밀어넣는 경로
        ip: '0.0.0.0',
        port: 7100,
        label: '윈도우 추론 수신 대기',
        enabled: false, // 필요할 때 설정 > TCP 연결에서 "사용"을 켜면 포트가 열린다
        autoReconnect: true
      }
    ],
    alarmSettings: {
      sirenEnabled: true,
      ttsEnabled: true,
      volume: 0.8,
      cooldownSec: 10,
      hysteresisPct: 5,          // 침범률(%) 기준 ROI의 알람 해제 여유
      hysteresisM: 0.1,          // 물높이(m) 기준 ROI의 알람 해제 여유 (10cm — 파도로 인한 깜빡임 방지)
      levelSmoothSec: 10,        // 물높이 판독을 이 시간(초) 동안의 중앙값으로 평활화 (0=평활화 안 함)
      hysteresisMps: 0.1,        // 유속(m/s) 기준 ROI의 알람 해제 여유
      flowSmoothSec: 10,         // 유속 판독을 이 시간(초) 동안의 중앙값으로 평활화 (유속 서비스가 이미 3초 중앙값을 보냄)
      repeatIntervalSec: 30,     // 팝업 확인 전까지 사이렌/TTS를 반복하는 간격(초)
      repeatPopupMinutes: 5,     // 확인 여부와 무관하게 침수가 계속 감지되면 이 주기(분)로 팝업을 다시 띄움. 0=반복 안 함
      defaultLabel: '침수발생',
      customAudioAssetId: null
    },
    display: { layout: DEFAULT_LAYOUT, order: [], custom: false, customOrder: [] },
    // ROI 침범률 계산은 항상 정확도를 위해 원본(water/road) 폴리곤 기준으로 계산한다 (bbox 근사 아님).
    // showOverlay는 그 탐지 폴리곤을 화면에 그릴지 여부만 결정 — 계산 결과(침범률%)에는 영향 없음.
    detectionSettings: {
      showOverlay: false
    },
    // 유속 서비스(flow_service/)가 보내는 격자별 광류 결과를 쓰는 방식.
    //  showVectors : 타일에 유속 화살표(1초 동안 움직이는 거리)를 그릴지
    //  fbMin / rMin: 이 값 이상인 칸만 "믿을 수 있는 칸"으로 보고 ROI 유속 계산과 화살표에 쓴다.
    //    fb = 앞/뒤 광류 일관성(0~1), r = 프레임 간격을 2배로 늘렸을 때의 속도비(실제 흐름이면 1 근처,
    //    제자리 물결·바닥 무늬면 0.5 근처). 2026-09-21 실측 분포로 정한 값(fb>=0.8, r>=0.7).
    flowSettings: {
      showVectors: true,
      fbMin: 0.8,
      rMin: 0.7
    },
    mediamtx: {
      host: '127.0.0.1',
      apiPort: 9997,
      whepPort: 8889,
      hlsPort: 8888
    }
  };
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ALARMS_DIR, { recursive: true });
}

// 스키마 버전 (1회성 마이그레이션에 사용 — 사용자가 지운 항목이 재기동마다 되살아나는 것을 막는다)
//  1: 최초 / 2: TCP 소스 mode(client|server) + 채널 sourceId 도입
//  3: ROI 판정 기준 이원화 — thresholdMode(percent|height) + heightScale/thresholdM 도입
const SCHEMA_VERSION = 3;

function migrate(cfg) {
  // 이후 스키마 변경 시 여기서 이전 버전 config.json을 보정한다.
  const d = defaultConfig();
  const prevVersion = Number(cfg.schemaVersion) || 1;
  cfg.channels ??= d.channels;
  cfg.rois ??= d.rois;
  // 기존 ROI는 전부 침범률(%) 기준으로 취급된다 — 값이 없던 필드만 채우므로 동작이 바뀌지 않는다.
  cfg.rois = cfg.rois.map(normalizeRoi);
  cfg.tcpConnections ??= d.tcpConnections;
  cfg.tcpConnections = cfg.tcpConnections.map(normalizeTcpConnection);
  // 지워진 소스를 "채널 번호 기준"으로 가리키고 있으면 자기 기준으로 되돌린다.
  for (const conn of cfg.tcpConnections) {
    if (conn.pairedSourceId && !cfg.tcpConnections.some((c) => c.id === conn.pairedSourceId)) conn.pairedSourceId = null;
  }
  // 채널의 sourceId: 특정 TCP 소스에서 온 좌표만 받도록 제한하는 값. null = 모든 소스 허용(기존 동작).
  // 채널의 flowCalib: 유속 m/s 환산용 "화면 ↔ 수면" 보정(public/js/homography.js computeCalibration 결과). null = 보정 없음.
  for (const ch of cfg.channels) {
    ch.sourceId ??= null;
    ch.flowCalib ??= null;
  }
  if (prevVersion < 2 && !cfg.tcpConnections.some((c) => c.mode === 'server')) {
    // 윈도우 추론 프로그램용 수신 대기 항목을 1회만 추가(기본 비활성). 지우면 다시 생기지 않는다.
    const inbound = d.tcpConnections.find((c) => c.mode === 'server');
    if (inbound && !cfg.tcpConnections.some((c) => c.id === inbound.id)) cfg.tcpConnections.push(inbound);
  }
  cfg.schemaVersion = SCHEMA_VERSION;
  cfg.alarmSettings = { ...d.alarmSettings, ...(cfg.alarmSettings || {}) };
  if (!cfg.display && Array.isArray(cfg.layoutPages)) {
    // 수동 화면 페이지 → 자동 페이지: 첫 페이지의 분할 수를 쓰고, 페이지 순서대로 배정돼 있던 채널을 표시 순서의 앞에 둔다.
    // 보이던 칸(layout 이내)을 먼저, 안 보이게 남아 있던 배정을 그다음에 둬서 지금 보던 화면과 최대한 같게 시작한다.
    const pages = cfg.layoutPages;
    const visible = pages.flatMap((p) => (p.cells || []).slice(0, normalizeLayout(p.layout)));
    const hidden = pages.flatMap((p) => (p.cells || []).slice(normalizeLayout(p.layout)));
    cfg.display = { layout: pages[0]?.layout, order: [...visible, ...hidden].filter(Boolean) };
  }
  delete cfg.layoutPages;
  cfg.display = normalizeDisplay(cfg.display ?? d.display, cfg.channels);
  cfg.detectionSettings = { ...d.detectionSettings, ...(cfg.detectionSettings || {}) };
  cfg.flowSettings = { ...d.flowSettings, ...(cfg.flowSettings || {}) };
  cfg.mediamtx = { ...d.mediamtx, ...(cfg.mediamtx || {}) };
  return cfg;
}

class Store extends EventEmitter {
  constructor() {
    super();
    ensureDirs();
    this.config = this._load();
  }

  _load() {
    if (!fs.existsSync(CONFIG_PATH)) {
      const cfg = defaultConfig();
      this._writeSync(cfg);
      return cfg;
    }
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const cfg = migrate(JSON.parse(raw));
      // 마이그레이션 결과를 즉시 파일에도 반영한다. 안 그러면 다음 설정 저장 전까지 디스크는 옛 스키마로 남아
      // "1회만 수행" 마이그레이션(schemaVersion 기준)이 재기동마다 반복된다.
      this._writeSync(cfg);
      return cfg;
    } catch (err) {
      // 읽지 못한 파일을 기본값으로 바로 덮어쓰면 그 안의 설정을 되살릴 길이 없다(백업 파일을 잘못 복사해 넣은 경우 등).
      // 지우지 않고 옆에 이름을 바꿔 보관해 둔 뒤 기본값으로 시작한다.
      let kept = null;
      try {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        kept = path.join(DATA_DIR, `config.broken-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`);
        fs.renameSync(CONFIG_PATH, kept);
      } catch { kept = null; }
      console.error('[store] config.json 파싱 실패, 기본값으로 재생성합니다:', err.message);
      if (kept) console.error(`[store] 읽지 못한 원래 파일은 ${kept} 로 보관했습니다.`);
      const cfg = defaultConfig();
      this._writeSync(cfg);
      return cfg;
    }
  }

  _writeSync(cfg) {
    const tmp = CONFIG_PATH + '.tmp-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    fs.renameSync(tmp, CONFIG_PATH);
  }

  get() {
    return this.config;
  }

  /** mutator(config) 콜백에서 config를 직접 변형한 뒤 저장 + 'change' 이벤트 발행 */
  update(mutator) {
    mutator(this.config);
    // 채널 추가/삭제/일괄 등록 등 어디서 바뀌든 화면 표시 순서가 채널 목록과 어긋나지 않게 한곳에서 맞춘다.
    this.config.display = normalizeDisplay(this.config.display, this.config.channels);
    this._writeSync(this.config);
    this.emit('change', this.config);
    return this.config;
  }

  alarmsDir() {
    return ALARMS_DIR;
  }

  /** 설정 백업/복원 안내용 — 설치본은 %ProgramData%\AIWGuardVMS, 개발 모드는 프로젝트의 data/ */
  dataDir() {
    return DATA_DIR;
  }

  configPath() {
    return CONFIG_PATH;
  }
}

export const store = new Store();
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}
