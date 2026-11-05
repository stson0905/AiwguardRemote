// 타일(비디오 캔버스) 위에서 ROI 폴리곤을 그리고 편집하는 로직.
// 상태는 타일 인스턴스별로 WeakMap에 보관한다.
import { api } from './api.js';
import { state, getRoisForChannel } from './state.js';
import { getVideoContentRect, makeToPixel, pixelToNormalized } from './videoRect.js';
import { roiBounds, scaleAnchors, anchorsMissing, yToMeters, formatMeters, formatMps, MIN_ANCHOR_GAP } from './waterScale.js';

const editors = new WeakMap();
/** 라디오 그룹 이름은 문서 전체에서 유일해야 한다 — 타일이 여러 개 열려 있으면 서로 선택이 풀린다. */
let formSeq = 0;
/** 기준선을 잡을 수 있는 세로 여유 (정규화 y) */
const ANCHOR_GRAB = 0.02;
/** 새 물높이 ROI를 만들 때 기준선을 놓는 기본 위치 (ROI 높이의 위/아래 15% 지점) */
const NEW_ANCHOR_INSET = 0.15;

function ensureEditor(tile) {
  let ed = editors.get(tile);
  if (!ed) {
    ed = {
      mode: 'none', points: [], selectedRoiId: null, dragIndex: null, formEl: null, toolbarEl: null,
      // 물높이 모드에서 쓰는 눈금 기준선 2개의 화면 위치(정규화 y). 값(m)은 폼 입력칸에서 읽는다.
      thresholdMode: 'percent', scale: null, dragAnchor: null
    };
    editors.set(tile, ed);
  }
  return ed;
}

// 클릭 좌표(브라우저 픽셀) -> 정규화(0~1) 좌표. 캔버스 전체가 아니라 "영상이 실제로 그려지는 영역"
// (<video>의 object-fit에 따라 다름, videoRect.js 참고) 기준으로 변환해야 확대해도 좌표가 어긋나지 않는다.
function toNormalized(tile, evt) {
  const canvasRect = tile.canvas.getBoundingClientRect();
  const px = evt.clientX - canvasRect.left;
  const py = evt.clientY - canvasRect.top;
  const videoRect = getVideoContentRect(tile.videoEl, tile.canvas.width, tile.canvas.height);
  return pixelToNormalized(px, py, videoRect);
}

export function isEditing(tile) {
  const ed = editors.get(tile);
  return !!ed && ed.mode !== 'none';
}

export function beginDraw(tile) {
  if (!tile.channel) return;
  cancel(tile);
  const ed = ensureEditor(tile);
  ed.mode = 'draw';
  ed.points = [];
  ed.thresholdMode = 'percent';
  ed.scale = null;
  tile.videoWrap.classList.add('roi-edit');
  renderDraftToolbar(tile, ed);
  tile.render();
}

export function selectForEdit(tile, roi) {
  cancel(tile);
  const ed = ensureEditor(tile);
  ed.mode = 'select';
  ed.selectedRoiId = roi.id;
  ed.points = roi.points.map((p) => [...p]);
  ed.thresholdMode = ['height', 'velocity'].includes(roi.thresholdMode) ? roi.thresholdMode : 'percent';
  // 저장된 기준선 위치를 그대로 가져온다. 위치가 없던 예전 ROI는 ROI 경계가 기준선이었으므로
  // 그 자리에서 시작한다 — 화면에 보이는 계산 결과가 저장된 값과 정확히 같아야 하기 때문.
  ed.scale = ed.thresholdMode === 'height' ? anchorsOf(roi.heightScale, ed.points) : null;
  tile.videoWrap.classList.add('roi-edit');
  renderEditForm(tile, ed, roi);
  tile.render();
}

export function cancel(tile) {
  const ed = editors.get(tile);
  if (!ed) return;
  ed.mode = 'none';
  ed.points = [];
  ed.selectedRoiId = null;
  ed.dragIndex = null;
  ed.dragAnchor = null;
  ed.scale = null;
  removeFloating(ed);
  tile.canvas.style.cursor = '';
  tile.videoWrap.classList.remove('roi-edit');
  tile.render();
}

