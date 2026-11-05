// 유속 서비스(flow_service/)가 보내는 격자별 광류 결과를 채널 x ROI 유속으로 바꾼다.
//
// 침수(침범률·물높이) 판정과는 분리된 경로다 — 유속 데이터가 끊기거나 이상해도 그 알람들에는 영향이 없다.
// 화면상 유속(px/s)과 방향은 항상 내고, 채널에 유속 보정(channels[].flowCalib, 기준점 4개 이상의 호모그래피)이
// 있으면 칸마다 실제 수면 속도(m/s)로 환산한다(public/js/homography.js — 화면 미리보기와 같은 코드).
// 선 하나로 비율만 정하는 방식은 원근 때문에 부정확해서 쓰지 않는다(가상 카메라 시험: 선 방식 -46~-90%, 4점 방식 오차 0%).
// 판정 기준이 '유속(m/s)'인 ROI는 여기서 구한 값을 roiEngine.handleFlowSpeed 로 넘겨 같은 알람 상태머신으로 판정한다.
import { EventEmitter } from 'node:events';
import { findChannelForCam, matchSourceIdOf } from './roiEngine.js';
import { pointInPolygonXY } from './intrusion.js';
import { median } from './waterLevel.js';
import { worldVelocity, insideHull } from '../../public/js/homography.js';

export class FlowEngine extends EventEmitter {
  /** @param {import('./roiEngine.js').RoiEngine} [roiEngine] 유속(m/s) ROI의 알람 판정을 맡길 엔진 */
  constructor(store, roiEngine = null) {
    super();
    this.store = store;
    this.roiEngine = roiEngine;
  }

  /** tcpSourceManager 의 'flow' 이벤트(parser.js parseFlow 결과 + connId) 하나를 처리한다. */
  handle(msg) {
    const cfg = this.store.get();
    const channel = findChannelForCam(cfg.channels, msg.cam, matchSourceIdOf(cfg.tcpConnections, msg.connId));
    if (!channel) return; // 매칭 안 된 번호는 camObserver 가 설정 화면에 따로 보여준다
    const fs = flowSettingsOf(cfg);
    const calib = channel.flowCalib?.H ? channel.flowCalib : null;
    const now = Date.now();
    const rois = cfg.rois.filter((r) => r.channelId === channel.channelId && r.points?.length >= 3);
    const roiFlows = rois.map((roi) => {
      const m = measureRoiFlow(roi.points, msg, fs, calib);
      const out = { roiId: roi.id, roiName: roi.name, mode: roi.thresholdMode, ...m };
      if (roi.thresholdMode === 'velocity' && this.roiEngine) {
        // 알람 판정에 쓴 평활값을 화면에도 그대로 보여 준다(숫자와 알람이 서로 다른 값을 가리키지 않도록).
        out.speedMpsSmoothed = this.roiEngine.handleFlowSpeed(channel, roi, m.speedMps, now);
        out.thresholdMps = Number.isFinite(Number(roi.thresholdMps)) ? Number(roi.thresholdMps) : null;
      }
      return out;
    });

    this.emit('flow', {
      channelId: channel.channelId,
      calibrated: !!calib,
      ts: now,
      sourceTs: msg.ts,
      state: msg.state,
      fps: msg.fps,
      windowMs: msg.windowMs,
      pairs: msg.pairs,
      frame: msg.frame,
      grid: msg.grid,
      cells: msg.cells,
      rois: roiFlows
    });
  }
}

export function flowSettingsOf(cfg) {
  const s = cfg.flowSettings || {};
  return {
    showVectors: s.showVectors !== false,
    fbMin: Number.isFinite(Number(s.fbMin)) ? Number(s.fbMin) : 0.8,
    rMin: Number.isFinite(Number(s.rMin)) ? Number(s.rMin) : 0.7
  };
}

