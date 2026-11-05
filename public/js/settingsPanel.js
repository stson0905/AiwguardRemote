// 설정 모달(TCP 연결 / 채널·RTSP / 알람 / MediaMTX) CRUD UI
import { state } from './state.js';
import { api } from './api.js';
import { on } from './bus.js';
import { makeDraggable } from './draggable.js';
import { isDevMode, setDevMode, applyDevMode } from './devMode.js';
import { THEMES, getTheme, setTheme } from './theme.js';

const modalEl = document.getElementById('settingsModal');
const tcpBody = document.querySelector('#tcpTable tbody');
const chBody = document.querySelector('#channelTable tbody');

/** 모달이 열려 있는 동안에만 도는 "수신 현황" 폴링 */
let camPollTimer = null;
let dragHandle = null;
/** 마지막으로 확인된 "좌표가 들어오고 있는 channelId" — 표를 다시 그렸을 때 표시를 즉시 복원하는 용도 */
let lastReceiving = new Set();
/** 채널 표에서 선택(왼쪽 네모)해 둔 채널의 id. 설정이 바뀌어 표를 다시 그려도 선택은 유지한다. */
const selectedChannelIds = new Set();
/** Shift+클릭으로 범위를 고를 때의 기준 행 번호 */
let lastSelIndex = null;
/**
 * 표를 다시 그린 뒤 "추가" 줄을 어떻게 할지.
 *   'reset' = 입력값을 비우고 채널명 칸으로 커서 (채널을 막 추가했을 때)
 *   'focus' = 입력값은 그대로 두고 채널명 칸으로 커서 (＋채널 추가 바로가기로 열었을 때)
 *   null    = 아무것도 하지 않음(입력 중이던 값과 커서는 그대로 복원된다)
 */
let addRowIntent = null;

export function initSettingsPanel() {
  document.getElementById('btnSettings').onclick = () => openSettings();
  document.getElementById('btnCloseSettings').onclick = () => closeSettings();
  document.getElementById('btnAddChannelQuick').onclick = () => openSettings('channels', { focusAdd: true });
  // 바깥(어두운 배경) 클릭으로는 닫지 않는다 — 설정을 입력하다 실수로 옆을 클릭하면 모달이 닫혀
  // 작업이 날아가는 문제가 있었다. 닫기는 오직 우측 상단 × 버튼으로만 한다.

  // 제목 표시줄을 끌어 창을 옮길 수 있게 한다. 옮긴 위치는 이 브라우저에 기억된다.
  dragHandle = makeDraggable(
    document.getElementById('settingsModalBox'),
    document.getElementById('settingsModalHeader'),
    { storageKey: 'aiwguard.settingsModalPos' }
  );

  document.getElementById('modalTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    selectTab(btn.dataset.tab);
  });

  document.getElementById('btnClearAllRois').onclick = async () => {
    if (!confirm('정말 전체 채널의 모든 ROI를 삭제할까요? 되돌릴 수 없습니다.')) return;
    await api.deleteAllRois();
  };

  wireChannelTab();
  wireAlarmTab();
  wireMediamtxTab();
  wireThemeTab();
  wireBackupTab();
  wireHelpTab();

  on('ws:tcp_status', ({ connId, status, peers }) => {
    state.tcpStatus[connId] = status;
    state.tcpPeers[connId] = peers || 0;
    // 표 전체를 다시 그리면 입력 중이던 칸의 포커스가 날아간다(재접속 백오프 중엔 몇 초마다 상태가 바뀐다).
    // 상태 칸만 제자리에서 고친다. 모달이 닫혀 있으면 열 때 refresh()가 다시 그리므로 여기서는 아무것도 안 한다.
    if (modalEl.classList.contains('hidden')) return;
    updateTcpStatusCell(connId);
  });

  refresh();
}

export function openSettings(tab, { focusAdd = false } = {}) {
  modalEl.classList.remove('hidden');
  // 기억해 둔 위치가 지금 창 크기에서는 화면 밖일 수 있으므로 열 때마다 화면 안으로 되돌린다.
  // (닫혀 있는 동안에는 크기가 0이라 계산할 수 없어서, 반드시 보이게 만든 뒤에 호출해야 한다.)
  dragHandle?.clampIntoView();
  if (tab) selectTab(tab);
  // "＋ 채널 추가" 같은 바로가기로 열었으면 곧바로 입력할 수 있게 추가 줄에 커서를 놓는다.
  if (focusAdd) addRowIntent = 'focus';
  refresh();
  startCamPolling();
}

function closeSettings() {
  modalEl.classList.add('hidden');
  stopCamPolling();
}

