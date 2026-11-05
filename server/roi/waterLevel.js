// 교각 수위표(눈금판)에 그린 ROI 안에서 "수면선"을 찾아 눈금값(미터)으로 환산한다.
//
// 원리
//  1) 사용자가 교각의 눈금 구간을 따라 세로로 길쭉한 ROI를 그린다.
//  2) ROI 안에 **기준선 두 개**를 실제로 보이는 눈금 위에 놓고 그 눈금값을 입력한다
//     (heightScale: {bottomY, bottomM} = 하단(최하) 기준, {topY, topM} = 상단 기준).
//     -> 이 두 점이 "눈금 읽기"의 기준자(scale)가 된다. 영상 세로 위치 y와 눈금값(m)의 선형 대응이 정해진다.
//     * bottomY/topY가 없는 예전 설정은 ROI의 아래/위 경계를 기준선으로 간주한다(하위 호환).
//     * 기준선을 ROI 경계가 아니라 임의 위치에 둘 수 있어야 하는 이유: ROI의 아래쪽은 대개 물에 잠겨 있어
//       그 지점의 눈금값을 사람이 읽을 수 없다. 눈에 보이는 눈금에 선을 맞추는 것이 유일하게 정확한 방법이다.
//  3) 매 프레임 water 폴리곤이 ROI를 아래에서부터 얼마나 채우고 있는지를 가로 띠(band)별로 세어,
//     "물로 찬 구간의 맨 위" = 수면선을 찾고 그 y를 위 스케일로 환산해 현재 수위(m)를 얻는다.
//     결과적으로 표시값 = 하단 기준값 + (하단 기준선에서 수면선까지의 높이를 눈금으로 환산한 값) 이다.
//
// 왜 숫자를 OCR로 읽지 않는가: 이 서버에는 영상 프레임 자체가 들어오지 않는다(추론 소스는 폴리곤만
// TCP로 보내고, 영상은 브라우저가 MediaMTX에서 직접 받는다). 게다가 수면 근처의 숫자는 물에 잠기거나
// 물보라/야간 적외선으로 뭉개져 가장 읽기 어려운 부분이다. 반면 수면선의 위치는 세그멘테이션 결과에
// 이미 선명하게 들어있으므로(실측: 눈금판 폭 안에서 한 밴드 만에 0%->100%로 전환), 눈금 기준자만
// 사람이 한 번 맞춰 주면 눈금 사이값까지 연속적으로 읽어낼 수 있다.
import { pointInPolygonXY, relevantPolygons, insideAnyPolygon } from './intrusion.js';

/** 세로 방향 분해능. 64밴드 = ROI 세로 길이의 1/64 단위로 수면선을 잡는다(2m 구간이면 약 3cm). */
const DEFAULT_BANDS = 64;
/** 밴드 하나를 판정할 때 가로로 몇 점을 찍어볼지 */
const DEFAULT_COLS = 12;
/** 이 비율 이상 물로 차 있어야 "잠긴 밴드"로 본다 (물보라·반사로 생기는 얇은 조각 무시) */
const BAND_FILL_RATIO = 0.5;
/** 아래에서 위로 훑을 때 이만큼의 밴드가 비어도 끊어진 것으로 보지 않는다 (부유물/거품 대비) */
const MAX_GAP_BANDS = 2;

/** 두 기준선이 화면에서 이만큼(정규화 y)은 떨어져 있어야 한다 — 너무 붙으면 환산 배율이 폭주한다. */
export const MIN_ANCHOR_GAP = 0.02;

/** heightScale이 실제로 눈금 환산에 쓸 수 있는 값인지 */
export function isValidHeightScale(scale) {
  if (!scale) return false;
  const top = Number(scale.topM);
  const bottom = Number(scale.bottomM);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top === bottom) return false;
  // 기준선 위치는 선택 사항(없으면 ROI 경계)이지만, 넣는다면 둘 다 있어야 하고 위/아래 순서가 맞아야 한다.
  if (scale.topY != null || scale.bottomY != null) {
    const ty = Number(scale.topY);
    const by = Number(scale.bottomY);
    if (!Number.isFinite(ty) || !Number.isFinite(by)) return false;
    if (by - ty < MIN_ANCHOR_GAP) return false;
  }
  return true;
}

/**
 * 저장된 기준선 위치 -> 숫자 또는 null(미지정). null/빈칸은 반드시 "미지정"으로 본다 —
 * Number(null) === 0 이라 Number.isFinite만으로 거르면 "화면 맨 위(0)"가 되어 두 기준선이 0에 겹치고
 * 수위가 null(알람 없음)이 됐다(v0.5.0까지의 버그). 화면 public/js/waterScale.js도 같은 규칙이다.
 */
