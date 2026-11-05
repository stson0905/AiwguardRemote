// 애플리케이션 진입점: 토폴바/사이드바 구성 + WebSocket 상태 반영 오케스트레이션
import { connectWs } from './ws.js';
import { on, emit } from './bus.js';
import { state, setConfig, getActivePage, getPageCount, getView, pageOfChannel, setAlarming, pruneAlarming } from './state.js';
import * as grid from './grid.js';
import { initAlarms, showActiveAlarms, refreshToastLocations } from './alarm.js';
import { initSettingsPanel, refresh as refreshSettings } from './settingsPanel.js';
import { initEventLog } from './eventLog.js';
import { applyDevMode } from './devMode.js';
import { initTheme } from './theme.js';

// 저장된 개발자 모드 상태를 화면이 그려지기 전에 body 클래스로 반영한다
// (안 하면 설명 팁이 잠깐 보였다 사라지는 깜빡임이 생긴다).
applyDevMode();
// 화면 테마: index.html <head>의 인라인 스크립트가 이미 올려둔 값을 검증/정리하고 ?theme= 주소 인자를 처리한다.
initTheme();

initAlarms();
initSettingsPanel();
initEventLog();
wireTopbar();
wireSidebar();
connectWs();

/** 현재 화면 페이지의 "타일 배치"를 한 줄로 요약 — 이게 같으면 타일을 새로 만들 필요가 없다 */
function pageKey(page) {
  return page ? page.key + ':' + page.start + ':' + JSON.stringify(page.cells) : null;
}

/**
 * 화면에서 숨긴 분할(코드와 서버는 그대로 지원 — 버튼만 숨김). 36분할은 v0.4.3에서 사용자 요청으로 숨김:
 * 지원 상한을 16분할로 둔다. 다시 쓰려면 이 목록에서 빼고 index.html 버튼의 hidden을 지우면 된다.
 */
const HIDDEN_LAYOUTS = new Set([36]);
let hiddenLayoutFixed = false;

on('ws:init', (msg) => {
  const prevKey = state.config ? pageKey(getActivePage()) : null;
  setConfig(msg.config);
  // 경보 상태는 재접속 때마다 서버 것으로 통째로 바꾼다(끊겨 있던 사이 해제된 경보가 남지 않게).
  state.alarming.clear();
  for (const { channelId, roiId } of msg.alarming || []) setAlarming(channelId, roiId, true);
  pruneAlarming();
  // 숨긴 분할(36)로 저장돼 있으면 16분할로 바꿔 둔다 — 버튼이 없어 사용자가 빠져나올 방법이 없기 때문.
  if (!hiddenLayoutFixed && HIDDEN_LAYOUTS.has(getView()?.key)) {
    hiddenLayoutFixed = true;
    grid.setLayout(16).catch(() => {});
  }
  state.tcpStatus = msg.tcpStatus || {};
  state.tcpPeers = Object.fromEntries(Object.entries(msg.tcpDetails || {}).map(([id, d]) => [id, d.peers || 0]));
  // 재접속(서버 재시작, 네트워크 흔들림)인데 보이는 배치가 그대로면 타일을 다시 만들지 않는다 — 다시 만들면
  // 36개 영상이 전부 끊겼다 다시 붙는다. 영상은 브라우저↔MediaMTX 직결이라 VMS 서버와 무관하게 살아 있다.
  if (prevKey === null || prevKey !== pageKey(getActivePage())) grid.renderGrid(); else grid.refreshSoft();
  renderPageTabs();
  renderStatusLights();
  renderSidebarList();
  refreshSettings();
  // 이미 발생 중인 알람 팝업 복원 — config/그리드가 다 준비된 뒤여야 스냅샷과 타일 점멸이 제대로 붙는다.
  showActiveAlarms(msg.activeAlarms);
  refreshToastLocations();
});

on('ws:config_updated', (msg) => {
  const prevKey = pageKey(getActivePage());
  setConfig(msg.config);
  pruneAlarming();
  if (prevKey !== pageKey(getActivePage())) grid.renderGrid(); else grid.refreshSoft();
  renderPageTabs();
  renderStatusLights();
  renderSidebarList();
  refreshSettings();
  refreshToastLocations(); // 분할/순서가 바뀌면 팝업의 "화면N" 번호도 바뀐다
});

// 경보가 생기거나 풀리면 — 페이지 지도/채널 목록/타일의 경보 표시만 갱신한다.
on('alarming:changed', () => {
  renderPageTabs();
  updateSidebarMarks();
  grid.applyAlarming();
});
// 알람 팝업의 "화면N 보기" — 그 채널이 있는 화면으로 간다.
on('page:goto', ({ channelId }) => {
  const p = pageOfChannel(channelId);
  if (p < 0) return alert('이 채널은 지금 분할(사용자분할)의 화면에 없습니다.');
  goToPage(p);
  grid.flashChannelAlarm(channelId);
});