function selectTab(tab) {
  document.querySelectorAll('#modalTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.modal-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
}

export function refresh() {
  if (!state.config) return;
  // 닫혀 있는 모달의 표를 설정이 바뀔 때마다 다시 만들 이유가 없다 — 열 때(openSettings) 다시 그린다.
  if (modalEl.classList.contains('hidden')) return;
  renderTcpTable();
  renderChannelTable();
  fillAlarmForm();
  fillMediamtxForm();
  renderBackupInfo();
}

// ---------------- 설정 백업 ----------------
// 내보내기는 <a href="/api/config/export" download> 링크 하나로 끝난다(서버가 파일 이름을 붙여 내려준다).
// 여기서는 실제 저장 위치(설치본 = %ProgramData%\AIWGuardVMS)와 들어갈 내용 요약만 서버에서 받아 보여준다.
function wireBackupTab() {
  document.getElementById('btnCopyDataDir').onclick = async () => {
    const text = document.getElementById('backupDataDir').textContent;
    try { await navigator.clipboard.writeText(text); flashCopied(); }
    catch { window.prompt('경로를 복사하세요 (Ctrl+C)', text); } // http 접속에서는 클립보드 API가 막힐 수 있다
  };
}

function flashCopied() {
  const btn = document.getElementById('btnCopyDataDir');
  btn.textContent = '복사됨 ✓';
  setTimeout(() => { btn.textContent = '복사'; }, 1500);
}

async function renderBackupInfo() {
  try {
    const info = await api.getBackupInfo();
    document.getElementById('backupDataDir').textContent = info.dataDir;
    document.getElementById('backupSummary').textContent =
      `채널 ${info.counts.channels}개 · ROI ${info.counts.rois}개 · TCP 소스 ${info.counts.tcpConnections}개가 저장됩니다.`;
    document.getElementById('backupAudioWarn').hidden = !info.customAudio;
  } catch { /* 서버와 잠깐 끊겨도 탭의 나머지 안내는 그대로 쓸 수 있다 */ }
}

// ---------------- TCP 추론 소스 ----------------
// mode 'client' = VMS가 소스로 접속(Jetson 보드 기본) / 'server' = VMS가 포트를 열고 소스의 접속을 대기(윈도우 추론 프로그램)
function modeOf(conn) {
  return conn.mode === 'server' ? 'server' : 'client';
}

function renderTcpTable() {
  if (!state.config) return;
  tcpBody.innerHTML = '';
  for (const conn of state.config.tcpConnections) {
    const mode = modeOf(conn);
    const tr = document.createElement('tr');
    const status = state.tcpStatus[conn.id] || 'disconnected';
    const peers = state.tcpPeers[conn.id] || 0;
    tr.innerHTML = `
      <td data-status-conn="${escapeAttr(conn.id)}"><span class="dot ${status}"></span>${statusLabel(status, mode, peers)}</td>
      <td><input type="text" value="${escapeAttr(conn.label)}" data-f="label"/></td>
      <td>
        <select data-f="mode" style="width:110px">
          <option value="client" ${mode === 'client' ? 'selected' : ''}>접속 (VMS→소스)</option>
          <option value="server" ${mode === 'server' ? 'selected' : ''}>수신 대기 (소스→VMS)</option>
        </select>
      </td>
      <td><input type="text" value="${escapeAttr(conn.ip)}" data-f="ip" style="width:110px"
                 title="${mode === 'server' ? '수신 대기할 바인딩 주소 (0.0.0.0 = 모든 네트워크 카드)' : '접속할 소스의 IP'}"/></td>
      <td><input type="number" value="${conn.port}" data-f="port" style="width:70px"/></td>
      <td>${pairedSelectHtml(conn)}</td>
      <td>${mode === 'server'
        ? '<span class="hint">해당없음</span>'
        : `<input type="checkbox" ${conn.autoReconnect ? 'checked' : ''} data-f="autoReconnect"/>`}</td>
      <td><input type="checkbox" ${conn.enabled !== false ? 'checked' : ''} data-f="enabled"/></td>
      <td><button data-act="del">삭제</button></td>`;
    tr.querySelectorAll('input, select').forEach((input) => {
      input.addEventListener('change', () => {
        const f = input.dataset.f;
        const val = input.type === 'checkbox' ? input.checked : (f === 'port' ? Number(input.value) : input.value);
        const patch = { [f]: val };
        // 접속 → 수신 대기로 바꾸면 기존 IP는 "접속 대상 주소"라서 바인딩 주소로는 의미가 없다.
        // 모든 네트워크 카드에서 받도록 0.0.0.0으로 되돌린다(필요하면 사용자가 특정 NIC 주소로 수정).
        if (f === 'mode' && val === 'server' && mode === 'client') patch.ip = '0.0.0.0';
        api.updateTcpConnection(conn.id, patch).catch((e) => { alert(e.message); renderTcpTable(); });
      });
    });
    tr.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`"${conn.label}" 소스를 삭제할까요?`)) return;
      await api.deleteTcpConnection(conn.id);
    };
    tcpBody.appendChild(tr);
  }

  // 추가 행
  const addTr = document.createElement('tr');
  addTr.innerHTML = `
    <td>-</td>
    <td><input type="text" placeholder="라벨" id="newTcpLabel" style="width:90px"/></td>
    <td>
      <select id="newTcpMode" style="width:110px">
        <option value="client">접속 (VMS→소스)</option>
        <option value="server">수신 대기 (소스→VMS)</option>
      </select>
    </td>
    <td><input type="text" placeholder="192.168.30.110" id="newTcpIp" style="width:110px"/></td>
    <td><input type="number" placeholder="7070" id="newTcpPort" style="width:70px"/></td>
    <td>-</td><td>-</td><td>-</td>
    <td><button id="newTcpSubmit">추가</button></td>`;
  tcpBody.appendChild(addTr);

  const modeSel = document.getElementById('newTcpMode');
  const ipInput = document.getElementById('newTcpIp');
  const portInput = document.getElementById('newTcpPort');
  modeSel.addEventListener('change', () => {
    const server = modeSel.value === 'server';
    ipInput.placeholder = server ? '0.0.0.0' : '192.168.30.110';
    portInput.placeholder = server ? '7100' : '7070';
  });
  document.getElementById('newTcpSubmit').onclick = async () => {
    const mode = modeSel.value;
    const ip = ipInput.value.trim() || (mode === 'server' ? '0.0.0.0' : '');
    const port = Number(portInput.value);
    const label = document.getElementById('newTcpLabel').value.trim();
    if (!port) return alert('Port를 입력하세요.');
    if (mode === 'client' && !ip) return alert('접속 모드에서는 IP를 입력하세요.');
    await api.addTcpConnection({ mode, ip, port, label }).catch((e) => alert(e.message));
  };
}

/**
 * "번호 기준" — 이 소스가 보내는 카메라 번호를 어느 소스의 번호로 볼지.
 * 유속 서비스처럼 AI W-Guard와 같은 번호(3, 4…)를 쓰는 보조 소스를 AI W-Guard 채널에 붙일 때 고른다.
 * 기준 소스로 쓰이고 있는 소스, 이미 다른 소스를 따르는 소스는 목록에서 뺀다(서버도 같은 규칙으로 막는다).
 */