function anchorY(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 실제 환산에 쓸 기준점 두 개. 기준선 위치가 지정돼 있지 않으면 ROI의 위/아래 경계를 쓴다(예전 동작).
 * @returns {{topY:number, topM:number, bottomY:number, bottomM:number}}
 */
export function scaleAnchors(scale, bounds) {
  const ty = anchorY(scale.topY);
  const by = anchorY(scale.bottomY);
  return {
    topY: ty ?? bounds.minY,
    bottomY: by ?? bounds.maxY,
    topM: Number(scale.topM),
    bottomM: Number(scale.bottomM)
  };
}

/** 이 ROI가 "물높이(m)" 기준으로 판정되는 ROI인지 */
export function isHeightRoi(roi) {
  return roi?.thresholdMode === 'height' && isValidHeightScale(roi.heightScale);
}

/** 폴리곤의 세로 범위(정규화 y). 상단/하단 경계가 조금 기울어져 있어도 bbox 기준으로 단순화한다. */
export function roiYBounds(points) {
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * 영상 세로 위치(정규화 y) -> 눈금값(m).
 * 하단 기준값 + (하단 기준선에서 그 지점까지의 높이를 두 기준선 간격으로 환산한 값).
 * 기준선 바깥(예: 하단 기준선보다 아래)이면 같은 배율로 그대로 연장된다.
 */
export function yToMeters(y, scale, bounds) {
  const a = scaleAnchors(scale, bounds);
  const span = a.bottomY - a.topY;
  if (span <= 0) return a.bottomM;
  return a.bottomM + ((a.bottomY - y) / span) * (a.topM - a.bottomM);
}

/** 눈금값(m) -> 영상 세로 위치(정규화 y). 임계 수위선을 화면에 그릴 때 쓴다. */
export function metersToY(meters, scale, bounds) {
  const a = scaleAnchors(scale, bounds);
  if (a.topM === a.bottomM) return a.bottomY;
  const t = (Number(meters) - a.bottomM) / (a.topM - a.bottomM);
  return a.bottomY - t * (a.bottomY - a.topY);
}

/**
 * ROI 안의 수면선을 찾아 눈금값(m)으로 환산한다.
 * @param {Array<[number,number]>} roiPolygon ROI 폴리곤 (정규화 좌표)
 * @param {Array<Array<[number,number]>>} polygons water 폴리곤들
 * @param {{topM:number,bottomM:number}} scale ROI 상단/하단 경계의 눈금값
 * @returns {{levelM:number|null, waterY:number|null, coverage:number, detected:boolean,
 *            saturated:'above'|'below'|null}}
 *   levelM=현재 수위(m), waterY=수면선의 정규화 y, coverage=ROI 중 물이 찬 비율(0~1),
 *   detected=ROI 안에서 물을 찾았는지, saturated='below'(수면이 ROI 아래) / 'above'(ROI 위로 넘침)
 */
export function measureWaterLevel(roiPolygon, polygons, scale, opts = {}) {
  const empty = { levelM: null, waterY: null, coverage: 0, detected: false, saturated: null };
  if (!roiPolygon || roiPolygon.length < 3 || !isValidHeightScale(scale)) return empty;

  const bands = opts.bands || DEFAULT_BANDS;
  const cols = opts.cols || DEFAULT_COLS;
  const fillRatio = opts.fillRatio ?? BAND_FILL_RATIO;
  const maxGap = opts.maxGap ?? MAX_GAP_BANDS;

  const bounds = roiYBounds(roiPolygon);
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  if (w <= 0 || h <= 0) return empty;

  // ROI bbox와 겹치지 않는 water 폴리곤은 어차피 표본점에 걸릴 수 없으므로 미리 뺀다 (intrusion.js와 같은 방식).
  const water = relevantPolygons(polygons, bounds);

  // 밴드별 점유율 (b=0이 ROI 최상단)
  const profile = [];
  let roiSamples = 0;
  let waterSamples = 0;
  for (let b = 0; b < bands; b++) {
    const y = bounds.minY + ((b + 0.5) / bands) * h;
    let inRoi = 0;
    let inWater = 0;
    for (let c = 0; c < cols; c++) {
      const x = bounds.minX + ((c + 0.5) / cols) * w;
      if (!pointInPolygonXY(x, y, roiPolygon)) continue;
      inRoi++;
      if (water.length > 0 && insideAnyPolygon(x, y, water)) inWater++;
    }
    roiSamples += inRoi;
    waterSamples += inWater;
    profile.push({ inRoi, frac: inRoi > 0 ? inWater / inRoi : 0 });
  }
  const coverage = roiSamples > 0 ? waterSamples / roiSamples : 0;

  // 아래에서 위로 훑으며 "잠긴 밴드"가 이어지는 맨 위 지점을 찾는다.
  // 위에서부터 최댓값을 찾지 않는 이유: 수면 위 물보라나 젖은 얼룩이 물로 잡히면 수위가 과대평가되기 때문.
  let topFilled = -1;
  let gap = 0;
  for (let b = bands - 1; b >= 0; b--) {
    const band = profile[b];
    if (band.inRoi === 0) continue; // ROI 모서리라 표본이 없는 밴드는 판단 보류
    if (band.frac >= fillRatio) {
      topFilled = b;
      gap = 0;
    } else if (++gap > maxGap) {
      break;
    }
  }

  if (topFilled < 0) {
    // ROI 안에 물이 전혀 없다 = 수면이 ROI 하단 경계보다 낮다.
    return { levelM: yToMeters(bounds.maxY, scale, bounds), waterY: bounds.maxY, coverage, detected: false, saturated: 'below' };
  }

  const waterY = bounds.minY + (topFilled / bands) * h; // 잠긴 밴드의 위쪽 경계 = 수면선
  return {
    levelM: yToMeters(waterY, scale, bounds),
    waterY,
    coverage,
    detected: true,
    saturated: topFilled === 0 ? 'above' : null // 최상단까지 잠김 = ROI 눈금 범위를 넘어섬
  };
}

/** 흔들림 제거용 중앙값 (프레임마다 튀는 세그멘테이션 경계를 고르게 한다) */
export function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
