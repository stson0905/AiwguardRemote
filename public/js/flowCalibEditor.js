// 채널 유속 보정 편집기 — 타일 위에서 "수면 높이"의 기준점 4~8개를 찍고(끌어서 이동), 점마다 실제 좌표(X,Y m)를
// 입력하거나(좌표 방식) 네 변 + 대각선 2개의 줄자 거리를 입력하면(줄자 방식, 점 4개) 그 자리에서 보정을 계산해
// 실제 수면 위 격자(1m 등)를 영상에 겹쳐 그린다. 격자가 수면·둑과 맞는지 눈으로 확인한 뒤 저장한다.
// 계산은 서버와 같은 public/js/homography.js 를 쓰고, 저장할 때 서버가 같은 계산으로 다시 검증한다.
// 상태는 타일별 WeakMap. ROI 편집기(roiEditor.js)와 동시에 열리지 않게 tile.js 가 서로 닫아 준다.
import { api } from './api.js';
import { getVideoContentRect, makeToPixel, pixelToNormalized } from './videoRect.js';
import { computeCalibration, applyH, invertH, MIN_POINTS, MAX_POINTS } from './homography.js';

const editors = new WeakMap();
/** 기준점을 잡을 수 있는 거리(정규화 좌표) */
const GRAB = 0.02;
const TAPE_KEYS = [
  ['d12', 'P1–P2'], ['d23', 'P2–P3'], ['d34', 'P3–P4'], ['d41', 'P4–P1'], ['d13', 'P1–P3 (대각)'], ['d24', 'P2–P4 (대각)']
];
const GRID_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
/** 라디오 그룹 이름은 문서 전체에서 유일해야 한다(여러 타일에서 동시에 열면 서로 선택이 풀린다) */
let formSeq = 0;

export function isActive(tile) {
  return editors.has(tile);
}

export function begin(tile) {
  if (!tile.channel) return;
  cancel(tile);
  const saved = tile.channel.flowCalib;
  const tape = saved?.method === 'tape';
  const ed = {
    method: tape ? 'tape' : 'coords',
    // 줄자 방식으로 저장된 좌표는 거리에서 계산된 값이라, 편집 화면에서는 좌표 칸을 비워 두고 거리 칸을 채운다.
    points: (saved?.points || []).map((p) => ({ ix: p.ix, iy: p.iy, X: tape ? '' : p.X, Y: tape ? '' : p.Y })),
    distances: Object.fromEntries(TAPE_KEYS.map(([k]) => [k, saved?.distances?.[k] ?? ''])),
    dragIndex: null,
    formEl: null,
    formRight: false,
    preview: null,
    error: null
  };
  editors.set(tile, ed);
  tile.videoWrap.classList.add('roi-edit'); // 캔버스가 마우스를 받게 한다(ROI 편집과 같은 스타일)
  renderForm(tile, ed);
  recompute(tile, ed);
  tile.render();
}

export function cancel(tile) {
  const ed = editors.get(tile);
  if (!ed) return;
  ed.formEl?.remove();
  editors.delete(tile);
  tile.videoWrap.classList.remove('roi-edit');
  tile.canvas.style.cursor = '';
  tile.render();
}

// ---------------- 마우스: 빈 곳을 누르면 점 추가(누른 채 끌어 위치 조정), 점을 누르면 이동 ----------------
function toNormalized(tile, evt) {
  const r = tile.canvas.getBoundingClientRect();
  const rect = getVideoContentRect(tile.videoEl, tile.canvas.width, tile.canvas.height);
  return pixelToNormalized(evt.clientX - r.left, evt.clientY - r.top, rect);
}

function pointAt(ed, [x, y]) {
  let best = -1, bestD = GRAB;
  ed.points.forEach((p, i) => {
    const d = Math.hypot(p.ix - x, p.iy - y);
    if (d < bestD) { best = i; bestD = d; }
  });
  return best;
}