function pairedSelectHtml(conn) {
  const all = state.config.tcpConnections;
  const usedAsBase = all.some((c) => c.pairedSourceId === conn.id);
  // 열 제목이 "번호 기준"이라 선택지는 소스 이름만 보여준다(좁은 칸에서 "…번호"가 잘려 보이지 않도록).
  const opts = [`<option value="" ${!conn.pairedSourceId ? 'selected' : ''}>자체</option>`];
  for (const c of all) {
    if (c.id === conn.id || c.pairedSourceId) continue;
    opts.push(`<option value="${escapeAttr(c.id)}" ${conn.pairedSourceId === c.id ? 'selected' : ''}>${escapeAttr(c.label)}</option>`);
  }
  const title = usedAsBase
    ? '다른 소스가 이 소스의 번호를 따르고 있어 바꿀 수 없습니다.'
    : '이 소스의 카메라 번호를 어느 소스의 번호로 볼지 (유속 서비스 → AI W-Guard 번호)';
  return `<select data-f="pairedSourceId" style="width:112px" title="${escapeAttr(title)}" ${usedAsBase ? 'disabled' : ''}>${opts.join('')}</select>`;
}

function statusLabel(s, mode, peers) {
  if (s === 'connected' && mode === 'server') return `수신중 (${peers || 1}대)`;
  if (s === 'listening') return '대기중 (접속 없음)';
  return { connected: '연결됨', connecting: '연결중', disconnected: '끊김', error: '오류' }[s] || s;
}

/** TCP 표에서 해당 소스의 "상태" 칸만 갱신한다 (표를 다시 그리지 않는다). */
function updateTcpStatusCell(connId) {
  const conn = state.config?.tcpConnections.find((c) => c.id === connId);
  const td = tcpBody.querySelector(`[data-status-conn="${CSS.escape(connId)}"]`);
  if (!conn || !td) return;
  const status = state.tcpStatus[connId] || 'disconnected';
  td.innerHTML = `<span class="dot ${status}"></span>${statusLabel(status, modeOf(conn), state.tcpPeers[connId] || 0)}`;
}

// ---------------- 채널 ----------------
const MAX_CHANNELS = 128; // 서버 server/config/store.js의 MAX_CHANNELS와 같은 값이어야 한다

function renderChannelTable() {
  if (!state.config) return;
  const channels = state.config.channels;
  // 이미 지워진 채널이 선택 목록에 남아 있으면 "선택 삭제"가 헛돈다 — 있는 것만 남긴다.
  for (const id of [...selectedChannelIds]) {
    if (!channels.some((c) => c.id === id)) selectedChannelIds.delete(id);
  }

  // 다른 설정이 바뀌어 표를 다시 그리는 동안 입력 중이던 "추가" 줄이 날아가지 않도록 먼저 담아 둔다.
  const draft = addRowIntent === 'reset' ? null : readAddRowDraft();

  chBody.innerHTML = '';
  channels.forEach((ch, idx) => {
    const tr = document.createElement('tr');
    const selected = selectedChannelIds.has(ch.id);
    if (selected) tr.className = 'row-selected';
    tr.innerHTML = `
      <td class="col-sel"><input type="checkbox" data-sel-id="${escapeAttr(ch.id)}" ${selected ? 'checked' : ''} title="선택 (Shift+클릭 = 범위 선택)"/></td>
      <td><input type="checkbox" ${ch.enabled !== false ? 'checked' : ''} data-f="enabled"/></td>
      <td><input type="text" value="${escapeAttr(ch.title)}" data-f="title"/></td>
      <td>${escapeAttr(ch.channelId)}</td>
      <td>
        <input type="text" value="${escapeAttr(ch.camId ?? '')}" data-f="camId" placeholder="예: 1" style="width:60px"/>
        <span class="recv-badge" data-recv-ch="${escapeAttr(ch.channelId)}"></span>
      </td>
      <td>${sourceSelectHtml(ch.sourceId, 'sourceId')}</td>
      <td><input type="text" value="${escapeAttr(ch.rtspUrl || '')}" data-f="rtspUrl" placeholder="rtsp://..."/></td>
      <td>-</td>
      <td><button data-act="del" title="이 채널만 삭제">삭제</button></td>`;
    tr.querySelectorAll('input[data-f], select[data-f]').forEach((input) => {
      input.addEventListener('change', () => {
        const f = input.dataset.f;
        const val = input.type === 'checkbox' ? input.checked : input.value;
        api.updateChannel(ch.id, { [f]: val }).catch((e) => alert(e.message));
      });
    });
    tr.querySelector('[data-sel-id]').addEventListener('click', (e) => onSelectClick(e, idx));
    tr.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`"${ch.title}" 채널과 관련 ROI를 모두 삭제할까요?`)) return;
      await api.deleteChannel(ch.id).catch((e) => alert(e.message));
    };
    chBody.appendChild(tr);
  });

  const addTr = document.createElement('tr');
  addTr.className = 'add-row';
  addTr.innerHTML = `
    <td class="col-sel">＋</td>
    <td><input type="checkbox" id="newChEnabled" checked/></td>
    <td><input type="text" id="newChTitle" placeholder="채널명"/></td>
    <td><input type="text" id="newChId" placeholder="자동생성" style="width:80px"/></td>
    <td><input type="text" id="newChCamId" placeholder="예: 1" style="width:60px"/></td>
    <td>${sourceSelectHtml(null, null, 'newChSourceId')}</td>
    <td><input type="text" id="newChRtsp" placeholder="rtsp://..."/></td>
    <td>-</td>
    <td><button id="newChSubmit">추가</button></td>`;
  chBody.appendChild(addTr);
  document.getElementById('newChSubmit').onclick = submitNewChannel;
  // 한 칸씩 채우고 마우스로 버튼까지 가는 것이 번거로우므로 어느 칸에서든 Enter로 추가된다.
  addTr.querySelectorAll('input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      submitNewChannel();
    });
  });

  // 표를 새로 그렸으니 수신 표시가 비어 있다 — 다음 폴링(최대 2초)까지 기다리지 않고 바로 복원한다.
  updateRecvBadges(lastReceiving);
  applyAddRowDraft(draft);
  renderBulkSourceSelect();
  updateSelectionUi();

  if (addRowIntent) {
    document.getElementById('newChTitle')?.focus();
    addRowIntent = null;
  }
}

