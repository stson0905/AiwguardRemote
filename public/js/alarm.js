// ROI 침범률 임계값 초과 시: 팝업 토스트 표시 + 사이렌/TTS 경고음 반복 재생.
// 브라우저 자동재생 정책 대응을 위해 최초 사용자 클릭("모니터링 시작")으로 AudioContext/TTS를 언락한다.
import { on, emit } from './bus.js';
import { state, setAlarming, pageOfChannel, getActivePage } from './state.js';
import { api } from './api.js';
import * as grid from './grid.js';
import { eventMeasureText, eventThresholdText } from './waterScale.js';

let audioCtx = null;
let unlocked = false;
/** eventId -> { intervalId, trigger, audioEl } */
const activeSirens = new Map();
/** eventId -> toast element */
const toastEls = new Map();

export function initAlarms() {
  document.getElementById('btnUnlock').onclick = unlock;

  on('ws:alarm', ({ event }) => {
    if (setAlarming(event.channelId, event.roiId, true)) emit('alarming:changed');
    onAlarm(event);
  });
  on('ws:alarm_clear', ({ channelId, roiId }) => {
    if (setAlarming(channelId, roiId, false)) emit('alarming:changed');
    onAlarmClear(channelId, roiId);
  });
  on('ws:event_ack', ({ id }) => onAck(id));

  document.getElementById('btnTestAlarm')?.addEventListener('click', () => {
    onAlarm({
      id: 'test_' + Date.now(),
      channelId: null,
      channelTitle: '테스트 채널',
      roiName: '테스트 ROI',
      label: state.config?.alarmSettings?.defaultLabel || '침수발생',
      ratePct: 87.5,
      threshold: 30,
      ts: Date.now()
    }, true);
  });
}

function unlock() {
  if (unlocked) return;
  unlocked = true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch { /* Web Audio 미지원 브라우저 */ }
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch { /* TTS 미지원 브라우저 */ }
  document.getElementById('unlockOverlay').classList.add('hidden');
  for (const entry of activeSirens.values()) entry.trigger();
}

/**
 * 접속/새로고침 시점에 이미 발생해 있던(아직 확인 안 된) 알람들을 팝업으로 되살린다.
 * 서버는 알람을 "발생하는 순간"에만 보내므로, 이게 없으면 침수가 계속되는 중에 화면을 새로 연
 * 사용자에게는 팝업이 하나도 뜨지 않는다. app.js가 config/그리드를 채운 뒤에 호출한다.
 */
export function showActiveAlarms(list) {
  for (const evt of list || []) onAlarm(evt);
}

function onAlarm(evt, isTest = false) {
  const id = evt.id;
  // WebSocket이 끊겼다 붙으면 init(= 진행 중 알람 목록)이 다시 오므로 같은 이벤트가 겹치지 않게 한다.
  if (toastEls.has(id)) return;
  const settings = state.config?.alarmSettings || {};
  const snapshot = !isTest ? grid.captureSnapshot(evt.channelId) : null;

  // 물높이 기준 ROI의 알람은 침범률(%)이 아니라 실제로 읽어낸 수위(m)를 그대로 보여준다.
  const height = evt.mode === 'height';
  const measured = eventMeasureText(evt);

  const toast = document.createElement('div');
  toast.className = 'alarm-toast';
  toast.dataset.channelId = evt.channelId || '';
  toast.dataset.roiId = evt.roiId || '';
  toast.innerHTML = `
    <div class="at-title"><span>🚨 ${escapeHtml(evt.label || '경고')}</span><span>${escapeHtml(measured)}</span></div>
    <div class="at-meta">${escapeHtml(evt.channelTitle || '')} · ${escapeHtml(evt.roiName || '')} · ${new Date(evt.ts).toLocaleTimeString('ko-KR')}</div>
    <div class="at-meta">${height ? '수위' : evt.mode === 'velocity' ? '유속' : '침범률'} <b>${escapeHtml(measured)}</b> (임계 ${escapeHtml(eventThresholdText(evt))})</div>
    ${snapshot ? `<img src="${snapshot}" alt="snapshot"/>` : ''}
    <div class="at-offscreen" hidden></div>
    <div class="at-actions">
      <button data-act="goto" class="at-goto" hidden></button>
      <button data-act="ack">확인</button>
      <button data-act="mute">음소거</button>
    </div>`;
  document.getElementById('alarmToastContainer').prepend(toast);
  toastEls.set(id, toast);

  toast.querySelector('[data-act=ack]').onclick = () => {
    if (!isTest) api.ackEvent(evt.id).catch(() => {});
    stopSiren(id);
    toast.remove();
    toastEls.delete(id);
    if (evt.channelId) grid.clearChannelAlarmFlash(evt.channelId);
  };
  // 누르는 순간의 페이지로 간다(팝업이 뜬 뒤 분할/순서가 바뀌었을 수 있음). 이동 후 안내는 refreshToastLocations가 숨긴다.
  toast.querySelector('[data-act=goto]').onclick = () => emit('page:goto', { channelId: evt.channelId });
  if (!isTest) updateToastLocation(toast);
  toast.querySelector('[data-act=mute]').onclick = (e) => {
    stopSiren(id);
    e.target.disabled = true;
    e.target.textContent = '음소거됨';
  };

  if (evt.channelId) grid.flashChannelAlarm(evt.channelId);
  // 음성 안내에도 수위를 실어 준다 — 화면을 보고 있지 않아도 몇 미터인지 들린다.
  const speech = height && evt.levelM != null
    ? `${evt.label || '침수 발생'}, 수위 ${Number(evt.levelM).toFixed(2)} 미터`
    : evt.mode === 'velocity' && evt.speedMps != null
      ? `${evt.label || '유속 경보'}, 유속 초당 ${Number(evt.speedMps).toFixed(1)} 미터`
      : (evt.label || settings.defaultLabel || '침수 발생');
  startSiren(id, settings, speech);
}