on('ws:frame', (msg) => grid.updateFrame(msg.channelId, msg));
on('ws:flow', (msg) => grid.updateFlow(msg.channelId, msg));
on('ws:tcp_status', ({ connId, status, peers }) => {
  state.tcpStatus[connId] = status;
  state.tcpPeers[connId] = peers || 0;
  renderStatusLights();
});

// ---------------- Topbar ----------------
function wireTopbar() {
  document.getElementById('layoutSwitch').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-layout]');
    if (!btn) return;
    const key = btn.dataset.layout === 'custom' ? 'custom' : Number(btn.dataset.layout);
    await grid.setLayout(key).catch((err) => alert(err.message));
  });
  document.getElementById('pageTabs').addEventListener('click', (e) => {
    const pg = e.target.closest('button[data-page]');
    if (pg) return goToPage(Number(pg.dataset.page));
    const step = e.target.closest('button[data-step]');
    if (step) goToPage(state.pageIndex + Number(step.dataset.step));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
    const t = e.target;
    if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '')) return;
    if (!document.getElementById('settingsModal')?.classList.contains('hidden')) return; // 설정 창이 열려 있으면 그쪽 스크롤
    e.preventDefault();
    goToPage(state.pageIndex + (e.key === 'PageDown' ? 1 : -1));
  });
  document.getElementById('btnFullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  // 화면 테마 선택은 메인 화면이 아니라 설정 > 화면 테마 탭에서만 한다 (사용자 요청).
}

function updateLayoutButtonsActive() {
  const page = getActivePage();
  if (!page) return;
  document.querySelectorAll('#layoutSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.layout === String(page.key)));
}

/**
 * 화면 페이지 지도 — 페이지마다 그 분할 모양을 축소한 작은 바둑판을 그린다(16분할이면 4x4 점, 8분할이면 큰 칸 1 + 작은 칸 7).
 * 채널이 있는 칸은 채워지고, **경보 중인 채널의 칸은 빨갛게 깜빡여** 지금 안 보고 있는 화면의 침수도 한눈에 보인다.
 * 페이지가 많으면(1·4분할 x 128채널 = 128/32쪽) 지도만 가로로 스크롤되고 ‹ › / PageUp·PageDown 으로도 넘긴다.
 */
function renderPageTabs() {
  const el = document.getElementById('pageTabs');
  const view = getView();
  if (!view) return;
  const { layout, order, custom } = view;
  const count = getPageCount();
  const byId = new Map(state.config.channels.map((c) => [c.channelId, c]));
  const prevScroll = el.querySelector('.page-map')?.scrollLeft || 0;

  const pages = [];
  for (let i = 0; i < count; i++) {
    const ids = order.slice(i * layout, (i + 1) * layout);
    const alarmIds = ids.filter((id) => state.alarming.has(id));
    const cells = Array.from({ length: layout }, (_, k) =>
      `<i class="${!ids[k] ? 'e' : state.alarming.has(ids[k]) ? 'a' : 'c'}"></i>`).join('');
    const names = ids.map((id) => byId.get(id)?.title).filter(Boolean);
    const tip = [`화면${i + 1}`,
      names.length ? `${names[0]}${names.length > 1 ? ' ~ ' + names.at(-1) : ''} (${names.length}채널)` : (custom ? '고른 채널 없음' : '채널 없음'),
      ...(alarmIds.length ? [`⚠ 경보 중: ${alarmIds.map((id) => byId.get(id)?.title || id).join(', ')}`] : [])].join('\n');
    pages.push(`<button class="pg${i === state.pageIndex ? ' active' : ''}${alarmIds.length ? ' alarm' : ''}" data-page="${i}" title="${escapeHtml(tip)}">
      <span class="pg-mini pg-mini-${custom ? 8 : layout}">${cells}</span><span class="pg-num">${i + 1}</span></button>`);
  }
  const offAlarm = [...state.alarming.keys()].filter((id) => !getActivePage()?.cells.includes(id) && order.includes(id)).length;
  el.innerHTML = `
    <button class="pg-arrow" data-step="-1" title="이전 화면 (PageUp)" ${state.pageIndex <= 0 ? 'disabled' : ''}>‹</button>
    <div class="page-map">${pages.join('')}</div>
    <button class="pg-arrow" data-step="1" title="다음 화면 (PageDown)" ${state.pageIndex >= count - 1 ? 'disabled' : ''}>›</button>
    <span class="pg-count">${state.pageIndex + 1}<small>/${count}</small></span>
    ${offAlarm ? `<span class="pg-alarm-note" title="빨간 칸이 있는 화면을 누르면 그 화면으로 갑니다">⚠ 다른 화면 경보 ${offAlarm}</span>` : ''}`;
  const map = el.querySelector('.page-map');
  map.scrollLeft = prevScroll;
  map.querySelector('.pg.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateLayoutButtonsActive();
  renderWatchStatus(); // 페이지 지도가 다시 그려지는 모든 경우(설정/경보/페이지 이동)에 상태 띠도 같이 맞춘다
}

/**
 * 맨 위 감시 상태 띠(모든 테마 공통 — 테마마다 색/높이만 CSS가 바꾼다).
 * 평소: "정상 감시 중 · 채널/화면/분할 요약 · 시계". 경보 중: "침수 경보 발생 · N개 채널 — 이름들 · [경보 화면 보기]".
 * 판정은 서버가 전 채널을 하므로 state.alarming(Ack 무관, 경보가 풀릴 때까지 유지)을 그대로 쓴다.
 */
function renderWatchStatus() {
  const el = document.getElementById('watchStatus');
  const view = getView();
  if (!el || !view) return;
  const byId = new Map(state.config.channels.map((c) => [c.channelId, c]));
  const alarmIds = [...state.alarming.keys()].filter((id) => byId.has(id));
  const alarm = alarmIds.length > 0;
  el.classList.toggle('alarm', alarm);
  const names = alarmIds.map((id) => byId.get(id).title || id);
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ` 외 ${names.length - 4}` : '');
  const enabled = state.config.channels.filter((c) => c.enabled !== false).length;
  const metrics = `<span class="ws-metrics">
      <span>채널 <b>${enabled}</b><small>/${state.config.channels.length}</small></span>
      <span>화면 <b>${state.pageIndex + 1}</b><small>/${getPageCount()}</small></span>
      <span>${view.custom ? '<b>사용자분할</b>' : `<b>${view.layout}</b>분할`}</span>
      <span>경보 <b>${alarmIds.length}</b></span></span>`;
  el.innerHTML = alarm
    ? `<span class="ws-state"><i class="ws-lamp"></i>침수 경보 발생</span>
       <span class="ws-detail">${alarmIds.length}개 채널 — ${escapeHtml(shown)}</span>
       <button class="ws-goto" data-channel-id="${escapeHtml(alarmIds[0])}" title="경보 중인 첫 채널이 있는 화면으로 이동">경보 화면 보기 ›</button>
       <span class="ws-spacer"></span>${metrics}<span class="ws-clock" id="wsClock">${clockText()}</span>`
    : `<span class="ws-state"><i class="ws-lamp"></i>정상 감시 중</span>
       <span class="ws-spacer"></span>${metrics}<span class="ws-clock" id="wsClock">${clockText()}</span>`;
}

function clockText(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(() => {
  const c = document.getElementById('wsClock');
  if (c) c.textContent = clockText();
}, 1000);
document.getElementById('watchStatus')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.ws-goto');
  if (btn) emit('page:goto', { channelId: btn.dataset.channelId });
});

