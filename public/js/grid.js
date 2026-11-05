// 보고 있는 화면 페이지의 그리드(1/4/8/16/36)를 렌더링하고 채널 순서 변경/확대를 관리한다.
// 채널은 등록된 전부가 표시 순서(config.display.order)대로 자동 배치되고, 페이지는 분할 수만큼씩 잘라 만든다(state.js).
import { state, getActivePage, getView, getPageCount, getChannelByChannelId } from './state.js';
import { on } from './bus.js';
import { Tile } from './tile.js';
import { api } from './api.js';
import { getVideoContentRect } from './videoRect.js';
import { setSubscription } from './ws.js';

const gridEl = document.getElementById('grid');
const zoomOverlayEl = document.getElementById('zoomOverlay');
const zoomBoxEl = document.getElementById('zoomBox');
/** @type {Tile[]} */
let tiles = [];
let soloIndex = null;
/** 확대 보기 중인 타일과, 그 타일이 원래 있던 셀에 남겨 둔 자리표시자 @type {{tile: Tile, placeholder: HTMLElement}|null} */
let zoom = null;

/**
 * 동시에 연결하는 영상 수의 상한 = 보이는 화면 + "미리 연결" 합계 16 (v0.4.10 사용자 결정).
 * 보이는 칸을 먼저 채우고 남는 몫만 다음/이전 화면을 미리 연결한다:
 *   16분할: 16 + 0 (미리 연결 없음)   8분할: 8 + 다음 8   4분할: 4 + 다음 4 + 이전 4 + 그다음 4
 * 넘긴 방향의 화면을 먼저, 그다음 반대쪽, 그다음 두 칸 떨어진 화면 순으로 채운다.
 * (v0.4.8: 합계 20, v0.4.9: 미리 연결만 16 → 의도와 달라 변경)
 *
 * 새 영상 연결은 MediaMTX가 카메라 RTSP에 붙고(sourceOnDemand) 카메라의 다음 키프레임(보통 1~4초)을 기다린 뒤에야
 * 첫 장면이 나온다. 미리 연결해 둔 타일은 이미 재생 중이라 DOM만 옮겨 붙이면 끊김 없이 이어진다.
 * 미리 연결된 영상도 디코딩은 하므로(브라우저 CPU/GPU, 네트워크) 상한을 무작정 키우면 안 된다.
 */
const MAX_LIVE_VIDEOS = 16;
/** 미리 연결 타일 보관함 — 화면 안에 있되 보이지 않게(opacity 0) 둔다. 화면 밖에 두면 브라우저가 재생을 멈출 수 있다. */
const warmEl = document.createElement('div');
warmEl.id = 'warmPool';
warmEl.setAttribute('aria-hidden', 'true');
document.body.appendChild(warmEl);
/** channelId → 미리 연결 중인 타일 @type {Map<string, Tile>} */
let warm = new Map();
/** 마지막으로 넘긴 방향(+1 다음, -1 이전) — 그 방향 화면을 먼저 미리 연결한다 */
let lastPageIndex = null;
let lastDir = 1;

export function renderGrid() {
  const page = getActivePage();
  closeZoom(); // 타일을 옮기기 전에 확대된 타일을 제자리로 돌려놓아야 자리표시자가 남지 않는다
  if (lastPageIndex !== null && state.pageIndex !== lastPageIndex) lastDir = state.pageIndex > lastPageIndex ? 1 : -1;
  lastPageIndex = state.pageIndex;

  // 재사용 후보: 미리 연결 타일 + 지금 화면의 타일(분할 변경 등으로 같은 채널이 다시 보이면 영상을 끊지 않는다)
  const spare = new Map(warm);
  warm = new Map();
  const leftovers = [];
  for (const t of tiles) {
    const id = t.channel?.channelId;
    if (id && !spare.has(id)) { t.park(); spare.set(id, t); } else leftovers.push(t);
  }
  tiles = [];
  soloIndex = null;
  gridEl.classList.remove('solo-active');
  for (const t of leftovers) t.destroy();
  if (!page) {
    for (const t of spare.values()) t.destroy();
    gridEl.innerHTML = '';
    return;
  }

  // 16분할보다 촘촘한 화면(36)은 타일이 작아 제목줄/ROI 편집 방식이 달라진다 (style.css의 .grid-dense, tile.js 참고)
  // 사용자분할(grid-custom)은 8분할과 같은 모양이고, 타일에 "빼기(×)" 버튼이 더 보인다.
  gridEl.className = `grid grid-${page.layout}${page.layout > 16 ? ' grid-dense' : ''}${page.custom ? ' grid-custom' : ''}`;
  for (let i = 0; i < page.layout; i++) {
    const channelId = page.cells[i];
    const channel = channelId ? getChannelByChannelId(channelId) : null;
    let tile = channelId ? spare.get(channelId) : null;
    if (tile) {
      spare.delete(channelId);
      tile.cellIndex = i;
      gridEl.appendChild(tile.el); // 옮기기만 한다 — 영상 연결이 그대로 이어진다
      tile.refreshChannel(channel);
      tile.reflow();
    } else {
      tile = new Tile(gridEl, { cellIndex: i });
      tile.setChannel(channel);
    }
    tiles.push(tile);
  }
  syncWarm(spare);
  syncSubscription();
}

