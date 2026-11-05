// 유속 m/s 환산용 "화면 ↔ 수면" 보정(호모그래피). 서버(server/roi/flowEngine.js, routes/api.js)와
// 화면(보정 편집기 미리보기)이 이 파일 하나를 같이 쓴다 — 계산이 두 곳에 복사되면 "미리보기와 실제 값이 다른"
// 상황이 생기므로 반드시 여기 한 곳만 둔다. DOM 을 쓰지 않는 순수 계산만 넣을 것(서버 번들에도 들어간다).
//
// 원리: 수면을 평면으로 보면, 영상 위의 점(정규화 좌표 x,y)과 수면 위의 실제 위치(X,Y 미터)는 3x3 행렬 H 하나로
// 대응된다(원근 포함). 수면 높이의 기준점 4개 이상의 화면 위치와 실제 좌표를 알면 H 를 구할 수 있고, 그러면
// 화면 어디서든 "이 칸에서 1초에 이만큼 움직였다"를 미터로 바꿀 수 있다. 선 하나로 비율만 정하는 방식은
// 원근 때문에 선에서 멀어질수록 틀린다(2026-09-21 검토: 비스듬한 CCTV 에서 ROI 끝부분 +61%/-32%).
//
// 한계: 수위가 기준점 높이에서 벗어나면 오차가 생긴다(카메라가 수면 위 5m 일 때 0.5m 상승 → +11%).

export const MIN_POINTS = 4;
export const MAX_POINTS = 8;
/**
 * 속도 → 미터 환산 시 쓰는 짧은 시간 간격(초). 원근 때문에 H 는 비선형이라 1초 이동을 통째로 옮기지 않고,
 * 그 점을 가운데 두고 앞뒤로 dt/2 씩 옮긴 두 점의 차이(중앙 차분)로 구한다 — 한쪽으로만 옮기면(전진 차분)
 * 가까운 쪽에서 0.2% 정도 치우친다(가상 카메라 시험에서 확인).
 */
const VEL_DT = 0.01;

/** 3x3 행렬(길이 9 배열, 행 우선) 적용: 정규화 영상 좌표 → [X, Y, w]. w 부호가 바뀌면 지평선 너머다. */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w, w];
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d
  ];
  return inv.map((v) => v / det);
}

/**
 * 대응점들로 H 를 구한다(점 4개면 정확히 맞춤, 5개 이상이면 최소제곱).
 * 수치 안정성을 위해 양쪽 점을 평균 0 / 평균거리 √2 로 정규화한 뒤 풀고 되돌린다(Hartley 정규화).
 * @param {number[][]} src 영상 좌표 [[x,y],...]  @param {number[][]} dst 실제 좌표 [[X,Y],...]
 * @returns {number[]|null} H (해를 못 구하면 null)
 */