export function handleMouseDown(tile, evt) {
  const ed = editors.get(tile);
  if (!ed || evt.button !== 0) return;
  const pt = toNormalized(tile, evt);
  const idx = pointAt(ed, pt);
  if (idx >= 0) {
    ed.dragIndex = idx;
    return;
  }
  const max = ed.method === 'tape' ? 4 : MAX_POINTS;
  if (ed.points.length >= max) return;
  ed.points.push({ ix: pt[0], iy: pt[1], X: '', Y: '' });
  ed.dragIndex = ed.points.length - 1;
  renderForm(tile, ed);
  recompute(tile, ed);
  tile.render();
}

export function handleMouseMove(tile, evt) {
  const ed = editors.get(tile);
  if (!ed) return;
  const pt = toNormalized(tile, evt);
  if (ed.dragIndex !== null) {
    const p = ed.points[ed.dragIndex];
    p.ix = pt[0];
    p.iy = pt[1];
    recompute(tile, ed);
    tile.render();
    return;
  }
  tile.canvas.style.cursor = pointAt(ed, pt) >= 0 ? 'move' : 'crosshair';
}

export function handleMouseUp(tile) {
  const ed = editors.get(tile);
  if (ed) ed.dragIndex = null;
}

// ---------------- 계산 / 상태 표시 ----------------
function recompute(tile, ed) {
  ed.preview = null;
  ed.error = null;
  if (ed.points.length < MIN_POINTS) {
    setStatus(ed, 'info', `기준점 ${ed.points.length}/${MIN_POINTS} — 화면에서 수면 높이의 점을 더 찍으세요.`);
    return;
  }
  try {
    ed.preview = computeCalibration(buildInput(ed));
  } catch (e) {
    ed.error = e.message;
    setStatus(ed, 'err', e.message);
    return;
  }
  const c = ed.preview;
  const parts = ['✔ 계산됨'];
  if (c.rmsM != null) parts.push(`검산 오차 평균 ${c.rmsM}m / 최대 ${c.maxM}m`);
  if (c.mismatchM != null) parts.push(`줄자 검산 차이 ${c.mismatchM}m`);
  setStatus(ed, c.warnings.length ? 'warn' : 'ok', [parts.join(' · '), ...c.warnings.map((w) => '⚠ ' + w)].join('<br/>'));
}

function buildInput(ed) {
  return {
    method: ed.method,
    points: ed.points.map((p) => ({ ix: p.ix, iy: p.iy, X: p.X, Y: p.Y })),
    distances: ed.method === 'tape' ? ed.distances : undefined
  };
}

function setStatus(ed, kind, html) {
  const el = ed.formEl?.querySelector('.fc-status');
  if (!el) return;
  el.className = `fc-status ${kind}`;
  el.innerHTML = html;
}