export function handleCanvasClick(tile, evt) {
  const ed = editors.get(tile);
  // 저장 폼이 떠 있으면 클릭으로 정점을 더 추가하지 않는다(기준선을 끌 때 정점이 딸려 찍히는 것 방지).
  if (!ed || ed.mode !== 'draw' || ed.formEl) return;
  ed.points.push(toNormalized(tile, evt));
  renderDraftToolbar(tile, ed);
  tile.render();
}

export function handleCanvasDoubleClick(tile, evt) {
  const ed = editors.get(tile);
  if (!ed || ed.mode !== 'draw' || ed.formEl) return;
  finishDraw(tile, ed);
}

export function handleCanvasMouseDown(tile, evt) {
  const ed = editors.get(tile);
  if (!ed || ed.mode === 'none') return;
  const pt = toNormalized(tile, evt);

  // 정점(작은 점)을 먼저 본다 — 기준선이 ROI 경계에 겹쳐 있을 때 정점 조작이 막히지 않도록.
  if (ed.mode === 'select') {
    const idx = ed.points.findIndex(([x, y]) => Math.hypot(x - pt[0], y - pt[1]) < 0.02);
    ed.dragIndex = idx >= 0 ? idx : null;
    if (idx >= 0) { ed.dragAnchor = null; return; }
  }
  ed.dragAnchor = anchorAt(ed, pt);
}

export function handleCanvasMouseMove(tile, evt) {
  const ed = editors.get(tile);
  if (!ed || ed.mode === 'none') return;
  const pt = toNormalized(tile, evt);

  if (ed.dragAnchor) {
    // 두 기준선이 서로를 넘어가거나 붙어버리지 않게 최소 간격을 유지한다.
    ed.formEl?.querySelector('[data-anchor-warn]')?.remove(); // 기준선을 직접 맞추기 시작했으면 경고는 할 일을 다 했다
    if (ed.dragAnchor === 'top') ed.scale.topY = Math.min(clamp01(pt[1]), ed.scale.bottomY - MIN_ANCHOR_GAP);
    else ed.scale.bottomY = Math.max(clamp01(pt[1]), ed.scale.topY + MIN_ANCHOR_GAP);
    updateLiveReading(tile);
    tile.render();
    return;
  }
  if (ed.mode === 'select' && ed.dragIndex !== null) {
    ed.points[ed.dragIndex] = pt;
    tile.render();
    return;
  }
  tile.canvas.style.cursor = anchorAt(ed, pt) ? 'ns-resize' : '';
}

export function handleCanvasMouseUp(tile) {
  const ed = editors.get(tile);
  if (!ed) return;
  if (ed.dragAnchor) {
    // 기준선은 눈금값과 짝을 이뤄야 의미가 있으므로 자동 저장하지 않는다("저장"을 눌러야 반영).
    ed.dragAnchor = null;
    return;
  }
  if (ed.mode === 'select' && ed.dragIndex !== null) {
    ed.dragIndex = null;
    api.updateRoi(ed.selectedRoiId, { points: ed.points }).catch((e) => alert('ROI 수정 실패: ' + e.message));
  }
}

/** 마우스 위치에서 잡을 수 있는 기준선 ('top' | 'bottom' | null) */
function anchorAt(ed, [mx, my]) {
  if (ed.thresholdMode !== 'height' || !ed.scale || !ed.formEl) return null;
  const b = roiBounds(ed.points);
  if (mx < b.minX - 0.04 || mx > b.maxX + 0.04) return null;
  const dTop = Math.abs(my - ed.scale.topY);
  const dBottom = Math.abs(my - ed.scale.bottomY);
  if (Math.min(dTop, dBottom) > ANCHOR_GRAB) return null;
  return dTop <= dBottom ? 'top' : 'bottom';
}

/** 저장된 heightScale -> 편집용 기준선 위치. 위치가 없으면 ROI 경계(예전 동작)를 그대로 쓴다. */
function anchorsOf(heightScale, points) {
  const b = roiBounds(points);
  const a = scaleAnchors(heightScale || {}, b);
  return { topY: a.topY, bottomY: a.bottomY };
}