const ADD_ROW_FIELDS = ['newChTitle', 'newChId', 'newChCamId', 'newChRtsp'];

/** "추가" 줄에 입력해 둔 값과 커서 위치를 담아 둔다(표를 다시 그려도 잃지 않도록). */
function readAddRowDraft() {
  if (!document.getElementById('newChTitle')) return null; // 아직 한 번도 안 그린 상태
  const values = {};
  for (const id of ADD_ROW_FIELDS) values[id] = document.getElementById(id).value;
  const focusId = ADD_ROW_FIELDS.includes(document.activeElement?.id) ? document.activeElement.id : null;
  return {
    values,
    enabled: document.getElementById('newChEnabled').checked,
    sourceId: document.getElementById('newChSourceId').value,
    focusId,
    caret: focusId ? document.getElementById(focusId).selectionStart : null
  };
}

function applyAddRowDraft(draft) {
  if (!draft) return;
  for (const id of ADD_ROW_FIELDS) document.getElementById(id).value = draft.values[id];
  document.getElementById('newChEnabled').checked = draft.enabled;
  const sel = document.getElementById('newChSourceId');
  // 그 사이에 소스가 삭제됐을 수 있으므로 아직 있는 값일 때만 되돌린다.
  if ([...sel.options].some((o) => o.value === draft.sourceId)) sel.value = draft.sourceId;
  if (!draft.focusId) return;
  const el = document.getElementById(draft.focusId);
  el.focus();
  try { el.setSelectionRange(draft.caret, draft.caret); } catch { /* 캐럿 복원 실패는 무시 */ }
}

async function submitNewChannel() {
  const title = document.getElementById('newChTitle').value.trim();
  const rtspUrl = document.getElementById('newChRtsp').value.trim();
  const channelId = document.getElementById('newChId').value.trim() || undefined;
  const camId = document.getElementById('newChCamId').value.trim() || undefined;
  const sourceId = document.getElementById('newChSourceId').value || undefined;
  const enabled = document.getElementById('newChEnabled').checked;
  if (!title || !rtspUrl) return alert('채널명과 RTSP 주소를 입력하세요.');
  if (state.config.channels.length >= MAX_CHANNELS) return alert(`채널은 최대 ${MAX_CHANNELS}개까지 등록할 수 있습니다.`);
  // 여러 개를 연달아 넣는 경우가 많으므로, 추가되면 입력칸을 비우고 채널명 칸으로 커서를 돌려준다.
  // 서버의 변경 알림(표 다시 그리기)이 응답보다 먼저 오는 경우가 많아 요청 전에 미리 정해 둔다.
  addRowIntent = 'reset';
  try {
    await api.addChannel({ title, rtspUrl, channelId, camId, sourceId, enabled });
  } catch (e) {
    addRowIntent = null; // 실패했으면 입력한 값을 지우지 않는다
    alert(e.message);
  }
}

/** 행 선택 체크박스 클릭. Shift를 누른 채 누르면 직전에 누른 행부터 여기까지를 같은 상태로 만든다. */
function onSelectClick(e, idx) {
  const box = e.currentTarget;
  const on = box.checked;
  const from = e.shiftKey && lastSelIndex !== null ? lastSelIndex : idx;
  const [lo, hi] = from <= idx ? [from, idx] : [idx, from];
  const channels = state.config.channels;
  for (let i = lo; i <= hi; i += 1) {
    const ch = channels[i];
    if (!ch) continue;
    if (on) selectedChannelIds.add(ch.id); else selectedChannelIds.delete(ch.id);
  }
  lastSelIndex = idx;
  syncSelectionMarks();
  updateSelectionUi();
}

/** 선택 상태를 표의 체크박스/행 색에 반영한다 (표를 다시 그리지 않는다 — 입력 중인 칸을 지키기 위해). */
function syncSelectionMarks() {
  for (const box of chBody.querySelectorAll('[data-sel-id]')) {
    const on = selectedChannelIds.has(box.dataset.selId);
    box.checked = on;
    box.closest('tr')?.classList.toggle('row-selected', on);
  }
}

/** 선택 개수에 따라 도구 모음 버튼과 "전체 선택" 체크박스 상태를 갱신한다. */
function updateSelectionUi() {
  const total = state.config?.channels.length || 0;
  const n = selectedChannelIds.size;
  const countEl = document.getElementById('chCount');
  if (countEl) countEl.textContent = `채널 ${total} / ${MAX_CHANNELS}개${n ? ` · ${n}개 선택됨` : ''}`;

  const del = document.getElementById('btnBulkDelete');
  del.disabled = n === 0;
  del.textContent = n ? `선택 삭제 (${n})` : '선택 삭제';
  document.getElementById('btnBulkEnable').disabled = n === 0;
  document.getElementById('btnBulkDisable').disabled = n === 0;

  const all = document.getElementById('chSelectAll');
  all.checked = total > 0 && n === total;
  all.indeterminate = n > 0 && n < total;
}

