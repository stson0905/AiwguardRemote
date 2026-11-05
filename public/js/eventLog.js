// 우측 이벤트 로그 패널: 최근 알람 목록 조회/확인(Ack)/CSV 내보내기(링크는 HTML에 고정)
import { on } from './bus.js';
import { api } from './api.js';
import { eventMeasureText, eventThresholdText } from './waterScale.js';

const panelEl = document.getElementById('eventPanel');
const listEl = document.getElementById('eventList');
let items = [];

export function initEventLog() {
  document.getElementById('btnEventLog').onclick = togglePanel;
  document.getElementById('btnCloseEventPanel').onclick = () => panelEl.classList.add('hidden');

  on('ws:alarm', ({ event }) => {
    items.unshift(event);
    if (items.length > 300) items.length = 300;
    render();
  });
  on('ws:event_ack', ({ id }) => {
    const it = items.find((e) => e.id === id);
    if (it) it.ackedAt = Date.now();
    render();
  });
}

async function togglePanel() {
  const willOpen = panelEl.classList.contains('hidden');
  panelEl.classList.toggle('hidden');
  if (willOpen) {
    try {
      items = await api.listEvents(200);
      render();
    } catch { /* 무시 */ }
  }
}

function render() {
  listEl.innerHTML = '';
  for (const evt of items) {
    const li = document.createElement('li');
    if (evt.ackedAt) li.classList.add('acked');
    li.innerHTML = `
      <div class="ev-title">🚨 ${escapeHtml(evt.label || '')} — ${escapeHtml(eventMeasureText(evt))}</div>
      <div class="ev-meta">${escapeHtml(evt.channelTitle || '')} · ${escapeHtml(evt.roiName || '')} · 임계 ${escapeHtml(eventThresholdText(evt))}</div>
      <div class="ev-meta">${new Date(evt.ts).toLocaleString('ko-KR')}</div>
      ${evt.ackedAt ? '<div class="ev-meta">✔ 확인됨</div>' : '<button data-act="ack">확인</button>'}
    `;
    const btn = li.querySelector('[data-act=ack]');
    if (btn) btn.onclick = async () => {
      await api.ackEvent(evt.id).catch(() => {});
      evt.ackedAt = Date.now();
      render();
    };
    listEl.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