export function solveHomography(src, dst) {
  const n = src.length;
  if (n < 4 || dst.length !== n) return null;
  const [s, Ts] = normalizeSet(src);
  const [d, Td] = normalizeSet(dst);
  if (!Ts || !Td) return null;

  // h33 = 1 로 두고 8개 미지수: 점마다 두 식
  //   x·h1 + y·h2 + h3 − x·X·h7 − y·X·h8 = X
  //   x·h4 + y·h5 + h6 − x·Y·h7 − y·Y·h8 = Y
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const addRow = (row, rhs) => {
    for (let r = 0; r < 8; r++) {
      if (row[r] === 0) continue;
      Atb[r] += row[r] * rhs;
      for (let c = 0; c < 8; c++) AtA[r][c] += row[r] * row[c];
    }
  };
  for (let k = 0; k < n; k++) {
    const [x, y] = s[k];
    const [X, Y] = d[k];
    addRow([x, y, 1, 0, 0, 0, -x * X, -y * X], X);
    addRow([0, 0, 0, x, y, 1, -x * Y, -y * Y], Y);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  const Hn = [...h, 1];
  // H = Td⁻¹ · Hn · Ts
  const H = mul3(mul3(invertH(Td), Hn), Ts);
  if (!H.every(Number.isFinite)) return null;
  const k = Math.abs(H[8]) > 1e-12 ? H[8] : Math.hypot(...H);
  return H.map((v) => v / k);
}

/**
 * 줄자 거리 6개(네 변 + 대각선 2개)로 기준점 4개의 실제 좌표를 만든다.
 * P1 = (0,0), P2 = (d12, 0), P3 은 P1·P2 에서의 거리로(위쪽), P4 는 P1·P2 에서의 거리로 두 후보 중 P3 까지 거리(d34)가
 * 더 맞는 쪽. 거리 6개로 점 4개의 모양은 하나로 정해지고 남는 한 개(d34)가 검산이 된다(mismatchM).
 * @returns {{world:number[][], mismatchM:number}}  @throws {Error} 삼각형이 안 되는 값 등
 */
export function pointsFromTape(dist) {
  const d = {};
  for (const key of ['d12', 'd23', 'd34', 'd41', 'd13', 'd24']) {
    const v = Number(dist?.[key]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`줄자 거리 ${tapeLabel(key)} 를 0보다 큰 숫자(m)로 입력하세요.`);
    d[key] = v;
  }
  const x3 = (d.d12 ** 2 + d.d13 ** 2 - d.d23 ** 2) / (2 * d.d12);
  const y3sq = d.d13 ** 2 - x3 ** 2;
  if (y3sq <= 0) throw new Error('P1–P2, P1–P3(대각), P2–P3 거리로 삼각형이 만들어지지 않습니다. 값을 다시 확인하세요.');
  const x4 = (d.d12 ** 2 + d.d41 ** 2 - d.d24 ** 2) / (2 * d.d12);
  const y4sq = d.d41 ** 2 - x4 ** 2;
  if (y4sq <= 0) throw new Error('P1–P2, P4–P1, P2–P4(대각) 거리로 삼각형이 만들어지지 않습니다. 값을 다시 확인하세요.');
  const p3 = [x3, Math.sqrt(y3sq)];
  const cands = [[x4, Math.sqrt(y4sq)], [x4, -Math.sqrt(y4sq)]].map((p4) => ({
    p4, err: Math.abs(Math.hypot(p4[0] - p3[0], p4[1] - p3[1]) - d.d34)
  }));
  cands.sort((a, b) => a.err - b.err);
  return { world: [[0, 0], [d.d12, 0], p3, cands[0].p4], mismatchM: cands[0].err };
}

function tapeLabel(key) {
  return { d12: 'P1–P2', d23: 'P2–P3', d34: 'P3–P4', d41: 'P4–P1', d13: 'P1–P3(대각)', d24: 'P2–P4(대각)' }[key];
}

/**
 * 입력(영상 기준점 + 좌표 또는 줄자 거리) → 저장할 보정값. 잘못된 입력이면 사람이 읽을 수 있는 이유로 throw 한다.
 * @param {{method:'coords'|'tape', points:Array<{ix:number,iy:number,X?:number,Y?:number}>, distances?:object}} input
 * @returns {{method, points, distances, H:number[], sign:1|-1, hull:number[][], rmsM:number|null, maxM:number|null,
 *            mismatchM:number|null, warnings:string[]}}
 */
export function computeCalibration(input) {
  const method = input?.method === 'tape' ? 'tape' : 'coords';
  const raw = Array.isArray(input?.points) ? input.points : [];
  if (raw.length < MIN_POINTS) throw new Error(`기준점이 ${MIN_POINTS}개 이상 필요합니다 (지금 ${raw.length}개).`);
  if (raw.length > MAX_POINTS) throw new Error(`기준점은 최대 ${MAX_POINTS}개까지입니다.`);
  if (method === 'tape' && raw.length !== 4) throw new Error('줄자 거리 방식은 기준점이 정확히 4개여야 합니다.');

  const img = raw.map((p, i) => {
    const x = Number(p?.ix), y = Number(p?.iy);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new Error(`P${i + 1} 의 화면 위치가 올바르지 않습니다.`);
    return [x, y];
  });
  let world;
  let mismatchM = null;
  let distances = null;
  if (method === 'tape') {
    const t = pointsFromTape(input.distances);
    world = t.world;
    mismatchM = t.mismatchM;
    distances = Object.fromEntries(['d12', 'd23', 'd34', 'd41', 'd13', 'd24'].map((k) => [k, Number(input.distances[k])]));
  } else {
    world = raw.map((p, i) => {
      const X = Number(p?.X), Y = Number(p?.Y);
      if (p?.X === '' || p?.Y === '' || p?.X == null || p?.Y == null || !Number.isFinite(X) || !Number.isFinite(Y)) {
        throw new Error(`P${i + 1} 의 실제 좌표 X, Y(m)를 입력하세요.`);
      }
      return [X, Y];
    });
  }

  // 한 줄로 늘어선 점이 섞이면 H 가 정해지지 않는다(특히 점 4개일 때).
  if (minTriangleArea(img) < 1e-5) throw new Error('화면의 기준점 중 세 점이 거의 한 줄에 있습니다. 넓게 흩어진 위치를 고르세요.');
  const wSpan = Math.max(...world.map((p) => Math.hypot(p[0] - world[0][0], p[1] - world[0][1])));
  if (!(wSpan > 0) || minTriangleArea(world) < 1e-4 * wSpan * wSpan) {
    throw new Error('실제 좌표 중 세 점이 거의 한 줄에 있습니다. 좌표 값을 확인하세요.');
  }
  // 호모그래피는 볼록 껍질의 순서를 (방향만 뒤집힐 수 있을 뿐) 그대로 보존한다. 순서가 다르면 좌표를 다른 점에 적은 것이다.
  if (!sameCyclicOrder(hullOrder(img), hullOrder(world))) {
    throw new Error('기준점의 배치 순서가 화면과 실제 좌표에서 서로 다릅니다. 각 점(P1, P2…)에 맞는 좌표를 적었는지 확인하세요.');
  }

  const H = solveHomography(img, world);
  if (!H) throw new Error('보정 행렬을 계산하지 못했습니다. 기준점 위치와 좌표를 확인하세요.');
  const ws = img.map(([x, y]) => applyH(H, x, y)[2]);
  const sign = ws[0] > 0 ? 1 : -1;
  const hull = hullOrder(img).map((i) => img[i]);
  // 기준점과 그 사이 영역이 모두 지평선 이쪽(같은 부호)에 있어야 한다.
  const probe = [...hull, centroid(img), ...hull.map((p, i) => mid(p, hull[(i + 1) % hull.length]))];
  if (probe.some(([x, y]) => Math.sign(applyH(H, x, y)[2]) !== sign)) {
    throw new Error('기준점 사이 영역이 지평선 너머로 계산됩니다. 좌표 값 또는 점 위치를 확인하세요.');
  }

  const residuals = img.map(([x, y], i) => {
    const [X, Y] = applyH(H, x, y);
    return Math.hypot(X - world[i][0], Y - world[i][1]);
  });
  const redundant = img.length > 4;
  const rmsM = redundant ? Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length) : null;
  const maxM = redundant ? Math.max(...residuals) : null;

  const warnings = [];
  if (method === 'coords' && !redundant) warnings.push('기준점이 4개라 입력 오차를 검산할 수 없습니다. 5~6개를 권장합니다.');
  if (rmsM != null && rmsM > Math.max(0.1, 0.01 * wSpan)) warnings.push(`검산 오차가 큽니다(평균 ${rmsM.toFixed(2)}m). 좌표나 점 위치를 확인하세요.`);
  if (mismatchM != null && mismatchM > Math.max(0.05, 0.01 * wSpan)) warnings.push(`줄자 거리끼리 맞지 않습니다(P3–P4 차이 ${mismatchM.toFixed(2)}m). 다시 재 보세요.`);

  return {
    method,
    points: img.map(([ix, iy], i) => ({ ix: round(ix, 5), iy: round(iy, 5), X: round(world[i][0], 4), Y: round(world[i][1], 4) })),
    distances,
    H,
    sign,
    hull,
    rmsM: rmsM == null ? null : round(rmsM, 3),
    maxM: maxM == null ? null : round(maxM, 3),
    mismatchM: mismatchM == null ? null : round(mismatchM, 3),
    warnings
  };
}