// ---------------- 입력 폼 ----------------
function renderForm(tile, ed) {
  if (!ed.formEl) {
    ed.formEl = document.createElement('div');
    ed.formEl.className = 'roi-edit-form flow-calib-form';
    tile.videoWrap.appendChild(ed.formEl);
  }
  ed.formEl.classList.toggle('fc-right', ed.formRight);
  const coords = ed.method === 'coords';
  const group = `fc-method-${++formSeq}`;
  const rows = ed.points.map((p, i) => `
    <tr>
      <td class="fc-pt">P${i + 1}</td>
      ${coords
        ? `<td><input type="number" step="0.01" data-i="${i}" data-k="X" value="${attr(p.X)}"/></td>
           <td><input type="number" step="0.01" data-i="${i}" data-k="Y" value="${attr(p.Y)}"/></td>`
        : ''}
      <td><button data-del="${i}" title="이 점 삭제">×</button></td>
    </tr>`).join('');
  ed.formEl.innerHTML = `
    <div class="fc-head">
      <b>유속 보정 — ${esc(tile.channel?.title || '')}</b>
      <button data-act="side" title="입력창을 반대쪽으로 옮기기">${ed.formRight ? '◀' : '▶'}</button>
    </div>
    <div class="hint">수면 높이(수위선 근처)의 표식을 화면에서 클릭해 기준점을 찍으세요(${MIN_POINTS}~${MAX_POINTS}개, 끌어서 이동).
      계산되면 실제 수면 위 격자가 영상에 겹쳐 보입니다 — 격자가 수면·둑과 맞는지 확인하세요.</div>
    <div class="roi-mode">
      <label class="roi-mode-opt"><input type="radio" name="${group}" value="coords" ${coords ? 'checked' : ''}/> 좌표 입력</label>
      <label class="roi-mode-opt"><input type="radio" name="${group}" value="tape" ${coords ? '' : 'checked'}/> 줄자 거리(4점)</label>
    </div>
    ${ed.points.length
      ? `<table class="fc-table"><tr><th>점</th>${coords ? '<th>X (m)</th><th>Y (m)</th>' : ''}<th></th></tr>${rows}</table>`
      : '<div class="hint">아직 기준점이 없습니다.</div>'}
    ${coords
      ? '<div class="hint tip">X, Y 는 수면(수평면) 위의 실제 위치(m)입니다. 원점과 방향은 자유(측량 좌표 그대로 가능). 5~6개면 입력 오차를 검산합니다.</div>'
      : `<div class="fc-tape">${TAPE_KEYS.map(([k, label]) => `
          <label>${label} <input type="number" step="0.01" min="0" data-d="${k}" value="${attr(ed.distances[k])}"/> m</label>`).join('')}</div>
         <div class="hint tip">네 점 사이의 거리를 줄자로 재어 입력합니다(네 변 + 대각선 2개). 화면의 실선이 변, 점선이 대각선입니다.
           6개 중 하나는 검산에 쓰여, 줄자 값이 서로 맞지 않으면 알려 줍니다.</div>`}
    <div class="fc-status info"></div>
    <div class="btn-row">
      <button data-act="save">저장</button>
      <button data-act="delete" ${tile.channel?.flowCalib ? '' : 'disabled'}>보정 삭제</button>
      <button data-act="close">닫기</button>
    </div>`;

  ed.formEl.querySelectorAll(`input[name=${group}]`).forEach((r) => {
    r.onchange = () => { ed.method = r.value; renderForm(tile, ed); recompute(tile, ed); tile.render(); };
  });
  ed.formEl.querySelectorAll('input[data-k]').forEach((inp) => {
    inp.oninput = () => { ed.points[Number(inp.dataset.i)][inp.dataset.k] = inp.value; recompute(tile, ed); tile.render(); };
  });
  ed.formEl.querySelectorAll('input[data-d]').forEach((inp) => {
    inp.oninput = () => { ed.distances[inp.dataset.d] = inp.value; recompute(tile, ed); tile.render(); };
  });
  ed.formEl.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = () => { ed.points.splice(Number(btn.dataset.del), 1); renderForm(tile, ed); recompute(tile, ed); tile.render(); };
  });
  ed.formEl.querySelector('[data-act=side]').onclick = () => { ed.formRight = !ed.formRight; renderForm(tile, ed); recompute(tile, ed); };
  ed.formEl.querySelector('[data-act=close]').onclick = () => cancel(tile);
  ed.formEl.querySelector('[data-act=delete]').onclick = async () => {
    if (!confirm(`"${tile.channel.title}" 채널의 유속 보정을 삭제할까요? 유속 ROI는 다시 보정할 때까지 m/s 를 계산하지 못합니다.`)) return;
    try {
      await api.deleteFlowCalibration(tile.channel.id);
      cancel(tile);
    } catch (e) {
      alert('보정 삭제 실패: ' + e.message);
    }
  };
  ed.formEl.querySelector('[data-act=save]').onclick = async () => {
    try {
      await api.saveFlowCalibration(tile.channel.id, buildInput(ed));
      cancel(tile);
    } catch (e) {
      alert('유속 보정 저장 실패: ' + e.message);
    }
  };
  // 폼 안의 마우스 조작이 캔버스의 점 추가로 새지 않도록
  ed.formEl.addEventListener('mousedown', (e) => e.stopPropagation());
}