function isLive(channel) {
  return !!channel && !!channel.rtspUrl && channel.enabled !== false;
}

/** 미리 연결할 채널 목록 — 보이는 영상과 합쳐 MAX_LIVE_VIDEOS개까지, 넘긴 방향의 가까운 화면 앞쪽 칸부터 */
function warmTargets(page) {
  const v = getView();
  const count = getPageCount();
  let budget = MAX_LIVE_VIDEOS - page.cells.filter((id) => isLive(getChannelByChannelId(id))).length;
  const out = [];
  if (budget <= 0) return out;
  // 넘긴 방향 1칸 → 반대쪽 1칸 → 넘긴 방향 2칸 → 반대쪽 2칸 … (1분할처럼 화면이 작으면 여러 화면을 미리 연결한다)
  const order = [];
  for (let d = 1; d < count; d++) order.push(state.pageIndex + lastDir * d, state.pageIndex - lastDir * d);
  for (const p of order) {
    if (p < 0 || p >= count || p === state.pageIndex) continue;
    for (const id of v.order.slice(p * v.layout, (p + 1) * v.layout)) {
      if (budget <= 0) return out;
      if (page.cells.includes(id) || out.includes(id) || !isLive(getChannelByChannelId(id))) continue;
      out.push(id);
      budget--;
    }
  }
  return out;
}

/** 미리 연결 보관함을 warmTargets에 맞춘다. spare = 다시 쓸 수 있는 (화면에 올라가지 않은) 타일들 — 안 쓰면 정리한다. */
function syncWarm(spare) {
  const page = getActivePage();
  const wanted = page ? warmTargets(page) : [];
  for (const id of wanted) {
    const channel = getChannelByChannelId(id);
    let t = spare.get(id);
    if (t) {
      spare.delete(id);
      if (t.el.parentElement !== warmEl) warmEl.appendChild(t.el);
      t.refreshChannel(channel);
    } else {
      t = new Tile(warmEl, { cellIndex: -1 });
      t.setChannel(channel);
      t.cellIndex = -1;
    }
    warm.set(id, t);
  }
  for (const t of spare.values()) t.destroy();
}

/** 설정만 바뀌었을 때(채널 주소 변경·삭제, 채널 추가 등) 미리 연결 목록도 다시 맞춘다 */
function refreshWarm() {
  const spare = new Map(warm);
  warm = new Map();
  syncWarm(spare);
}

/** 서버에 "이 화면에 떠 있는 채널"을 알려 그 채널의 프레임/유속만 받는다(ws.js). 바뀌었을 때만 실제로 보낸다. */
function syncSubscription() {
  setSubscription(tiles.map((t) => t.channel?.channelId).filter(Boolean));
  applyAlarming();
}

/**
 * 경보 중인 채널의 타일에 계속 남는 빨간 테두리를 건다(state.alarming 기준). 알람 순간의 깜빡임(flashAlarm, 8초)과 달리
 * 수위가 내려가 서버가 경보를 풀 때까지 유지된다 — 팝업을 확인해 닫았거나 다른 화면에서 넘어왔어도 어느 채널인지 보인다.
 */
export function applyAlarming() {
  for (const t of tiles) t.el.classList.toggle('tile-alarming', !!t.channel && state.alarming.has(t.channel.channelId));
}

/**
 * 채널 목록에서 끌어 순서 바꾸기: channelId를 targetId의 앞(after=false) 또는 뒤(after=true)로 옮긴다.
 * 화면 칸에 놓는 것(moveChannel = 두 채널 자리 바꿈)과 달리 사이의 채널들이 한 칸씩 밀린다.
 */