function goToPage(i) {
  const n = Math.min(Math.max(0, i), getPageCount() - 1);
  if (n === state.pageIndex) return;
  state.pageIndex = n;
  grid.renderGrid();
  renderPageTabs();
  updateSidebarMarks();
  refreshToastLocations();
}

function renderStatusLights() {
  const el = document.getElementById('statusLights');
  el.innerHTML = '';
  for (const conn of state.config.tcpConnections) {
    if (conn.enabled === false) continue; // 사용 안 함으로 꺼둔 소스는 상태등에 표시하지 않는다
    const status = state.tcpStatus[conn.id] || 'disconnected';
    const isServer = conn.mode === 'server';
    const span = document.createElement('span');
    span.innerHTML = `<span class="dot ${status}"></span>${escapeHtml(conn.label)}`;
    const peers = state.tcpPeers[conn.id] || 0;
    span.title = isServer
      ? `수신 대기 ${conn.ip}:${conn.port} — 접속 ${peers}대 (${status})`
      : `접속 대상 ${conn.ip}:${conn.port} (${status})`;
    el.appendChild(span);
  }
}

// ---------------- Sidebar ----------------
function wireSidebar() {
  document.getElementById('channelSearch').addEventListener('input', renderSidebarList);
  // 끄는 도중 설정 변경으로 목록이 다시 그려지면 원래 항목의 dragend가 오지 않는다 — 문서 수준에서도 정리한다.
  document.addEventListener('dragend', endListDrag);
  document.addEventListener('drop', () => setTimeout(endListDrag, 0));
}

/** 목록에서 끌고 있는 채널(목록 안 순서 바꾸기 판단용). 다른 곳(파일 등)에서 끌어온 것과 구분한다. */
let listDragId = null;