/** 새로 물높이 모드로 바꿀 때: 양 끝에서 조금 안쪽에 놓아 바로 눈에 띄고 끌기 쉽게 한다. */
function defaultAnchors(points) {
  const b = roiBounds(points);
  const h = b.maxY - b.minY;
  return { topY: b.minY + h * NEW_ANCHOR_INSET, bottomY: b.maxY - h * NEW_ANCHOR_INSET };
}

function finishDraw(tile, ed) {
  if (ed.points.length < 3) {
    alert('ROI는 최소 3개 이상의 점이 필요합니다. 계속 클릭해 정점을 추가하세요.');
    return;
  }
  renderNewRoiForm(tile, ed);
}

function removeFloating(ed) {
  ed.formEl?.remove();
  ed.toolbarEl?.remove();
  ed.formEl = null;
  ed.toolbarEl = null;
}

function renderDraftToolbar(tile, ed) {
  ed.formEl?.remove();
  ed.formEl = null;
  if (!ed.toolbarEl) {
    ed.toolbarEl = document.createElement('div');
    ed.toolbarEl.className = 'roi-draft-toolbar';
    tile.videoWrap.appendChild(ed.toolbarEl);
  }
  ed.toolbarEl.innerHTML = `
    <div>ROI 그리기 중 (${ed.points.length}점) — 클릭으로 정점 추가</div>
    <div class="btn-row">
      <button data-act="undo">되돌리기</button>
      <button data-act="finish">완료</button>
      <button data-act="cancel">취소</button>
    </div>`;
  ed.toolbarEl.querySelector('[data-act=finish]').onclick = () => finishDraw(tile, ed);
  ed.toolbarEl.querySelector('[data-act=cancel]').onclick = () => cancel(tile);
  ed.toolbarEl.querySelector('[data-act=undo]').onclick = () => {
    ed.points.pop();
    renderDraftToolbar(tile, ed);
    tile.render();
  };
}

/**
 * 타일의 "ROI수정" 버튼 진입점 — 이미 저장된 ROI의 설정
 * (침범률/물높이 임계값, 눈금 기준선, 이름, 알람 라벨)을 고친다.
 * ROI가 하나뿐이면 바로 열고, 여러 개면 어느 것을 고칠지 고르게 한다.
 */
export function beginEdit(tile) {
  if (!tile.channel) return;
  const rois = getRoisForChannel(tile.channel.channelId);
  if (rois.length === 0) return alert('이 채널에는 저장된 ROI가 없습니다. 먼저 ＋ROI로 추가하세요.');
  if (rois.length === 1) return selectForEdit(tile, rois[0]);

  cancel(tile);
  const ed = ensureEditor(tile);
  ed.mode = 'pick';
  tile.videoWrap.classList.add('roi-edit');
  ed.toolbarEl = document.createElement('div');
  ed.toolbarEl.className = 'roi-draft-toolbar';
  tile.videoWrap.appendChild(ed.toolbarEl);
  ed.toolbarEl.innerHTML = `
    <div>수정할 ROI를 고르세요</div>
    <div class="btn-row roi-pick-row">
      ${rois.map((r, i) => `<button data-pick="${i}">${escapeHtml(r.name)} <span class="pick-sub">${escapeHtml(roiSummary(r))}</span></button>`).join('')}
    </div>
    <div class="btn-row"><button data-act="cancel">취소</button></div>`;
  ed.toolbarEl.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.onclick = () => selectForEdit(tile, rois[Number(btn.dataset.pick)]);
  });
  ed.toolbarEl.querySelector('[data-act=cancel]').onclick = () => cancel(tile);
  tile.render();
}

/** 목록에서 ROI를 구분할 수 있게 판정 기준을 한 줄로 요약 */
function roiSummary(roi) {
  if (roi.thresholdMode === 'height') return `물높이 ${formatMeters(roi.thresholdM)}`;
  if (roi.thresholdMode === 'velocity') return `유속 ${formatMps(roi.thresholdMps)}`;
  return `침범률 ${roi.threshold}%`;
}

