// 프론트 전역 상태 (서버 config의 클라이언트측 캐시)
export const state = {
  config: null,
  tcpStatus: {},
  tcpPeers: {}, // 수신 대기(server) 모드 소스에 현재 붙어 있는 대수
  pageIndex: 0, // 보고 있는 화면 페이지(0부터). 페이지는 저장하지 않고 채널 수와 분할 수로 계산한다.
  armedChannelId: null, // 사이드바에서 선택되어 "이동 대기" 중인 채널
  /**
   * 8분할 "크게보기"로 큰 화면에 올린 채널 { layout, pageIndex, channelId }. 저장하지 않는 화면 전용 값이라
   * 채널 표시 순서(config.display.order)는 그대로다. 다른 페이지로 넘어가거나 분할을 바꾸면 getActivePage가 지워서
   * 원래 순서로 돌아간다(사용자 요청 — 크게보기 때문에 채널 순서가 바뀌면 불편하다).
   */
  bigView: null,
  /**
   * 지금 경보 상태인 채널 → 경보 중인 ROI id 집합. 확인(Ack)해도 지워지지 않고 서버의 alarm_clear(수위가 내려감)에서만 지운다.
   * 화면 밖 채널의 경보를 페이지 지도·채널 목록에 빨갛게 표시하는 데 쓴다. @type {Map<string, Set<string>>}
   */
  alarming: new Map()
};

/** 경보 상태 갱신 — 바뀌었으면 true */
export function setAlarming(channelId, roiId, on) {
  if (!channelId || !roiId) return false;
  const set = state.alarming.get(channelId);
  if (on) {
    if (set?.has(roiId)) return false;
    if (set) set.add(roiId); else state.alarming.set(channelId, new Set([roiId]));
    return true;
  }
  if (!set?.delete(roiId)) return false;
  if (set.size === 0) state.alarming.delete(channelId);
  return true;
}

/** 설정이 바뀌어 사라진 채널/ROI의 경보 표시를 정리한다(ROI를 지우면 서버는 alarm_clear 없이 상태만 버린다). */
export function pruneAlarming() {
  const rois = new Set((state.config?.rois || []).map((r) => r.id));
  for (const [ch, set] of state.alarming) {
    for (const id of set) if (!rois.has(id)) set.delete(id);
    if (set.size === 0) state.alarming.delete(ch);
  }
}

/** 이 채널이 일반 분할(사용자분할이면 고른 목록)에서 몇 번째 화면 페이지에 있는지. 없으면 -1 */
export function pageOfChannel(channelId) {
  const v = getView();
  const i = v ? v.order.indexOf(channelId) : -1;
  return i < 0 ? -1 : Math.floor(i / v.layout);
}

/** 사용자분할이 쓰는 화면 모양 — 8분할(큰 화면 1 + 작은 화면 7)과 같다 */
const CUSTOM_LAYOUT = 8;

/**
 * 지금 화면이 실제로 쓰는 분할/채널 목록.
 *  - 일반 분할: layout = 고른 분할 수, order = 등록된 모든 채널(display.order)
 *  - 사용자분할(display.custom): layout = 8, order = 사용자가 고른 채널만(display.customOrder, 고른 순서)
 * key는 분할 버튼의 data-layout 값과 같다(숫자 또는 'custom'). 설정이 아직 없으면 null.
 */
export function getView(cfg = state.config) {
  const d = cfg?.display;
  if (!d) return null;
  return d.custom
    ? { custom: true, key: 'custom', layout: CUSTOM_LAYOUT, order: d.customOrder || [] }
    : { custom: false, key: d.layout, layout: d.layout, order: d.order };
}

export function setConfig(cfg) {
  // 분할이 바뀌면(다른 브라우저에서 바꾼 경우 포함) 항상 화면1부터 보여준다
  if (state.config && getView().key !== getView(cfg).key) state.pageIndex = 0;
  state.config = cfg;
  if (getView().custom) state.armedChannelId = null; // 사용자분할에서는 목록 클릭이 "이동 대기"가 아니라 넣기/빼기다
  clampPageIndex();
}

/** 화면 페이지 수 = ⌈채널 수 / 분할 수⌉ (채널이 없어도 빈 페이지 1개) */
export function getPageCount() {
  const v = getView();
  if (!v) return 1;
  return Math.max(1, Math.ceil(v.order.length / v.layout));
}

/** 채널이 줄거나 분할이 커져 페이지 수가 줄었으면 마지막 페이지로 당긴다 */
export function clampPageIndex() {
  state.pageIndex = Math.min(Math.max(0, state.pageIndex), getPageCount() - 1);
}

/**
 * 지금 보고 있는 페이지 — layout: 분할 수, start: 첫 칸의 표시 순서 번호,
 * cells: 칸마다 보이는 channelId (마지막 페이지의 남는 칸은 null),
 * positions: 칸마다 그 채널의 표시 순서 번호(크게보기로 첫 칸과 자리가 바뀐 칸은 서로 바뀐 번호). 설정이 아직 없으면 null.
 */
export function getActivePage() {
  const d = getView();
  if (!d) return null;
  const start = state.pageIndex * d.layout;
  const positions = Array.from({ length: d.layout }, (_, i) => start + i);

  // 크게보기는 그것을 고른 페이지·분할에서만 유효하다. 벗어났거나 그 채널이 이 페이지에 없으면 버린다.
  const bv = state.bigView;
  if (bv) {
    const k = bv.layout === d.key && bv.pageIndex === state.pageIndex ? d.order.indexOf(bv.channelId) - start : -1;
    if (d.layout === 8 && k > 0 && k < d.layout) [positions[0], positions[k]] = [positions[k], positions[0]];
    else state.bigView = null;
  }
  const cells = positions.map((p) => d.order[p] ?? null);
  return { layout: d.layout, custom: d.custom, key: d.key, start, cells, positions };
}

export function getChannelByChannelId(channelId) {
  return state.config?.channels.find((c) => c.channelId === channelId) || null;
}

export function getRoisForChannel(channelId) {
  return state.config?.rois.filter((r) => r.channelId === channelId) || [];
}

export function getRoiById(roiId) {
  return state.config?.rois.find((r) => r.id === roiId) || null;
}