function wireChannelTab() {
  document.getElementById('chSelectAll').addEventListener('change', (e) => {
    selectedChannelIds.clear();
    if (e.target.checked) for (const ch of state.config.channels) selectedChannelIds.add(ch.id);
    lastSelIndex = null;
    syncSelectionMarks();
    updateSelectionUi();
  });

  document.getElementById('btnBulkDelete').onclick = async () => {
    const targets = state.config.channels.filter((c) => selectedChannelIds.has(c.id));
    if (targets.length === 0) return;
    const names = targets.slice(0, 10).map((c) => `· ${c.title}`).join('\n');
    const more = targets.length > 10 ? `\n... 외 ${targets.length - 10}개` : '';
    if (!confirm(`선택한 ${targets.length}개 채널과 각 채널의 ROI를 모두 삭제할까요? 되돌릴 수 없습니다.\n\n${names}${more}`)) return;
    try {
      await api.deleteChannelsBulk(targets.map((c) => c.id));
      selectedChannelIds.clear();
      lastSelIndex = null;
    } catch (e) {
      alert(e.message);
    }
  };

  document.getElementById('btnBulkEnable').onclick = () => bulkSetEnabled(true);
  document.getElementById('btnBulkDisable').onclick = () => bulkSetEnabled(false);

  // 전체 삭제는 되돌릴 수 없고 ROI까지 함께 사라지므로, 버튼 한 번으로는 실행하지 않고 "삭제"를 직접 입력받는다.
  document.getElementById('btnDeleteAllChannels').onclick = async () => {
    const all = state.config.channels;
    if (all.length === 0) return alert('등록된 채널이 없습니다.');
    const answer = prompt(
      `전체 ${all.length}개 채널과 각 채널의 ROI가 모두 삭제되고 화면 배치에서도 내려갑니다. 되돌릴 수 없습니다.\n` +
      '정말 삭제하려면 아래에 삭제 라고 입력하세요.');
    if (answer === null) return;
    if (answer.trim() !== '삭제') return alert('입력이 "삭제"와 달라 취소했습니다.');
    try {
      await api.deleteChannelsBulk(all.map((c) => c.id));
      selectedChannelIds.clear();
      lastSelIndex = null;
    } catch (e) {
      alert(e.message);
    }
  };

  wireBulkAddBox();
}

async function bulkSetEnabled(enabled) {
  const ids = [...selectedChannelIds];
  if (ids.length === 0) return;
  await api.updateChannelsBulk(ids, { enabled }).catch((e) => alert(e.message));
}

// ---------------- 여러 채널 한 번에 추가 ----------------
// 채널 64개를 한 줄씩 추가하는 것은 사실상 불가능에 가까우므로, RTSP 주소 목록을 그대로 붙여넣어
// 한 번에 등록한다. 한 줄이라도 잘못되면 서버가 아무것도 만들지 않으므로 절반만 들어가는 일은 없다.

const bulkEl = {};

function wireBulkAddBox() {
  bulkEl.box = document.getElementById('bulkAddBox');
  bulkEl.text = document.getElementById('bulkAddText');
  bulkEl.preview = document.getElementById('bulkAddPreview');
  bulkEl.submit = document.getElementById('btnBulkAddSubmit');

  document.getElementById('btnBulkAddToggle').onclick = () => {
    const show = bulkEl.box.classList.contains('hidden');
    bulkEl.box.classList.toggle('hidden', !show);
    if (show) {
      updateBulkPreview();
      bulkEl.text.focus();
    }
  };
  document.getElementById('btnBulkAddCancel').onclick = () => bulkEl.box.classList.add('hidden');

  // 이벤트 객체가 statusHtml 자리로 들어가지 않도록 반드시 인자 없이 부른다.
  for (const id of ['bulkAddText', 'bulkTitlePrefix', 'bulkAutoCam', 'bulkCamStart']) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => updateBulkPreview());
    el.addEventListener('change', () => updateBulkPreview());
  }
  bulkEl.submit.onclick = submitBulkAdd;
}

/** 소스 선택칸은 등록된 TCP 소스가 바뀌면 같이 바뀌어야 하지만, 고르던 값은 유지한다. */
function renderBulkSourceSelect() {
  const wrap = document.getElementById('bulkSourceWrap');
  if (!wrap) return;
  const prev = wrap.querySelector('select')?.value || '';
  wrap.innerHTML = sourceSelectHtml(prev || null, null, 'bulkSourceId');
}

/**
 * 붙여넣은 여러 줄을 채널 목록으로 해석한다.
 * 한 줄 = `제목, RTSP주소, cam ID` (쉼표 또는 탭으로 구분). RTSP 주소만 적어도 되며 나머지는 자동으로 채운다.
 * 빈 줄과 `#`으로 시작하는 줄은 건너뛴다.
 */
function parseBulkLines(text, opts) {
  const items = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.replace(/\t/g, ',').split(',').map((s) => s.trim());
    const urlIdx = parts.findIndex((p) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p));
    if (urlIdx < 0) {
      errors.push(`${i + 1}번째 줄: RTSP 주소(rtsp://...)가 없습니다 — "${line}"`);
      return;
    }
    const n = items.length;
    const camGiven = parts.slice(urlIdx + 1).find(Boolean) || '';
    items.push({
      title: parts.slice(0, urlIdx).filter(Boolean).join(', ') || `${opts.titlePrefix}${opts.titleStart + n}`,
      rtspUrl: parts[urlIdx],
      camId: camGiven || (opts.autoCam ? String(opts.camStart + n) : ''),
      sourceId: opts.sourceId || undefined,
      enabled: true
    });
  });
  return { items, errors };
}

function readBulkOptions() {
  const already = state.config?.channels.length || 0;
  return {
    titlePrefix: document.getElementById('bulkTitlePrefix').value.trim() || '채널',
    titleStart: already + 1,
    autoCam: document.getElementById('bulkAutoCam').checked,
    camStart: Number(document.getElementById('bulkCamStart').value) || 0,
    sourceId: document.getElementById('bulkSourceId')?.value || ''
  };
}

