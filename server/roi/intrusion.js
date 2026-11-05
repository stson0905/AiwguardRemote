// ROI 폴리곤 <-> 탐지 폴리곤(세그멘테이션) 겹침 비율 계산. 좌표는 모두 0~1 정규화 값 사용.
// 오목 다각형도 안정적으로 처리하기 위해 grid sampling 방식을 사용한다.
//
// 성능 메모: 이 파일은 TCP로 프레임이 올 때마다(소스당 1~10fps x 채널 수 x ROI 수) 불리는 핫패스다.
// 표본점 하나마다 폴리곤 전체 정점을 도는 point-in-polygon이 비용의 전부이므로,
//  (1) 폴리곤마다 bbox를 한 번만 구해 두고 표본점이 그 밖이면 정점 순회 자체를 건너뛰고,
//  (2) 표본점을 배열([x,y])로 만들지 않고 숫자 두 개로 넘겨 프레임당 수천 개의 임시 배열 생성을 없앤다.

/** Shoelace 공식으로 폴리곤 면적(정규화 좌표 기준) 계산 */
export function polygonArea(points) {
  if (!points || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** ray casting 알고리즘 point-in-polygon 판정 (좌표를 숫자 두 개로 받는 핫패스용) */
export function pointInPolygonXY(px, py, points) {
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = points[i];
    const pj = points[j];
    const yi = pi[1];
    const yj = pj[1];
    if ((yi > py) !== (yj > py)) {
      const xi = pi[0];
      const xj = pj[0];
      if (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** ray casting 알고리즘 point-in-polygon 판정 (점을 [x,y]로 받는 호환용) */
export function pointInPolygon([px, py], points) {
  return pointInPolygonXY(px, py, points);
}

export function bboxBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 폴리곤 목록 중 주어진 bbox와 조금이라도 겹치는 것만 골라 bbox를 붙여 돌려준다.
 * 표본점마다 "bbox 안인가"를 먼저 보고 폴리곤 정점 순회를 건너뛰기 위한 사전 준비.
 * @returns {Array<{poly:Array<[number,number]>, minX:number, minY:number, maxX:number, maxY:number}>}
 */
export function relevantPolygons(polygons, bounds) {
  const out = [];
  for (const poly of polygons || []) {
    if (!poly || poly.length < 3) continue;
    const pb = bboxBounds(poly);
    if (pb.maxX < bounds.minX || pb.minX > bounds.maxX || pb.maxY < bounds.minY || pb.minY > bounds.maxY) continue;
    out.push({ poly, minX: pb.minX, minY: pb.minY, maxX: pb.maxX, maxY: pb.maxY });
  }
  return out;
}

/** 표본점이 (bbox로 먼저 걸러진) 폴리곤들 중 하나라도 안에 있는지 */
export function insideAnyPolygon(px, py, prepared) {
  for (let k = 0; k < prepared.length; k++) {
    const r = prepared[k];
    if (px < r.minX || px > r.maxX || py < r.minY || py > r.maxY) continue;
    if (pointInPolygonXY(px, py, r.poly)) return true;
  }
  return false;
}

/**
 * 탐지 bbox 면적 중 ROI 폴리곤과 겹치는 비율(0~1)을 grid sampling으로 근사한다.
 * @param {[number,number,number,number]} bbox [x,y,w,h] 정규화 좌표
 * @param {Array<[number,number]>} polygon ROI 폴리곤 정점 목록 (정규화 좌표, 3개 이상)
 * @param {number} grid 한 변 샘플 개수 (기본 24 -> 24x24=576 샘플)
 * @returns {number} 0~1
 */
export function bboxOverlapRatio(bbox, polygon, grid = 24) {
  if (!polygon || polygon.length < 3) return 0;
  const [bx, by, bw, bh] = bbox;
  if (bw <= 0 || bh <= 0) return 0;

  // 빠른 배제: 두 bounding box가 겹치지 않으면 샘플링 불필요
  const pb = bboxBounds(polygon);
  if (bx + bw < pb.minX || bx > pb.maxX || by + bh < pb.minY || by > pb.maxY) return 0;

  let inside = 0;
  const total = grid * grid;
  for (let iy = 0; iy < grid; iy++) {
    const sy = by + ((iy + 0.5) / grid) * bh;
    for (let ix = 0; ix < grid; ix++) {
      const sx = bx + ((ix + 0.5) / grid) * bw;
      if (pointInPolygonXY(sx, sy, polygon)) inside++;
    }
  }
  return inside / total;
}

/** 여러 ROI 중 bbox와 가장 많이 겹치는 결과들을 계산 (roi: {id, points}) */
export function computeIntrusions(bbox, rois, grid = 24) {
  return rois.map((roi) => ({
    roiId: roi.id,
    ratePct: bboxOverlapRatio(bbox, roi.points, grid) * 100
  }));
}

/**
 * ROI 폴리곤 면적 중 탐지 폴리곤(들)의 합집합과 겹치는 비율(0~1)을 계산.
 * 세그멘테이션 결과(water/road 같은 임의 다각형)와 ROI를 비교할 때 사용 — "ROI가 얼마나 침범당했는가".
 * ROI의 bounding box 안에서 grid sampling: ROI 내부 샘플점 중 폴리곤(들) 중 하나에라도 속하는 비율.
 * @param {Array<[number,number]>} roiPolygon
 * @param {Array<Array<[number,number]>>} polygons 탐지된 폴리곤 목록 (같은 클래스의 여러 블롭 등)
 */
export function roiCoverageRatio(roiPolygon, polygons, grid = 32) {
  if (!roiPolygon || roiPolygon.length < 3 || !polygons || polygons.length === 0) return 0;

  const roiBounds = bboxBounds(roiPolygon);
  // 빠른 배제: 탐지 폴리곤들 중 ROI bbox와 조금이라도 겹치는 것이 하나도 없으면 0
  const relevant = relevantPolygons(polygons, roiBounds);
  if (relevant.length === 0) return 0;

  const w = roiBounds.maxX - roiBounds.minX;
  const h = roiBounds.maxY - roiBounds.minY;
  if (w <= 0 || h <= 0) return 0;

  let insideRoi = 0;
  let insideBoth = 0;
  for (let iy = 0; iy < grid; iy++) {
    const sy = roiBounds.minY + ((iy + 0.5) / grid) * h;
    for (let ix = 0; ix < grid; ix++) {
      const sx = roiBounds.minX + ((ix + 0.5) / grid) * w;
      if (!pointInPolygonXY(sx, sy, roiPolygon)) continue;
      insideRoi++;
      if (insideAnyPolygon(sx, sy, relevant)) insideBoth++;
    }
  }
  return insideRoi > 0 ? insideBoth / insideRoi : 0;
}