/**
 * 팝업의 "화면N의 채널입니다 / 화면N 보기" 안내를 지금 화면 기준으로 맞춘다. 지금 보고 있는 화면에 있는 채널이면 숨긴다.
 * 팝업이 뜬 뒤 분할·채널 순서·보는 화면이 바뀌면 번호가 달라지므로 그때마다 app.js가 refreshToastLocations()를 부른다
 * (v0.4.3 검증 중 발견: 접속 직후 분할이 바뀌기 전에 만든 팝업이 엉뚱한 화면 번호를 보여줬다).
 */
function updateToastLocation(toast) {
  const channelId = toast.dataset.channelId;
  if (!channelId) return;
  const page = pageOfChannel(channelId);
  const off = page >= 0 && !getActivePage()?.cells.includes(channelId);
  const note = toast.querySelector('.at-offscreen');
  const btn = toast.querySelector('[data-act=goto]');
  note.hidden = btn.hidden = !off;
  if (off) {
    note.innerHTML = `📍 지금 보고 있지 않은 <b>화면${page + 1}</b>의 채널입니다`;
    btn.textContent = `화면${page + 1} 보기`;
  }
}

export function refreshToastLocations() {
  for (const toast of toastEls.values()) updateToastLocation(toast);
}

function onAlarmClear(channelId, roiId) {
  grid.clearChannelAlarmFlash(channelId);
  for (const [id, toast] of toastEls) {
    if (toast.dataset.channelId === channelId && toast.dataset.roiId === roiId) {
      toast.classList.add('cleared');
      stopSiren(id);
      setTimeout(() => { toast.remove(); toastEls.delete(id); }, 5000);
    }
  }
}

function onAck(id) {
  const toast = toastEls.get(id);
  stopSiren(id);
  if (toast) { toast.remove(); toastEls.delete(id); }
}

function startSiren(id, settings, speechText) {
  if (activeSirens.has(id)) return;
  const trigger = () => {
    if (!unlocked) return;
    if (settings.customAudioAssetId) playCustomAudio(settings, entry);
    else if (settings.sirenEnabled !== false) playSirenTone(settings);
    if (settings.ttsEnabled !== false) speak(speechText || settings.defaultLabel || '침수 발생', settings);
  };
  const entry = { trigger, intervalId: null, audioEl: null };
  entry.intervalId = setInterval(trigger, Math.max(2, Number(settings.repeatIntervalSec) || 6) * 1000);
  activeSirens.set(id, entry);
  trigger();
}

function stopSiren(id) {
  const entry = activeSirens.get(id);
  if (!entry) return;
  clearInterval(entry.intervalId);
  if (entry.audioEl) { entry.audioEl.pause(); entry.audioEl.currentTime = 0; }
  activeSirens.delete(id);
}

function playSirenTone(settings) {
  if (!audioCtx) return;
  const dur = 1.2;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, now);
  osc.frequency.linearRampToValueAtTime(1200, now + dur / 2);
  osc.frequency.linearRampToValueAtTime(600, now + dur);
  const vol = Number(settings.volume ?? 0.8);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(Math.max(0.0001, vol * 0.5), now + 0.05);
  gain.gain.linearRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.05);
}

function playCustomAudio(settings, entry) {
  // 반복할 때마다 새 Audio 요소를 만들지 않고 하나를 되감아 다시 튼다 — 안 그러면 파일이 반복 간격보다 길 때
  // 이전 재생 위에 겹쳐 울리고, 알람이 오래 이어지면 요소가 계속 쌓인다.
  if (!entry.audioEl) entry.audioEl = new Audio(`/alarm-assets/${settings.customAudioAssetId}`);
  const audioEl = entry.audioEl;
  audioEl.volume = Number(settings.volume ?? 0.8);
  try { audioEl.currentTime = 0; } catch { /* 아직 로드 전이면 처음부터 재생된다 */ }
  audioEl.play().catch(() => {});
}

function speak(text, settings) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.volume = Number(settings.volume ?? 0.8);
    speechSynthesis.speak(u);
  } catch { /* TTS 미지원 브라우저 */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