function updateBulkPreview(statusHtml) {
  const { items, errors } = parseBulkLines(bulkEl.text.value, readBulkOptions());
  const room = MAX_CHANNELS - (state.config?.channels.length || 0);
  const over = items.length > room;
  const rows = [];

  if (statusHtml) rows.push(statusHtml);
  for (const e of errors) rows.push(`<div class="err">✗ ${escapeAttr(e)}</div>`);
  if (over) rows.push(`<div class="err">✗ 남은 자리가 ${room}개뿐인데 ${items.length}개를 추가하려고 합니다.</div>`);

  if (items.length > 0) {
    const sample = items.slice(0, 3)
      .map((it) => `${escapeAttr(it.title)} · cam ${escapeAttr(it.camId || '(없음)')} · ${escapeAttr(it.rtspUrl)}`)
      .join('<br/>');
    const more = items.length > 3 ? `<br/>... 외 ${items.length - 3}개` : '';
    rows.push(`<div class="${errors.length || over ? '' : 'ok'}">${items.length}개 채널을 추가합니다:<br/>${sample}${more}</div>`);
  } else if (errors.length === 0 && !statusHtml) {
    rows.push('<div>RTSP 주소를 한 줄에 하나씩 붙여넣으세요.</div>');
  }

  bulkEl.preview.innerHTML = rows.join('');
  bulkEl.submit.disabled = items.length === 0 || errors.length > 0 || over;
}

async function submitBulkAdd() {
  const { items, errors } = parseBulkLines(bulkEl.text.value, readBulkOptions());
  if (items.length === 0 || errors.length > 0) return;
  bulkEl.submit.disabled = true;
  try {
    const r = await api.addChannelsBulk(items);
    bulkEl.text.value = '';
    updateBulkPreview(`<div class="ok">✓ ${r.created}개 채널을 추가했습니다.</div>`);
  } catch (e) {
    updateBulkPreview(`<div class="err">✗ ${escapeAttr(e.message)}</div>`);
  }
}

// ---------------- 실시간 수신 현황 (cam ID 설정 대조) ----------------
// cam ID가 소스가 보내는 번호와 어긋나면 좌표가 조용히 버려지기만 해서 원인을 찾기가 매우 어렵다.
// (실제 사례: AI W-Guard는 화면 이름이 T5~T8이어도 채널 번호는 1~4로 보낸다.)
// 그래서 "지금 실제로 들어오는 번호"를 그대로 보여주고, 어느 채널로도 안 가는 번호는 경고한다.

function startCamPolling() {
  stopCamPolling();
  pollObservedCams();
  camPollTimer = setInterval(pollObservedCams, 2000);
}

function stopCamPolling() {
  if (camPollTimer) clearInterval(camPollTimer);
  camPollTimer = null;
}

async function pollObservedCams() {
  try {
    renderCamRecv(await api.getObservedCams());
  } catch {
    // 서버가 잠깐 응답 못 하는 것뿐일 수 있으니 화면을 지우지 않고 다음 주기를 기다린다.
  }
}

function renderCamRecv(data) {
  const box = document.getElementById('camRecvStatus');
  if (!box) return;
  const body = box.querySelector('.recv-body');
  const sources = data?.sources || {};
  const receiving = new Set(); // 지금 좌표가 실제로 들어오고 있는 channelId
  const unmatched = [];
  const rows = [];

  for (const [connId, src] of Object.entries(sources)) {
    const chips = src.cams.map((c) => {
      // 유속 격자는 물 탐지 좌표와 다른 데이터라 칩에 표시해 둔다(같은 채널로 둘 다 들어오는 게 정상).
      const kind = c.kind === 'flow' ? '유속 ' : '';
      if (c.matchedChannelId) {
        // "● 수신중" 배지는 물 탐지 좌표 기준이다 — 유속만 들어오는 채널을 "좌표 수신중"으로 보이게 하지 않는다.
        if (c.kind !== 'flow') receiving.add(c.matchedChannelId);
        return `<span class="cam-chip ok" title="${escapeAttr(chipTooltip(c))}">${kind}cam ${escapeAttr(c.cam)}${camTitle(c)} → ${escapeAttr(c.matchedTitle)}</span>`;
      }
      unmatched.push({ connId, label: src.label, cam: c.cam, kind: c.kind });
      return `<span class="cam-chip warn" title="${escapeAttr(chipTooltip(c))}">${kind}cam ${escapeAttr(c.cam)}${camTitle(c)} → 매핑된 채널 없음</span>`;
    });
    rows.push(`<div class="recv-row">
      <span class="recv-src">${escapeAttr(src.label || connId)}</span>
      ${chips.join('') || '<span class="hint">수신 중인 좌표 없음</span>'}
    </div>`);
  }

  if (rows.length === 0) rows.push('<div class="recv-row"><span class="hint">등록된 추론 소스가 없습니다.</span></div>');

  if (unmatched.length > 0) {
    const list = unmatched.map((u) => `"${escapeAttr(u.label)}"의 cam ${escapeAttr(u.cam)}`).join(', ');
    rows.push(`<div class="recv-warn">⚠ ${list} 번 좌표가 들어오고 있지만 받을 채널이 없어 버려지고 있습니다.
      아래 표에서 해당 채널의 "cam ID"를 이 번호로 맞추고 "소스"를 그 소스로 지정하세요.</div>`);
    if (unmatched.some((u) => u.kind === 'flow')) {
      rows.push(`<div class="recv-warn">⚠ 유속 서비스의 번호는 보통 AI W-Guard 채널 번호와 같습니다 —
        "TCP 연결" 탭에서 유속 소스의 "번호 기준"을 AI W-Guard 소스로 지정하면 해당 채널에 붙습니다.</div>`);
    }
  }

  body.innerHTML = rows.join('');
  lastReceiving = receiving;
  updateRecvBadges(receiving);
}

function camTitle(c) {
  return c.title ? ` <span class="hint">"${escapeAttr(c.title)}"</span>` : '';
}