export async function reorderChannel(channelId, targetId, after) {
  const view = getView();
  if (!view || view.custom || channelId === targetId) return;
  const order = view.order.filter((id) => id !== channelId);
  const t = order.indexOf(targetId);
  if (t < 0 || !view.order.includes(channelId)) return;
  order.splice(after ? t + 1 : t, 0, channelId);
  if (order.every((id, i) => id === view.order[i])) return; // 제자리
  clearBigView();
  await saveOrder(order);
}

/** 채널/ROI 등 부수 데이터만 바뀌었을 때 영상 재연결 없이 가볍게 갱신 */
export function refreshSoft() {
  const page = getActivePage();
  if (!page) return;
  // 타일 순서가 칸 순서와 어긋나 있으면(크게보기가 풀렸는데 화면은 그대로인 경우 등) 먼저 순서를 맞춘다
  if (!tilesMatch(page)) arrangeTiles();
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const channelId = page.cells[i];
    const channel = channelId ? state.config.channels.find((c) => c.channelId === channelId) : null;
    // 영상 주소나 사용 여부가 바뀐 채널만 재생을 다시 붙인다. 제목/cam ID/ROI 같은 변경은 영상을 건드리지 않는다.
    if (channel && tile.channel && channel.channelId === tile.channel.channelId) tile.refreshChannel(channel);
  }
  refreshWarm();
  syncSubscription();
}

/**
 * 채널로 타일을 찾는다. 반드시 "그 타일이 실제로 재생 중인 채널"(tile.channel)로 찾아야 한다 —
 * 칸 번호(page.cells의 순서)로 찾으면 크게보기 등으로 타일 순서와 칸 순서가 잠깐이라도 어긋났을 때
 * 다른 채널의 좌표/유속이 엉뚱한 영상 위에 그려진다(2026-10-01 실제 발생: 하천11의 유속이 하천4 화면에 표시).
 */
function tilesOf(channelId) {
  return tiles.filter((t) => t.channel?.channelId === channelId);
}

/** 타일 순서가 지금 페이지의 칸 순서와 같은지 */
function tilesMatch(page) {
  return tiles.length === page.cells.length && tiles.every((t, i) => (t.channel?.channelId ?? null) === page.cells[i]);
}

export function updateFrame(channelId, frame) {
  for (const t of tilesOf(channelId)) t.updateFrame(frame);
}

/** 유속 서비스 결과(격자 칸 + ROI별 유속) — 같은 채널이 배정된 타일에 전달한다. */
export function updateFlow(channelId, flow) {
  for (const t of tilesOf(channelId)) t.updateFlow(flow);
}

/**
 * 왼쪽 채널 목록에서 끄는 동안 그 채널의 지금 자리(보이는 페이지에 있으면)를 흐리게 표시한다.
 * null이면 끌기 표시(원래 자리/놓을 자리)를 모두 지운다.
 */
export function markDragSource(channelId) {
  for (const t of tiles) t.el.classList.toggle('drag-source', !!channelId && t.channel?.channelId === channelId);
  if (!channelId) document.querySelectorAll('.tile.drag-over').forEach((el) => el.classList.remove('drag-over'));
}

export function flashChannelAlarm(channelId) {
  for (const t of tilesOf(channelId)) t.flashAlarm();
}

export function clearChannelAlarmFlash(channelId) {
  for (const t of tilesOf(channelId)) t.clearAlarmFlash();
}