/**
 * 판정 기준 입력란 (세 모드 공통으로 쓰는 조각).
 *  - 침범률(%): 기존 방식 — ROI 면적이 물로 얼마나 덮였는가
 *  - 물높이(m): 화면에 보이는 눈금 위에 기준선 2개를 놓고, 그 사이 간격으로 수면선을 미터로 환산
 *  - 유속(m/s): 유속 서비스의 광류를 채널 유속 보정(기준점 4개 이상)으로 실제 수면 속도로 환산
 */
function thresholdFieldsHtml(roi, channel) {
  const mode = ['height', 'velocity'].includes(roi?.thresholdMode) ? roi.thresholdMode : 'percent';
  const height = mode === 'height';
  const velocity = mode === 'velocity';
  const group = `f-mode-${++formSeq}`;
  // 보정이 없어도 저장은 된다(현장 측량은 나중에 하는 경우가 많다). 다만 그 사실을 항상 보이게 한다(.tip 아님).
  const calibNote = channel?.flowCalib?.H
    ? `<div class="hint">채널 유속 보정: 기준점 ${channel.flowCalib.points?.length ?? '?'}개${channel.flowCalib.rmsM != null ? ` · 검산 오차 ${channel.flowCalib.rmsM}m` : ''}</div>`
    : '<div class="calib-warn">⚠ 이 채널은 유속 보정이 없어 m/s를 계산할 수 없습니다. 타일의 "유속보정"에서 기준점을 먼저 입력하세요.</div>';
  return `
    <div class="roi-mode">
      <label class="roi-mode-opt"><input type="radio" name="${group}" value="percent" ${mode === 'percent' ? 'checked' : ''}/> 침범률(%)</label>
      <label class="roi-mode-opt"><input type="radio" name="${group}" value="height" ${height ? 'checked' : ''}/> 물높이(m)</label>
      <label class="roi-mode-opt"><input type="radio" name="${group}" value="velocity" ${velocity ? 'checked' : ''}/> 유속(m/s)</label>
    </div>
    <div data-mode-box="percent" ${mode === 'percent' ? '' : 'hidden'}>
      <label>침범 임계값(%) <input type="number" id="f-threshold" value="${roi?.threshold ?? 30}" min="0" max="100"/></label>
    </div>
    <div data-mode-box="velocity" ${velocity ? '' : 'hidden'}>
      <label>임계 유속(m/s) <input type="number" id="f-thresholdMps" step="0.1" min="0" value="${numAttr(roi?.thresholdMps, 1.5)}"/></label>
      <label>현재 유속 <b id="f-live-mps">-</b></label>
      ${calibNote}
      <div class="hint tip">유속 서비스가 보낸 광류 중 믿을 수 있는 칸만 골라, 채널 유속 보정(화면 기준점 ↔ 실제 좌표)으로
        실제 수면 속도로 바꾼 값입니다. 파도로 인한 순간 튐을 줄이려고 알람 설정의 "유속 평활화(초)" 동안의 중앙값으로 판정합니다.</div>
    </div>
    <div data-mode-box="height" ${height ? '' : 'hidden'}>
      ${height && anchorsMissing(roi?.heightScale)
        ? '<div class="calib-warn" data-anchor-warn>⚠ 저장된 기준선 위치가 없어 ROI 위/아래 경계를 기준선으로 계산 중입니다. 연두색 기준선 두 개를 숫자가 보이는 눈금에 끌어 맞추고 저장하세요.</div>'
        : ''}
      <label>상단 기준선 눈금(m) <input type="number" id="f-topM" step="0.1" value="${numAttr(roi?.heightScale?.topM, 1.5)}"/></label>
      <label>하단 기준선 눈금(m) <input type="number" id="f-bottomM" step="0.1" value="${numAttr(roi?.heightScale?.bottomM, 0.5)}"/></label>
      <label>임계 물높이(m) <input type="number" id="f-thresholdM" step="0.05" value="${numAttr(roi?.thresholdM, 1)}"/></label>
      <label>현재 측정값 <b id="f-live">-</b></label>
      <div class="hint tip">화면의 <b style="color:#7cffb2">연두색 기준선 두 개</b>를 실제로 보이는 눈금 위로 끌어다 놓고,
        그 자리의 눈금값을 입력하세요. 표시되는 물높이는 <b>하단 기준선의 눈금값 + 수면선까지의 높이</b>로 계산됩니다.
        기준선은 물에 잠기지 않아 <b>숫자가 보이는 눈금</b>에 맞춰야 정확합니다. 끌어 놓은 위치는 "저장"을 눌러야 반영됩니다.</div>
    </div>`;
}