/** 칸 하나를 믿을 수 있는가 — 화면 화살표(public/js/tile.js)도 같은 기준을 쓴다. */
export function isReliableCell(cell, { fbMin, rMin }) {
  if (!cell) return false;
  const [vx, vy, fb, r] = cell;
  return vx != null && vy != null && fb != null && r != null && fb >= fbMin && r >= rMin;
}

/**
 * ROI 안(칸 중심이 ROI 폴리곤 안)에 드는 칸 중 믿을 수 있는 칸들의 속도 중앙값.
 * ROI 가 너무 작아 중심이 들어오는 칸이 없으면 ROI 무게중심에 가장 가까운 칸 하나를 쓴다.
 * calib(채널 유속 보정)이 있으면 칸마다 실제 수면 속도 벡터(m/s)로 바꾼 뒤 성분별 중앙값의 크기를 speedMps 로 낸다
 * (칸마다 원근 배율이 다르므로 px/s 중앙값을 한꺼번에 환산하면 안 된다).
 * @returns {{cellsInside:number, cellsValid:number, vx:number|null, vy:number|null,
 *            speedPx:number|null, dirDeg:number|null, speedMps:number|null, outsideCalib:boolean}}
 *   vx/vy = 정규화 좌표/초, speedPx = 원본 해상도 px/s, dirDeg = 화면 기준 방향(0=오른쪽, 90=아래, -90=위),
 *   speedMps = 수면 위 실제 유속(보정 없으면 null), outsideCalib = 쓴 칸의 절반 이상이 기준점 범위 밖(외삽이라 덜 정확)
 */
export function measureRoiFlow(points, msg, { fbMin, rMin }, calib = null) {
  const empty = { cellsInside: 0, cellsValid: 0, vx: null, vy: null, speedPx: null, dirDeg: null, speedMps: null, outsideCalib: false };
  const { cols, rows } = msg.grid || {};
  const cells = msg.cells || [];
  if (!cols || !rows || cells.length !== cols * rows) return empty;

  let idx = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (pointInPolygonXY((j + 0.5) / cols, (i + 0.5) / rows, points)) idx.push(i * cols + j);
    }
  }
  if (idx.length === 0) {
    const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
    const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
    const j = Math.min(cols - 1, Math.max(0, Math.floor(cx * cols)));
    const i = Math.min(rows - 1, Math.max(0, Math.floor(cy * rows)));
    idx = [i * cols + j];
  }

  const vxs = [];
  const vys = [];
  const wxs = [];
  const wys = [];
  let outside = 0;
  for (const k of idx) {
    if (!isReliableCell(cells[k], { fbMin, rMin })) continue;
    vxs.push(cells[k][0]);
    vys.push(cells[k][1]);
    if (calib) {
      const cx = ((k % cols) + 0.5) / cols;
      const cy = (Math.floor(k / cols) + 0.5) / rows;
      const W = worldVelocity(calib, cx, cy, cells[k][0], cells[k][1]);
      if (W) {
        wxs.push(W[0]);
        wys.push(W[1]);
        if (!insideHull(calib.hull, cx, cy)) outside++;
      }
    }
  }
  if (vxs.length === 0) return { ...empty, cellsInside: idx.length };
  const speedMps = wxs.length ? round(Math.hypot(median(wxs), median(wys)), 3) : null;
  const outsideCalib = wxs.length > 0 && outside * 2 > wxs.length;

  const vx = median(vxs);
  const vy = median(vys);
  const w = msg.frame?.w;
  const h = msg.frame?.h;
  const pxX = w ? vx * w : null;
  const pxY = h ? vy * h : null;
  return {
    cellsInside: idx.length,
    cellsValid: vxs.length,
    vx: round(vx, 5),
    vy: round(vy, 5),
    speedPx: pxX != null && pxY != null ? round(Math.hypot(pxX, pxY), 1) : null,
    dirDeg: pxX != null && pxY != null ? round(Math.atan2(pxY, pxX) * 180 / Math.PI, 0) : null,
    speedMps,
    outsideCalib
  };
}

function round(v, digits) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
