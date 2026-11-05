// ROI/탐지 오버레이는 정규화(0~1) 좌표를 실제 "영상이 그려지는 영역"에 맞춰 그려야 한다.
// 그 영역은 <video>의 CSS object-fit에 따라 달라진다.
//   fill    : 칸 전체 (영상을 칸 비율에 맞춰 늘림, 여백 없음) — v0.2.6부터 기본값
//   contain : 칸 안에 비율 유지로 축소, 남는 곳은 레터박스 여백 — v0.2.5까지의 방식
//   cover   : 칸을 비율 유지로 꽉 채우고 넘치는 가장자리는 잘림 (영역이 칸보다 커져 x/y가 음수)
// 이 계산이 실제 표시와 다르면 오버레이가 영상과 어긋난다(2026-08-28 레터박스 버그). 그래서 CSS 값을 직접 읽어
// 따라가게 했다 — style.css에서 object-fit을 바꿔도 여기는 고칠 필요가 없다.
// 이 모듈이 오버레이 그리기(tile.js)·클릭 좌표 변환(roiEditor.js)·알람 스냅샷(grid.js) 모두에서 공유된다.

/**
 * @param {HTMLVideoElement|null|undefined} videoEl
 * @param {number} canvasW 캔버스(컨테이너) 픽셀 폭
 * @param {number} canvasH 캔버스(컨테이너) 픽셀 높이
 * @param {string} [objectFit] 미리 읽어 둔 object-fit 값. 프레임마다 불리는 곳(tile.js)은 이 값을 넘겨서
 *   getComputedStyle(강제 스타일 재계산을 일으킬 수 있음)을 매번 부르지 않는다. 생략하면 여기서 읽는다.
 * @returns {{x:number, y:number, w:number, h:number}} 캔버스 내에서 영상이 실제로 차지하는 영역(px)
 */
export function getVideoContentRect(videoEl, canvasW, canvasH, objectFit) {
  const full = { x: 0, y: 0, w: canvasW, h: canvasH };
  const vw = videoEl?.videoWidth;
  const vh = videoEl?.videoHeight;
  // 영상 메타데이터를 아직 모르면(로딩 전/영상 없음) 캔버스 전체를 그대로 사용
  if (!vw || !vh || canvasW <= 0 || canvasH <= 0) return full;
  const fit = objectFit || getComputedStyle(videoEl).objectFit;
  if (fit === 'fill') return full;
  const scale = fit === 'cover'
    ? Math.max(canvasW / vw, canvasH / vh)
    : Math.min(canvasW / vw, canvasH / vh); // contain (그 외 값도 contain으로 취급)
  const w = vw * scale;
  const h = vh * scale;
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}

/** 정규화(0~1) 좌표 -> 캔버스 픽셀 좌표 변환 함수를 만들어 반환 */
export function makeToPixel(rect) {
  return ([nx, ny]) => [rect.x + nx * rect.w, rect.y + ny * rect.h];
}

/** 캔버스 픽셀 좌표 -> 정규화(0~1) 좌표 (영상이 그려지는 영역 기준, 범위 밖은 0~1로 clamp) */
export function pixelToNormalized(px, py, rect) {
  if (rect.w <= 0 || rect.h <= 0) return [0, 0];
  const x = (px - rect.x) / rect.w;
  const y = (py - rect.y) / rect.h;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}