/** 라디오 선택에 따라 입력란을 바꿔 보여준다 */
function wireModeToggle(tile, ed) {
  const formEl = ed.formEl;
  const boxes = formEl.querySelectorAll('[data-mode-box]');
  formEl.querySelectorAll('.roi-mode input[type=radio]').forEach((radio) => {
    radio.addEventListener('change', () => {
      for (const box of boxes) box.hidden = box.dataset.modeBox !== radio.value;
      ed.thresholdMode = radio.value;
      if (radio.value === 'height' && !ed.scale) ed.scale = defaultAnchors(ed.points);
      updateLiveReading(tile);
      tile.render();
    });
  });
  // 눈금값을 고치는 즉시 "현재 측정값"과 화면의 선이 따라 움직여야 기준자를 맞출 수 있다.
  for (const id of ['f-topM', 'f-bottomM', 'f-thresholdM', 'f-thresholdMps']) {
    formEl.querySelector(`#${id}`)?.addEventListener('input', () => {
      updateLiveReading(tile);
      tile.render();
    });
  }
}

/** 입력란 -> API 페이로드. 모드에 따라 서로 다른 필드를 보내지만 반대편 값도 그대로 보존된다. */
function readThresholdFields(ed) {
  const formEl = ed.formEl;
  const thresholdMode = formEl.querySelector('.roi-mode input[type=radio]:checked')?.value || 'percent';
  if (thresholdMode === 'velocity') {
    return { thresholdMode, thresholdMps: numOrNull(formEl.querySelector('#f-thresholdMps').value) };
  }
  if (thresholdMode !== 'height') {
    return { thresholdMode, threshold: Number(formEl.querySelector('#f-threshold').value) };
  }
  return {
    thresholdMode,
    heightScale: {
      topM: numOrNull(formEl.querySelector('#f-topM').value),
      bottomM: numOrNull(formEl.querySelector('#f-bottomM').value),
      topY: ed.scale?.topY ?? null,
      bottomY: ed.scale?.bottomY ?? null
    },
    thresholdM: numOrNull(formEl.querySelector('#f-thresholdM').value)
  };
}

/**
 * 편집 중인 물높이 ROI의 "저장 전" 설정값. 타일 렌더링이 이걸 우선 사용해서,
 * 기준선을 끌거나 눈금값을 고치는 즉시 화면의 임계선·수위 표시가 따라 움직이게 한다.
 * @returns {{topM:number|null, bottomM:number|null, topY:number|null, bottomY:number|null, thresholdM:number|null}|null}
 */
export function getDraftHeight(tile, roiId) {
  const ed = editors.get(tile);
  if (!ed || ed.mode === 'none' || ed.selectedRoiId !== roiId || ed.thresholdMode !== 'height') return null;
  const scale = draftScale(ed);
  if (!scale) return null;
  return { ...scale, thresholdM: numOrNull(ed.formEl.querySelector('#f-thresholdM')?.value) };
}

/** 지금 폼에 입력된 값 + 끌어다 놓은 기준선 위치로 만든 임시 눈금 기준자 (저장 전 미리보기용) */
function draftScale(ed) {
  const formEl = ed.formEl;
  if (!formEl || ed.thresholdMode !== 'height') return null;
  return {
    topM: numOrNull(formEl.querySelector('#f-topM')?.value),
    bottomM: numOrNull(formEl.querySelector('#f-bottomM')?.value),
    topY: ed.scale?.topY ?? null,
    bottomY: ed.scale?.bottomY ?? null
  };
}