// ---------------- 캔버스 그리기 (tile.renderNow 가 부른다) ----------------
export function drawOverlay(tile, ctx, videoRect) {
  const ed = editors.get(tile);
  if (!ed) return;
  const toPx = makeToPixel(videoRect);
  if (ed.preview) drawWorldGrid(ctx, ed.preview, toPx, videoRect);
  if (ed.method === 'tape' && ed.points.length >= 2) drawTapeLines(ctx, ed, toPx);

  ctx.save();
  ctx.font = 'bold 12px sans-serif';
  ed.points.forEach((p, i) => {
    const [x, y] = toPx([p.ix, p.iy]);
    ctx.fillStyle = ed.error ? '#ff5c5c' : '#ffd23a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const label = `P${i + 1}`;
    ctx.lineWidth = 3;
    ctx.strokeText(label, x + 8, y - 8);
    ctx.fillText(label, x + 8, y - 8);
  });
  ctx.restore();
}

/** 실제 수면 위 격자를 영상에 겹쳐 그린다(보정이 맞으면 격자가 수면에 반듯하게 깔려 보인다). */
function drawWorldGrid(ctx, calib, toPx, rect) {
  const Hinv = invertH(calib.H);
  if (!Hinv) return;
  const xs = calib.points.map((p) => p.X);
  const ys = calib.points.map((p) => p.Y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const step = GRID_STEPS.find((s) => span / s <= 12) ?? GRID_STEPS.at(-1);
  const pad = span * 0.4;
  const x0 = Math.floor((minX - pad) / step) * step, x1 = Math.ceil((maxX + pad) / step) * step;
  const y0 = Math.floor((minY - pad) / step) * step, y1 = Math.ceil((maxY + pad) / step) * step;

  // 수면 위 점 → 영상 점. 지평선 너머(부호가 다른 쪽)나 화면에서 멀리 벗어난 점은 선을 끊는다.
  const toImage = (X, Y) => {
    const [x, y] = applyH(Hinv, X, Y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.2 || x > 1.2 || y < -0.2 || y > 1.2) return null;
    if (Math.sign(applyH(calib.H, x, y)[2]) !== calib.sign) return null;
    return toPx([x, y]);
  };
  const line = (from, to) => {
    const N = 40;
    let prev = null;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const p = toImage(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
      if (p && prev) { ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); }
      prev = p;
    }
  };

  ctx.save();
  ctx.beginPath();
  for (let X = x0; X <= x1 + 1e-9; X += step) line([X, y0], [X, y1]);
  for (let Y = y0; Y <= y1 + 1e-9; Y += step) line([x0, Y], [x1, Y]);
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // 기준점 범위(볼록 껍질) — 이 안이 가장 정확하고, 밖은 외삽이다.
  ctx.beginPath();
  calib.hull.forEach((p, i) => { const [x, y] = toPx(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = 'rgba(255, 210, 58, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
  // 격자 간격 표시는 왼쪽 아래 — 오른쪽 아래는 타일 상태 배지(탐지·침범률)가 덮는다.
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(rect.x + 4, rect.y + rect.h - 22, 114, 18);
  ctx.fillStyle = '#00e5ff';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(`수면 격자 ${step}m 간격`, rect.x + 10, rect.y + rect.h - 9);
  ctx.restore();
}

/** 줄자 방식: 재야 할 변(실선)과 대각선(점선)을 점 사이에 그려 준다. */
function drawTapeLines(ctx, ed, toPx) {
  const P = ed.points.map((p) => toPx([p.ix, p.iy]));
  const seg = (a, b, dashed) => {
    if (!P[a] || !P[b]) return;
    ctx.setLineDash(dashed ? [4, 4] : []);
    ctx.beginPath();
    ctx.moveTo(P[a][0], P[a][1]);
    ctx.lineTo(P[b][0], P[b][1]);
    ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 210, 58, 0.85)';
  ctx.lineWidth = 1.5;
  seg(0, 1); seg(1, 2); seg(2, 3); seg(3, 0);
  seg(0, 2, true); seg(1, 3, true);
  ctx.restore();
}

function attr(v) {
  return v === null || v === undefined ? '' : String(v).replace(/"/g, '&quot;');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