function chipTooltip(c) {
  const parts = [`마지막 수신: ${Math.round((c.ageMs || 0) / 1000)}초 전`, `누적 ${c.count}프레임`];
  if (c.frameIdx != null) parts.push(`프레임 번호 ${c.frameIdx}`);
  parts.push(c.kind === 'flow' ? '유속 격자' : `폴리곤 ${c.polygons}개`);
  return parts.join(' · ');
}

/**
 * 채널 표의 cam ID 칸 옆 수신 표시만 갱신한다.
 * 표 전체를 다시 그리면 입력 중이던 칸의 포커스와 커서가 날아가므로 절대 재렌더링하지 않는다.
 */
function updateRecvBadges(receiving) {
  for (const el of chBody.querySelectorAll('[data-recv-ch]')) {
    const on = receiving.has(el.dataset.recvCh);
    el.className = `recv-badge ${on ? 'ok' : 'off'}`;
    el.textContent = on ? '● 수신중' : '○ 수신없음';
    el.title = on
      ? '이 cam ID로 좌표가 실제로 들어오고 있습니다.'
      : '이 cam ID로 들어오는 좌표가 없습니다. 위 "실시간 수신 현황"의 번호와 대조해 보세요.';
  }
}

/** 채널이 받을 추론 소스 선택 (빈 값 = 모든 소스). 등록된 TCP 소스 목록에서 고른다. */
function sourceSelectHtml(selectedId, dataField, id) {
  const opts = [`<option value="" ${!selectedId ? 'selected' : ''}>모든 소스</option>`];
  for (const conn of state.config.tcpConnections) {
    opts.push(`<option value="${escapeAttr(conn.id)}" ${selectedId === conn.id ? 'selected' : ''}>${escapeAttr(conn.label)}</option>`);
  }
  // 이미 삭제된 소스를 가리키고 있으면 값이 조용히 사라지지 않도록 표시해 준다.
  if (selectedId && !state.config.tcpConnections.some((c) => c.id === selectedId)) {
    opts.push(`<option value="${escapeAttr(selectedId)}" selected>(삭제된 소스)</option>`);
  }
  const attrs = [dataField ? `data-f="${dataField}"` : '', id ? `id="${id}"` : ''].filter(Boolean).join(' ');
  return `<select ${attrs} style="width:120px">${opts.join('')}</select>`;
}

// ---------------- 알람 ----------------
function wireAlarmTab() {
  document.getElementById('btnSaveAlarm').onclick = async () => {
    const data = {
      sirenEnabled: document.getElementById('cfgSirenEnabled').checked,
      ttsEnabled: document.getElementById('cfgTtsEnabled').checked,
      volume: Number(document.getElementById('cfgVolume').value),
      repeatIntervalSec: Number(document.getElementById('cfgRepeatInterval').value),
      cooldownSec: Number(document.getElementById('cfgCooldown').value),
      hysteresisPct: Number(document.getElementById('cfgHysteresis').value),
      hysteresisM: Number(document.getElementById('cfgHysteresisM').value),
      hysteresisMps: Number(document.getElementById('cfgHysteresisMps').value),
      levelSmoothSec: Number(document.getElementById('cfgLevelSmoothSec').value),
      flowSmoothSec: Number(document.getElementById('cfgFlowSmoothSec').value),
      defaultLabel: document.getElementById('cfgDefaultLabel').value.trim() || '침수발생',
      repeatPopupMinutes: Number(document.getElementById('cfgRepeatPopupMinutes').value)
    };
    await api.updateAlarmSettings(data).catch((e) => alert(e.message));
  };
  document.getElementById('cfgAudioFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { await api.uploadAlarmAudio(file); } catch (err) { alert(err.message); }
  });
  document.getElementById('btnRemoveAudio').onclick = async () => {
    await api.removeAlarmAudio().catch(() => {});
  };
  document.getElementById('cfgShowDetectionOverlay').addEventListener('change', async (e) => {
    await api.updateDetectionSettings({ showOverlay: e.target.checked }).catch((err) => alert(err.message));
  });
  document.getElementById('cfgShowFlowVectors').addEventListener('change', async (e) => {
    await api.updateFlowSettings({ showVectors: e.target.checked }).catch((err) => alert(err.message));
  });
}
function fillAlarmForm() {
  const a = state.config.alarmSettings;
  document.getElementById('cfgSirenEnabled').checked = a.sirenEnabled !== false;
  document.getElementById('cfgTtsEnabled').checked = a.ttsEnabled !== false;
  document.getElementById('cfgVolume').value = a.volume ?? 0.8;
  document.getElementById('cfgRepeatInterval').value = a.repeatIntervalSec ?? 30;
  document.getElementById('cfgCooldown').value = a.cooldownSec ?? 10;
  document.getElementById('cfgShowDetectionOverlay').checked = !!state.config.detectionSettings?.showOverlay;
  document.getElementById('cfgShowFlowVectors').checked = state.config.flowSettings?.showVectors !== false;
  document.getElementById('cfgHysteresis').value = a.hysteresisPct ?? 5;
  document.getElementById('cfgHysteresisM').value = a.hysteresisM ?? 0.1;
  document.getElementById('cfgHysteresisMps').value = a.hysteresisMps ?? 0.1;
  document.getElementById('cfgLevelSmoothSec').value = a.levelSmoothSec ?? 10;
  document.getElementById('cfgFlowSmoothSec').value = a.flowSmoothSec ?? 10;
  document.getElementById('cfgDefaultLabel').value = a.defaultLabel ?? '침수발생';
  document.getElementById('cfgRepeatPopupMinutes').value = a.repeatPopupMinutes ?? 5;
  document.getElementById('cfgAudioCurrent').textContent = a.customAudioAssetId ? `현재: ${a.customAudioAssetId}` : '(합성음 사용 중)';
}