function renderNewRoiForm(tile, ed) {
  ed.toolbarEl?.remove();
  ed.toolbarEl = null;
  if (!ed.formEl) {
    ed.formEl = document.createElement('div');
    ed.formEl.className = 'roi-edit-form';
    tile.videoWrap.appendChild(ed.formEl);
  }
  const defaultLabel = state.config?.alarmSettings?.defaultLabel || '침수발생';
  ed.formEl.innerHTML = `
    <label>이름 <input type="text" id="f-name" value="ROI-${getRoisForChannel(tile.channel.channelId).length + 1}"/></label>
    ${thresholdFieldsHtml(null, tile.channel)}
    <label>알람 라벨 <input type="text" id="f-label" value="${defaultLabel}"/></label>
    <div class="btn-row">
      <button data-act="save">저장</button>
      <button data-act="cancel">취소</button>
    </div>`;
  wireModeToggle(tile, ed);
  ed.formEl.querySelector('[data-act=cancel]').onclick = () => cancel(tile);
  ed.formEl.querySelector('[data-act=save]').onclick = async () => {
    const name = ed.formEl.querySelector('#f-name').value.trim();
    const label = ed.formEl.querySelector('#f-label').value.trim();
    try {
      await api.addRoi({
        channelId: tile.channel.channelId, name, points: ed.points, label, ...readThresholdFields(ed)
      });
      cancel(tile);
    } catch (e) {
      alert('ROI 저장 실패: ' + e.message);
    }
  };
  tile.render();
}

function renderEditForm(tile, ed, roi) {
  removeFloating(ed);
  ed.formEl = document.createElement('div');
  ed.formEl.className = 'roi-edit-form';
  tile.videoWrap.appendChild(ed.formEl);
  ed.formEl.innerHTML = `
    <div style="font-weight:600">${roi.name} 편집 (점을 드래그해 모양 수정)</div>
    <label>이름 <input type="text" id="f-name" value="${escapeAttr(roi.name)}"/></label>
    ${thresholdFieldsHtml(roi, tile.channel)}
    <label>알람 라벨 <input type="text" id="f-label" value="${escapeAttr(roi.label || '')}"/></label>
    <div class="btn-row">
      <button data-act="save">저장</button>
      <button data-act="delete">삭제</button>
      <button data-act="close">닫기</button>
    </div>`;
  wireModeToggle(tile, ed);
  updateLiveReading(tile);
  ed.formEl.querySelector('[data-act=close]').onclick = () => cancel(tile);
  ed.formEl.querySelector('[data-act=delete]').onclick = async () => {
    if (!confirm(`ROI "${roi.name}"을(를) 삭제할까요?`)) return;
    await api.deleteRoi(roi.id);
    cancel(tile);
  };
  ed.formEl.querySelector('[data-act=save]').onclick = async () => {
    const name = ed.formEl.querySelector('#f-name').value.trim();
    const label = ed.formEl.querySelector('#f-label').value.trim();
    try {
      await api.updateRoi(roi.id, { name, label, points: ed.points, ...readThresholdFields(ed) });
      cancel(tile);
    } catch (e) {
      alert('ROI 저장 실패: ' + e.message);
    }
  };
}

/**
 * 편집 중인 ROI의 "현재 측정값"을 갱신한다 (새 프레임이 올 때 + 기준선/눈금값을 바꿀 때마다).
 * 저장 전에도 결과를 볼 수 있도록, 서버가 보낸 수면선 위치를 **지금 폼에 입력된 기준자로** 다시 환산한다.
 * 그래야 기준선을 끌면서 실제 눈금과 값이 맞는지 즉시 확인할 수 있다.
 */
export function updateLiveReading(tile) {
  const ed = editors.get(tile);
  updateLiveVelocity(tile, ed);
  const el = ed?.formEl?.querySelector('#f-live');
  if (!el) return;

  const it = (tile.lastFrame?.intrusions || []).find((i) => i.roiId === ed.selectedRoiId);
  if (!it) { el.textContent = '-'; return; }
  if (it.mode !== 'height' || it.waterY == null) { el.textContent = '(저장 후 표시)'; return; }

  const scale = draftScale(ed);
  const bounds = roiBounds(ed.points);
  const level = scale ? yToMeters(it.waterY, scale, bounds) : it.levelM;
  const raw = scale && it.waterYRaw != null ? yToMeters(it.waterYRaw, scale, bounds) : null;
  el.textContent = level == null
    ? '-'
    : `${formatMeters(level)}${raw == null ? '' : ` (실시간 ${formatMeters(raw)})`}`;
}