function endListDrag() {
  listDragId = null;
  document.querySelectorAll('#channelList li.dragging, #channelList li.drop-before, #channelList li.drop-after')
    .forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after'));
  grid.markDragSource(null);
}

/**
 * 왼쪽 채널 목록. 일반 분할에서는 **화면 표시 순서 그대로** 보여주고, 목록 안에서 위아래로 끌어 놓으면
 * 그 순서대로 화면 칸이 바뀐다(화면 칸에 끌어 놓으면 그 칸의 채널과 자리 바꿈). 지금 화면에 보이는 채널은
 * 왼쪽 막대, 경보 중인 채널은 빨간색으로 표시하고 오른쪽에 몇 번째 화면인지 적는다.
 * 사용자분할에서는 목록 클릭이 "화면에 넣기/빼기"다(고른 순서대로 번호가 붙는다).
 */
function renderSidebarList() {
  const q = document.getElementById('channelSearch').value.trim().toLowerCase();
  const ul = document.getElementById('channelList');
  ul.innerHTML = '';
  const view = getView();
  if (!view) return;
  const custom = !!view.custom;
  document.getElementById('sidebarHint').textContent = custom
    ? `사용자분할: 채널을 클릭하면 화면에 추가되고, 다시 클릭하면 빠집니다. 타일로 끌어다 놓으면 그 자리에 들어갑니다. (${view.order.length}개 선택)`
    : '목록에서 위아래로 끌어 순서를 바꾸면 화면 배치도 바뀝니다. 화면 칸에 끌어 놓으면 그 칸의 채널과 자리를 바꿉니다.';

  const byId = new Map(state.config.channels.map((c) => [c.channelId, c]));
  const list = custom
    ? state.config.channels
    : [...view.order.map((id) => byId.get(id)).filter(Boolean), ...state.config.channels.filter((c) => !view.order.includes(c.channelId))];
  const onPage = new Set(getActivePage()?.cells.filter(Boolean));

  for (const ch of list) {
    if (q && !ch.title.toLowerCase().includes(q) && !ch.channelId.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.channelId = ch.channelId;
    const pickNo = custom ? view.order.indexOf(ch.channelId) + 1 : 0;
    const pageNo = custom ? 0 : pageOfChannel(ch.channelId) + 1;
    li.className = pickNo ? 'picked' : (state.armedChannelId === ch.channelId ? 'armed' : '');
    li.innerHTML = `<span class="ch-name"><span class="ch-dot ${ch.enabled !== false ? 'on' : ''}"></span>${escapeHtml(ch.title)}</span>`
      + (pickNo ? `<span class="pick-no" title="사용자분할 ${pickNo}번째">${pickNo}</span>` : '')
      + (pageNo > 0 ? `<span class="pg-no" title="화면${pageNo}에 있는 채널">${pageNo}</span>` : '');
    li.title = ch.rtspUrl || '(RTSP 미설정)';
    li.ondragstart = (e) => {
      listDragId = ch.channelId;
      e.dataTransfer.setData('text/plain', ch.channelId);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
      grid.markDragSource(ch.channelId);
    };
    li.ondragend = endListDrag;
    if (!custom) {
      // 목록 안에서 순서 바꾸기: 마우스가 항목의 위쪽 절반이면 그 앞, 아래쪽 절반이면 그 뒤에 넣는다.
      li.ondragover = (e) => {
        if (!listDragId || listDragId === ch.channelId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = li.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        li.classList.toggle('drop-after', after);
        li.classList.toggle('drop-before', !after);
      };
      li.ondragleave = (e) => {
        if (!li.contains(e.relatedTarget)) li.classList.remove('drop-before', 'drop-after');
      };
      li.ondrop = (e) => {
        if (!listDragId || listDragId === ch.channelId) return;
        e.preventDefault();
        const after = li.classList.contains('drop-after');
        const moving = listDragId;
        endListDrag();
        grid.reorderChannel(moving, ch.channelId, after).catch((err) => alert(err.message));
      };
    }
    li.onclick = () => {
      if (custom) return grid.toggleCustomChannel(ch.channelId).catch((err) => alert(err.message));
      state.armedChannelId = state.armedChannelId === ch.channelId ? null : ch.channelId;
      renderSidebarList();
    };
    ul.appendChild(li);
  }
  updateSidebarMarks(onPage);
}

/** 목록 다시 그리지 않고 "지금 화면에 보임 / 경보 중" 표시만 갱신한다(끄는 중에 다시 그리면 끌기가 끊긴다). */
function updateSidebarMarks(onPage = new Set(getActivePage()?.cells.filter(Boolean))) {
  document.querySelectorAll('#channelList li').forEach((li) => {
    const id = li.dataset.channelId;
    li.classList.toggle('on-page', onPage.has(id));
    li.classList.toggle('alarming', state.alarming.has(id));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