// ---------------- MediaMTX ----------------
function wireMediamtxTab() {
  document.getElementById('btnSaveMediamtx').onclick = async () => {
    const data = {
      host: document.getElementById('mtxHost').value.trim(),
      apiPort: Number(document.getElementById('mtxApiPort').value),
      whepPort: Number(document.getElementById('mtxWhepPort').value),
      hlsPort: Number(document.getElementById('mtxHlsPort').value)
    };
    await api.updateMediamtxSettings(data).catch((e) => alert(e.message));
  };
}
function fillMediamtxForm() {
  const m = state.config.mediamtx;
  document.getElementById('mtxHost').value = m.host;
  document.getElementById('mtxApiPort').value = m.apiPort;
  document.getElementById('mtxWhepPort').value = m.whepPort;
  document.getElementById('mtxHlsPort').value = m.hlsPort;
}

// ---------------- 화면 테마 ----------------
// 테마 목록(js/theme.js THEMES)으로 카드를 그린다. 카드 안의 작은 화면 모형은 그 테마의 고정 색으로
// 그려지므로(css .tp-<id>) 현재 어떤 테마를 쓰고 있어도 "고르면 이렇게 보인다"를 알 수 있다.
function wireThemeTab() {
  const wrap = document.getElementById('themeCards');
  wrap.innerHTML = THEMES.map((t) => `
    <div class="theme-card" role="radio" tabindex="0" aria-checked="false" data-theme-id="${escapeAttr(t.id)}">
      <div class="tp tp-${escapeAttr(t.id)}" aria-hidden="true">
        <div class="tp-top"><i class="brand"></i><i></i><i class="on"></i><i></i></div>
        <div class="tp-body">
          <div class="tp-side"></div>
          <div class="tp-grid"><b></b><b></b><b></b><b class="alarm"></b></div>
        </div>
      </div>
      <div class="theme-card-name"><span>${escapeAttr(t.icon)} ${escapeAttr(t.name)}</span><span class="theme-card-state"></span></div>
      <div class="theme-card-desc">${escapeAttr(t.desc)}</div>
    </div>`).join('');

  const pick = (target) => {
    const card = target.closest('.theme-card');
    if (card) setTheme(card.dataset.themeId);
  };
  wrap.addEventListener('click', (e) => pick(e.target));
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    pick(e.target);
  });

  // 다른 경로(?theme= 주소 인자 등)로 바뀌어도 카드의 선택 표시가 따라와야 한다
  on('theme:changed', renderThemeCards);
  renderThemeCards();
}

function renderThemeCards() {
  const cur = getTheme();
  for (const card of document.querySelectorAll('#themeCards .theme-card')) {
    const selected = card.dataset.themeId === cur;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-checked', String(selected));
    card.querySelector('.theme-card-state').textContent = selected ? '✓ 사용 중' : '';
  }
}

// 속성값과 본문 텍스트 양쪽에 쓰이므로 &, <, > 까지 모두 이스케이프한다.
// (채널 제목이나 소스가 보낸 title에 <, & 가 들어오면 표가 깨지기 때문 — 따옴표만으로는 부족하다.)
// ---------------- Help / 개발자 모드 ----------------
// 버전 숫자를 연속 5번 클릭하면 비밀번호 입력창이 나오고, 서버 확인을 통과해야 개발자 모드가 켜진다.
// 개발자 모드가 켜지면 설정 화면 곳곳의 자세한 설명(.tip)이 보인다.
const VERSION_CLICKS_NEEDED = 5;
const VERSION_CLICK_RESET_MS = 2000; // 이 시간 안에 이어서 눌러야 연속 클릭으로 센다

function wireHelpTab() {
  const versionEl = document.getElementById('helpVersion');
  const unlockBox = document.getElementById('devUnlockBox');
  const pwInput = document.getElementById('devPassword');
  const msgEl = document.getElementById('devUnlockMsg');

  let clicks = 0;
  let clickTimer = null;
  versionEl.onclick = () => {
    if (isDevMode()) return; // 이미 켜져 있으면 열어줄 것이 없다
    clicks += 1;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { clicks = 0; }, VERSION_CLICK_RESET_MS);
    if (clicks < VERSION_CLICKS_NEEDED) return;
    clicks = 0;
    unlockBox.classList.remove('hidden');
    setDevMsg(msgEl, '');
    pwInput.value = '';
    pwInput.focus();
  };

  document.getElementById('btnDevCancel').onclick = () => {
    unlockBox.classList.add('hidden');
    pwInput.value = '';
  };

  const submit = async () => {
    const password = pwInput.value;
    if (!password) return setDevMsg(msgEl, '비밀번호를 입력하세요.', 'error');
    setDevMsg(msgEl, '확인 중...');
    try {
      await api.unlockDevMode(password);
      pwInput.value = '';
      unlockBox.classList.add('hidden');
      setDevMode(true);
      renderDevState();
    } catch (e) {
      // 서버가 내려준 사유를 그대로 보여준다 (틀림 / 시도 횟수 초과 등)
      setDevMsg(msgEl, e.message, 'error');
      pwInput.select();
    }
  };
  document.getElementById('btnDevUnlock').onclick = submit;
  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  document.getElementById('btnDevLock').onclick = () => {
    setDevMode(false);
    renderDevState();
  };

  renderDevState();
  loadAppInfo(versionEl);
}

async function loadAppInfo(versionEl) {
  try {
    const info = await api.getAppInfo();
    versionEl.textContent = `v${info.version}`;
    document.getElementById('helpAppName').textContent = info.name;
  } catch {
    versionEl.textContent = '(확인 실패)';
  }
}

/** 개발자 모드 on/off에 따라 Help 탭의 두 상자를 바꿔 보여준다. */
function renderDevState() {
  applyDevMode();
  const on = isDevMode();
  document.getElementById('devOnBox').classList.toggle('hidden', !on);
  if (on) document.getElementById('devUnlockBox').classList.add('hidden');
}

function setDevMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = `dev-msg ${kind}`;
}

function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