/**
 * 유속 ROI 폼의 "현재 유속" — 서버가 보낸 이 ROI의 유속(유속 ROI로 저장돼 있으면 알람 판정에 쓴 평활값)을 보여 준다.
 * 새로 그리는 중이거나 아직 다른 모드로 저장된 ROI는 서버 결과가 없거나 평활 전 값이다.
 */
function updateLiveVelocity(tile, ed) {
  const el = ed?.formEl?.querySelector('#f-live-mps');
  if (!el) return;
  const flow = tile.lastFlow && Date.now() - tile.lastFlow.receivedAt <= 5000 ? tile.lastFlow : null;
  const rf = flow?.rois?.find((r) => r.roiId === ed.selectedRoiId);
  if (!flow) { el.textContent = '(유속 수신 없음)'; return; }
  if (!flow.calibrated) { el.textContent = '(보정 전)'; return; }
  if (!rf) { el.textContent = '(저장 후 표시)'; return; }
  const v = rf.speedMpsSmoothed ?? rf.speedMps;
  el.textContent = v == null ? '- (믿을 칸 없음)' : `${formatMps(v)}${rf.outsideCalib ? ' (보정 범위 밖)' : ''}`;
}

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
// ROI 이름은 사용자가 입력한 값이라 본문에 넣을 때는 <, & 까지 막아야 한다.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 값이 아직 없으면(null) 기본값을 넣는다. Number(null)이 0이므로 Number.isFinite로만 판단하면 안 된다.
function numAttr(v, fallback) {
  const n = numOrNull(v);
  return n == null ? fallback : n;
}
function numOrNull(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function clamp01(v) { return Math.min(1, Math.max(0, v)); }

/** tile.render()에서 호출: 캔버스 위에 draft/selected 폴리곤과 정점 핸들, 눈금 기준선을 그린다 */
export function drawDraftOverlay(tile, ctx, videoRect) {
  const ed = editors.get(tile);
  if (!ed || ed.mode === 'none') return;
  if (ed.points.length === 0) return;
  const toPx = makeToPixel(videoRect);

  ctx.save();
  ctx.strokeStyle = '#ffd23a';
  ctx.fillStyle = 'rgba(255, 210, 58, 0.15)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ed.points.forEach((pt, i) => {
    const [px, py] = toPx(pt);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  if (ed.mode === 'select') ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffd23a';
  for (const pt of ed.points) {
    const [px, py] = toPx(pt);
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  drawAnchorLines(ed, ctx, toPx);
}

/** 눈금 기준선 2개 — 끌어서 실제 눈금에 맞추는 선이라 잡기 쉬운 손잡이까지 같이 그린다. */
function drawAnchorLines(ed, ctx, toPx) {
  if (ed.thresholdMode !== 'height' || !ed.scale || !ed.formEl) return;
  const b = roiBounds(ed.points);
  const scale = draftScale(ed);

  for (const key of ['bottom', 'top']) {
    const normY = key === 'top' ? ed.scale.topY : ed.scale.bottomY;
    const meters = key === 'top' ? scale?.topM : scale?.bottomM;
    const [x1, py] = toPx([b.minX, normY]);
    const [x2] = toPx([b.maxX, normY]);

    ctx.save();
    ctx.strokeStyle = '#7cffb2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1 - 14, py);
    ctx.lineTo(x2 + 14, py);
    ctx.stroke();
    // 끌 수 있다는 것을 알리는 손잡이
    ctx.fillStyle = '#7cffb2';
    ctx.fillRect(x1 - 20, py - 4, 8, 8);
    ctx.fillRect(x2 + 12, py - 4, 8, 8);
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(`${key === 'top' ? '상단' : '하단'} ${meters == null ? '?' : formatMeters(meters)}`, x2 + 24, py + 4);
    ctx.restore();
  }
}