/** 알람 팝업용 스냅샷(현재 프레임 + ROI/탐지 오버레이) 캡처. 현재 페이지에 표시 중이 아니면 null */
export function captureSnapshot(channelId) {
  const tile = tilesOf(channelId)[0];
  if (!tile) return null;
  try {
    tile.renderNow(); // 그리기는 rAF로 미뤄지므로, 캔버스를 읽기 전에 최신 프레임/ROI 상태로 맞춘다
    const c = document.createElement('canvas');
    c.width = tile.canvas.width || 320;
    c.height = tile.canvas.height || 180;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    // 영상도 화면의 타일과 같은 영역에 그려야 그 위에 겹치는 ROI 오버레이(tile.canvas)와 위치가 맞는다.
    if (tile.videoEl.videoWidth) {
      const r = getVideoContentRect(tile.videoEl, c.width, c.height);
      ctx.drawImage(tile.videoEl, r.x, r.y, r.w, r.h);
    }
    ctx.drawImage(tile.canvas, 0, 0);
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

/**
 * 분할 수를 바꾼다. 페이지가 여러 개가 되더라도 항상 화면1(첫 페이지)부터 보여준다(사용자 요청 —
 * 예전에는 보던 채널이 있는 페이지로 옮겨 가서, 8분할 화면2에서 4분할로 바꾸면 화면3이 먼저 보였다).
 */
export async function setLayout(key) {
  const view = getView();
  if (!view || view.key === key) return;
  const prevIndex = state.pageIndex;
  state.pageIndex = 0; // 서버 응답(config_updated)이 오면 새 분할의 화면1로 다시 그린다
  try {
    // 'custom' = 사용자분할. 숫자 분할로 돌아갈 때는 사용자분할을 끄기만 하고 고른 채널 목록은 남겨 둔다.
    await api.updateDisplay(key === 'custom' ? { custom: true } : { custom: false, layout: key });
  } catch (err) {
    state.pageIndex = prevIndex;
    throw err;
  }
}

/** 지금 화면의 채널 목록을 저장한다 — 사용자분할이면 고른 채널 목록, 아니면 전체 채널 표시 순서 */
function saveOrder(order) {
  return api.updateDisplay(getView().custom ? { customOrder: order } : { order });
}

/**
 * 채널을 표시 순서의 pos번째 자리로 옮긴다. 그 자리에 다른 채널이 있으면 서로 자리를 바꾸고,
 * 마지막 페이지의 빈 칸(pos가 채널 수 이상)이면 맨 뒤로 보낸다.
 * 사용자분할에서 아직 고르지 않은 채널이면 그 자리에 끼워 넣는다(뒤 채널들은 한 칸씩 밀린다).
 */
async function moveChannel(channelId, pos) {
  const view = getView();
  const order = [...view.order];
  const from = order.indexOf(channelId);
  if (from === pos) return;
  if (from < 0) {
    if (!view.custom) return;
    order.splice(Math.min(pos, order.length), 0, channelId);
  } else if (pos < order.length) [order[from], order[pos]] = [order[pos], order[from]];
  else { order.splice(from, 1); order.push(channelId); }
  await saveOrder(order);
}

/** 사용자분할: 채널을 고른 목록에 넣거나(맨 뒤) 뺀다. 넣었을 때는 그 채널이 보이는 페이지로 옮겨 간다. */
export async function toggleCustomChannel(channelId) {
  const view = getView();
  if (!view?.custom) return;
  const order = view.order.filter((id) => id !== channelId);
  const added = order.length === view.order.length;
  if (added) order.push(channelId);
  clearBigView();
  // 페이지는 저장 전에 미리 옮겨 둔다 — 서버가 돌려보내는 config_updated가 오면 그 페이지로 그려진다
  const prevIndex = state.pageIndex;
  if (added) state.pageIndex = Math.floor((order.length - 1) / view.layout);
  try {
    await saveOrder(order);
  } catch (err) {
    state.pageIndex = prevIndex;
    throw err;
  }
}

// 사용자분할 타일의 × → 고른 목록에서 뺀다(채널 자체는 지워지지 않는다)
on('tile:remove', ({ cellIndex }) => {
  const channelId = tiles[cellIndex]?.channel?.channelId;
  if (channelId) toggleCustomChannel(channelId).catch((err) => alert(err.message));
});

// 사이드바에서 채널을 끌어다 놓거나(또는 선택 후 칸 클릭) → 그 채널을 이 칸 자리로 옮긴다
on('tile:drop', async ({ cellIndex, channelId }) => {
  const page = getActivePage();
  if (!page) return;
  state.armedChannelId = null;
  // 크게보기 중이면 보이는 칸과 실제 순서 번호가 다를 수 있어 positions로 옮길 자리를 찾는다.
  // 순서를 바꾸는 것이므로 크게보기는 풀고 바뀐 순서 그대로 보여준다.
  const pos = page.positions[cellIndex];
  clearBigView();
  await moveChannel(channelId, pos).catch((err) => alert(err.message));
});

/**
 * 크게보기를 풀고 화면도 원래 순서로 되돌린다. state.bigView만 지우고 화면을 그대로 두면 안 된다 —
 * 순서가 실제로 바뀌지 않는 경우(제자리에 끌어다 놓기, 저장 실패)에는 다시 그려지지 않아 화면만 크게보기 상태로 남는다.
 */
function clearBigView() {
  if (!state.bigView) return;
  state.bigView = null;
  arrangeTiles();
}

/**
 * 8분할 "크게보기": 고른 채널을 왼쪽 위 큰 화면에 올린다. 채널 표시 순서는 저장하지 않고(state.bigView)
 * 이 페이지를 보는 동안만 적용되며, 다른 페이지나 다른 분할로 가면 원래 순서로 돌아간다.
 * 원래 첫 채널을 다시 고르면 원래 배치로 돌아간다.
 */
on('tile:promote', ({ cellIndex }) => {
  const page = getActivePage();
  const channelId = tiles[cellIndex]?.channel?.channelId;
  if (!page || page.layout !== 8 || cellIndex <= 0 || !channelId) return;
  closeZoom();
  state.bigView = channelId === getView().order[page.start]
    ? null
    : { layout: page.key, pageIndex: state.pageIndex, channelId };
  arrangeTiles();
});

/**
 * 타일을 새로 만들지 않고 getActivePage().cells 순서대로 DOM과 tiles 배열만 다시 늘어놓는다.
 * 큰 화면 자리는 CSS :first-child라 순서만 바꾸면 되고, 영상 연결(WHEP)·ROI 상태는 그대로 유지된다.
 */
function arrangeTiles() {
  const cells = getActivePage().cells;
  const pool = [...tiles];
  const next = [];
  for (const cid of cells) {
    const i = pool.findIndex((t) => (t.channel?.channelId ?? null) === cid);
    if (i < 0) return renderGrid(); // 타일과 배치가 어긋난 경우(있어선 안 됨) — 새로 그린다
    next.push(pool.splice(i, 1)[0]);
  }
  next.forEach((t, i) => {
    t.cellIndex = i;
    gridEl.appendChild(t.el);
    t.reflow(); // DOM을 옮기면 재생이 멈추는 브라우저가 있어 다시 걸고, 캔버스 크기도 다시 잡는다
  });
  tiles = next;
  syncSubscription();
}

on('tile:expand', ({ cellIndex }) => {
  soloIndex = soloIndex === cellIndex ? null : cellIndex;
  gridEl.classList.toggle('solo-active', soloIndex !== null);
  tiles.forEach((t, i) => t.el.classList.toggle('is-solo', i === soloIndex));
  tiles.forEach((t) => t._resizeCanvas());
});

// ---------------- 확대 보기 (타일 더블클릭) ----------------

/**
 * 해당 셀의 타일을 화면 정중앙 확대 상자로 옮긴다.
 * 타일 DOM을 통째로 옮기기 때문에 WHEP 연결·ROI 오버레이·ROI 편집 상태가 끊기지 않고 그대로 커진다.
 */
function openZoom(cellIndex) {
  const page = getActivePage();
  if (!page || page.layout <= 1) return; // 1분할은 이미 화면 전체라 확대할 것이 없다
  const tile = tiles[cellIndex];
  if (!tile || !tile.channel) return;
  if (zoom) {
    if (zoom.tile === tile) return;
    closeZoom(); // 다른 채널을 더블클릭하면 그 채널로 바꿔 확대한다
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'tile tile-zoom-placeholder';
  placeholder.textContent = `${tile.channel.title} 확대 중`;
  tile.el.before(placeholder);
  zoomBoxEl.appendChild(tile.el); // 지우고 다시 만드는 게 아니라 옮기는 것이라 영상이 유지된다
  tile.el.classList.add('is-zoomed');
  zoomOverlayEl.classList.remove('hidden');
  zoom = { tile, placeholder };
  tile.reflow();
}

/** 확대된 타일을 원래 셀로 되돌리고 오버레이를 닫는다 */
function closeZoom() {
  if (!zoom) return;
  const { tile, placeholder } = zoom;
  zoom = null;
  tile.el.classList.remove('is-zoomed');
  placeholder.replaceWith(tile.el);
  zoomOverlayEl.classList.add('hidden');
  tile.reflow();
}

on('tile:zoom', ({ cellIndex }) => openZoom(cellIndex));
on('tile:zoomClose', () => closeZoom()); // 확대된 타일 제목줄의 × (ROI삭제 옆)

// 어두운 바깥 여백 클릭도 닫기 — 확대 상자 안(영상/ROI 폼)을 클릭한 경우는 제외한다
zoomOverlayEl.addEventListener('click', (e) => { if (e.target === zoomOverlayEl) closeZoom(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !zoom) return;
  // ROI 이름/임계값 입력 중이거나 채널명을 고치는 중이면 Esc는 그 입력의 몫이다
  const t = e.target;
  if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '')) return;
  closeZoom();
});
