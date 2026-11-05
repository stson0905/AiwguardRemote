// 교각 수위표(눈금판) ROI의 눈금 환산 — 화면 표시 전용.
// 실제 판정에 쓰이는 계산은 서버(server/roi/waterLevel.js)가 하고, 여기서는 그 결과를 그리기 위해
// 같은 선형 대응식(ROI 상단=topM, 하단=bottomM)만 그대로 사용한다.

/** ROI 폴리곤의 bbox (정규화 좌표) */
export function roiBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** 두 기준선이 화면에서 이만큼(정규화 y)은 떨어져 있어야 한다 (서버 waterLevel.js와 같은 값) */
export const MIN_ANCHOR_GAP = 0.02;

export function isValidHeightScale(scale) {
  const top = Number(scale?.topM);
  const bottom = Number(scale?.bottomM);
  return Number.isFinite(top) && Number.isFinite(bottom) && top !== bottom;
}

/** 이 ROI가 물높이(m) 기준으로 판정되는 ROI인지 */
export function isHeightRoi(roi) {
  return roi?.thresholdMode === 'height' && isValidHeightScale(roi.heightScale);
}

/**
 * 환산 기준점 두 개. 기준선 위치(topY/bottomY)가 없으면 ROI의 위/아래 경계를 쓴다.
 * 서버(server/roi/waterLevel.js)의 scaleAnchors와 같은 규칙이어야 화면과 판정이 어긋나지 않는다.
 */
export function scaleAnchors(scale, bounds) {
  const ty = anchorY(scale?.topY);
  const by = anchorY(scale?.bottomY);
  return {
    topY: ty ?? bounds.minY,
    bottomY: by ?? bounds.maxY,
    topM: Number(scale?.topM),
    bottomM: Number(scale?.bottomM)
  };
}

/**
 * 저장된 기준선 위치 -> 숫자 또는 null(미지정). null/빈칸을 반드시 "미지정"으로 봐야 한다 —
 * Number(null) === 0 이라 그냥 Number.isFinite로 거르면 "화면 맨 위(0)"로 읽혀 두 기준선이 0에 겹치고
 * 수위가 계산되지 않았다(v0.5.0까지의 버그, 서버 waterLevel.js도 같은 규칙).
 */
function anchorY(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 이 물높이 ROI에 기준선 위치가 저장돼 있지 않은지 (ROI 경계로 대신 계산 중인지) */
export function anchorsMissing(scale) {
  return anchorY(scale?.topY) === null || anchorY(scale?.bottomY) === null;
}

/** 눈금값(m) -> 정규화 y (임계 수위선을 그릴 때 사용) */
export function metersToY(meters, scale, bounds) {
  const a = scaleAnchors(scale, bounds);
  if (a.topM === a.bottomM) return a.bottomY;
  const t = (Number(meters) - a.bottomM) / (a.topM - a.bottomM);
  return a.bottomY - t * (a.bottomY - a.topY);
}

/** 정규화 y -> 눈금값(m). 기준선을 옮기는 즉시 "이렇게 읽힌다"를 미리 보여줄 때 쓴다. */
export function yToMeters(y, scale, bounds) {
  const a = scaleAnchors(scale, bounds);
  const span = a.bottomY - a.topY;
  if (!(span > 0)) return null;
  return a.bottomM + ((a.bottomY - y) / span) * (a.topM - a.bottomM);
}

/** 화면 표시용 물높이 문자열 (소수 둘째 자리 = cm 단위) */
export function formatMeters(m) {
  return Number.isFinite(Number(m)) ? `${Number(m).toFixed(2)}m` : '-';
}

/** 화면 표시용 유속 문자열 (소수 둘째 자리) */
export function formatMps(v) {
  return Number.isFinite(Number(v)) && v !== null ? `${Number(v).toFixed(2)}m/s` : '-';
}

/** 알람 이벤트에서 "판정에 쓰인 측정값" 문자열 (모드에 따라 단위가 다르다) */
export function eventMeasureText(evt) {
  if (evt?.mode === 'height') return formatMeters(evt.levelM);
  if (evt?.mode === 'velocity') return formatMps(evt.speedMps);
  return `${evt?.ratePct ?? 0}%`;
}

/** 알람 이벤트에서 "그때 적용된 임계값" 문자열 */
export function eventThresholdText(evt) {
  if (evt?.mode === 'height') return formatMeters(evt.thresholdM);
  if (evt?.mode === 'velocity') return formatMps(evt.thresholdMps);
  return `${evt?.threshold ?? 0}%`;
}

/**
 * 측정 결과 표시용 문자열. 수면이 ROI 눈금 범위를 벗어나면 그 사실을 부등호로 알린다
 * (범위 밖에서는 실제 수위를 알 수 없고 ROI 경계값만 아는 상태이므로 그냥 숫자로 보이면 오해를 부른다).
 */
export function levelText(intrusion) {
  return levelTextOf(intrusion?.levelM, intrusion?.saturated);
}

/** 위와 같지만 값을 직접 받는다 (편집 중 임시 기준자로 다시 환산한 값을 표시할 때 사용) */
export function levelTextOf(levelM, saturated) {
  if (levelM == null || !Number.isFinite(Number(levelM))) return '-';
  const v = formatMeters(levelM);
  if (saturated === 'below') return `< ${v}`;
  if (saturated === 'above') return `≥ ${v}`;
  return v;
}