/**
 * 화면 속도(정규화 좌표/초) → 수면 위 실제 속도 [Vx, Vy] (m/s). 지평선 너머/근처라 환산이 무의미하면 null.
 */
export function worldVelocity(calib, x, y, vx, vy) {
  const { H, sign } = calib || {};
  if (!H) return null;
  const h = VEL_DT / 2;
  const a = applyH(H, x - vx * h, y - vy * h);
  const b = applyH(H, x + vx * h, y + vy * h);
  if (Math.sign(a[2]) !== sign || Math.sign(b[2]) !== sign) return null;
  const V = [(b[0] - a[0]) / VEL_DT, (b[1] - a[1]) / VEL_DT];
  return V.every(Number.isFinite) ? V : null;
}

/** 점이 기준점들의 볼록 껍질 안에 있는가 (밖이면 외삽 — 정확도가 떨어진다) */
export function insideHull(hull, x, y) {
  if (!hull || hull.length < 3) return false;
  let pos = 0, neg = 0;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i];
    const [bx, by] = hull[(i + 1) % hull.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c > 0) pos++; else if (c < 0) neg++;
  }
  return pos === 0 || neg === 0;
}

// ---------------------------------------------------------------------------
function normalizeSet(pts) {
  const n = pts.length;
  const cx = pts.reduce((a, p) => a + p[0], 0) / n;
  const cy = pts.reduce((a, p) => a + p[1], 0) / n;
  const md = pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
  if (!(md > 0)) return [null, null];
  const s = Math.SQRT2 / md;
  return [pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s]), [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1]];
}

function mul3(A, B) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  }
  return out;
}

/** 부분 피벗 가우스 소거. 특이하면 null. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-10) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function triArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

function minTriangleArea(pts) {
  // 점이 4개면 모든 세 점 조합이 겹치지 않아야 하고, 5개 이상이면 "전부 한 줄"만 아니면 된다(가장 큰 삼각형 기준).
  let min = Infinity, max = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const a = triArea(pts[i], pts[j], pts[k]);
    min = Math.min(min, a);
    max = Math.max(max, a);
  }
  return pts.length === 4 ? min : max;
}

/** 볼록 껍질 위 점들의 인덱스를 한 방향 순서로 (Andrew monotone chain) */
function hullOrder(pts) {
  const idx = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0] || pts[a][1] - pts[b][1]);
  const cross = (o, a, b) => (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const lower = [], upper = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), i) <= 0) lower.pop();
    lower.push(i);
  }
  for (const i of [...idx].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), i) <= 0) upper.pop();
    upper.push(i);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** 두 순환 순서가 (회전·뒤집기를 허용하고) 같은가 */
function sameCyclicOrder(a, b) {
  if (a.length !== b.length) return false;
  const n = a.length;
  for (const seq of [b, [...b].reverse()]) {
    const start = seq.indexOf(a[0]);
    if (start < 0) continue;
    if (a.every((v, i) => seq[(start + i) % n] === v)) return true;
  }
  return false;
}

function centroid(pts) {
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

function mid(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
