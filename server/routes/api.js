import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { newId, MAX_CHANNELS, LAYOUT_OPTIONS, normalizeTcpConnection, normalizeRoi } from '../config/store.js';
import { syncChannelPath, removeChannelPath, syncAllChannels } from '../media/mediamtxClient.js';
import { findChannelForCam, matchSourceIdOf } from '../roi/roiEngine.js';
import { MIN_ANCHOR_GAP } from '../roi/waterLevel.js';
import { computeCalibration } from '../../public/js/homography.js';
import { APP_NAME, APP_VERSION } from '../util/appInfo.js';
import { verifyDevPassword } from '../util/devPassword.js';

const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 개발자 모드 비밀번호 시도 제한 — 마구 찔러보는 것을 막는다.
const DEV_MAX_ATTEMPTS = 5;
const DEV_LOCKOUT_MS = 30_000;
/** 시도 기록 표가 이보다 커지면 만료된 항목을 정리한다(주소를 바꿔가며 찔러도 메모리가 새지 않도록) */
const DEV_ATTEMPTS_PRUNE_AT = 200;

/**
 * async 핸들러의 거부(rejection)를 Express의 오류 처리로 넘긴다.
 * Express 4는 async 함수가 던진 오류를 받지 못해 unhandledRejection이 되고, 그러면 응답도 없이
 * 요청이 매달린다(설정 저장 중 디스크 오류 하나가 그런 식으로 새면 화면은 영영 기다린다).
 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApiRouter({ store, tcpSourceManager, roiEngine, eventLog, camObserver, wsHub }) {
  const router = Router();
  const upload = multer({ dest: store.alarmsDir(), limits: { fileSize: 10 * 1024 * 1024 } });

  const cfg = () => store.get();

  // ---- 전체 설정 ----
  router.get('/config', (req, res) => {
    res.json(cfg());
  });

  // ---- 설정 백업 (설정 > 백업 탭) ----
  // 내보내는 파일은 config.json과 내용이 같다 — 이름만 config.json으로 바꿔 데이터 폴더에 넣으면 그대로 복원된다
  // (예전 버전 백업이면 시작할 때 store의 migrate가 새 형식으로 바꾼다). 그래서 머리말 같은 필드를 덧붙이지 않는다.
  router.get('/config/export', (req, res) => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ver = String(APP_VERSION).replace(/[^0-9A-Za-z.]/g, '') || 'dev';
    const name = `aiwguard-config-v${ver}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(cfg(), null, 2));
  });

  router.get('/backup-info', (req, res) => {
    const c = cfg();
    res.json({
      dataDir: store.dataDir(),
      configPath: store.configPath(),
      alarmsDir: store.alarmsDir(),
      customAudio: !!c.alarmSettings?.customAudioAssetId,
      counts: { channels: c.channels.length, rois: c.rois.length, tcpConnections: c.tcpConnections.length }
    });
  });

  // ---- 앱 정보 / 개발자 모드 ----
  router.get('/app-info', (req, res) => {
    res.json({ name: APP_NAME, version: APP_VERSION });
  });

  /**
   * 개발자 모드 잠금 해제. 비밀번호 확인은 전적으로 서버에서 하며, 화면에는 성공 여부만 알려준다
   * (비밀번호도 해시도 브라우저로 내려가지 않는다).
   */
  const devAttempts = new Map(); // 접속 주소 -> { count, lockedUntil }
  router.post('/dev-mode/unlock', (req, res) => {
    const who = req.ip || 'unknown';
    const now = Date.now();
    if (devAttempts.size > DEV_ATTEMPTS_PRUNE_AT) {
      for (const [ip, r] of devAttempts) if (r.lockedUntil <= now) devAttempts.delete(ip);
    }
    const rec = devAttempts.get(who) || { count: 0, lockedUntil: 0 };

    if (rec.lockedUntil > now) {
      const sec = Math.ceil((rec.lockedUntil - now) / 1000);
      return res.status(429).json({ error: `시도가 너무 많습니다. ${sec}초 후에 다시 시도하세요.` });
    }

    if (verifyDevPassword(req.body?.password)) {
      devAttempts.delete(who);
      return res.json({ ok: true });
    }

    rec.count += 1;
    if (rec.count >= DEV_MAX_ATTEMPTS) {
      rec.count = 0;
      rec.lockedUntil = now + DEV_LOCKOUT_MS;
    }
    devAttempts.set(who, rec);
    res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  });

  // ---- 채널 ----
  /**
   * 채널 하나를 만들 값을 검증해서 돌려준다. 한 개 추가(POST /channels)와 여러 개 한 번에 추가
   * (POST /channels/bulk)가 **같은 규칙**을 쓰도록 여기 한 곳에만 둔다.
   * takenIds: 이미 쓰이고 있는 channelId 집합 — 같은 요청 안에서 새로 만들어지는 것까지 넣어가며 불러야
   * 한 번에 추가할 때 자기들끼리 중복되는 것도 잡힌다.
   */
  function buildChannel(input, takenIds) {
    const { title, rtspUrl, channelId, enabled = true, camId, sourceId } = input || {};
    if (!title || !rtspUrl) return { error: 'title, rtspUrl은 필수입니다.' };
    const id = channelId && CHANNEL_ID_RE.test(channelId) ? channelId : slugify(title);
    if (!CHANNEL_ID_RE.test(id)) return { error: '유효하지 않은 channelId 입니다.', status: 400 };
    if (takenIds.has(id)) return { error: `이미 존재하는 channelId 입니다: ${id}`, status: 409 };
    return {
      channel: {
        id: newId('ch'), channelId: id, title, rtspUrl, enabled: !!enabled, mediaStatus: 'unknown',
        camId: camId !== undefined && camId !== null && camId !== '' ? String(camId) : null,
        // 특정 TCP 소스에서 온 좌표만 이 채널로 받으려면 해당 소스 id를 지정한다.
        // null이면 모든 소스에서 같은 cam 번호를 받는다(소스가 하나뿐이면 그대로 두면 됨).
        sourceId: sourceId ? String(sourceId) : null
      }
    };
  }

  router.post('/channels', wrap(async (req, res) => {
    if (cfg().channels.length >= MAX_CHANNELS) return res.status(400).json({ error: `채널은 최대 ${MAX_CHANNELS}개까지 등록할 수 있습니다.` });
    const { channel, error, status } = buildChannel(req.body, new Set(cfg().channels.map((c) => c.channelId)));
    if (error) return res.status(status || 400).json({ error });

    store.update((c) => c.channels.push(channel));
    await syncChannelPath(cfg().mediamtx, channel);
    res.status(201).json(channel);
  }));

  /**
   * 여러 채널 한 번에 추가. 한 줄이라도 잘못되어 있으면 **아무것도 만들지 않고** 몇 번째 줄이 왜 틀렸는지
   * 돌려준다 — 절반만 들어간 상태가 가장 수습하기 어렵기 때문이다.
   */
  router.post('/channels/bulk', wrap(async (req, res) => {
    const list = Array.isArray(req.body?.channels) ? req.body.channels : null;
    if (!list || list.length === 0) return res.status(400).json({ error: 'channels 배열이 필요합니다.' });
    const have = cfg().channels.length;
    if (have + list.length > MAX_CHANNELS) {
      return res.status(400).json({ error: `채널은 최대 ${MAX_CHANNELS}개까지 등록할 수 있습니다. (현재 ${have}개 + 추가 ${list.length}개)` });
    }

    const taken = new Set(cfg().channels.map((c) => c.channelId));
    const created = [];
    const errors = [];
    list.forEach((item, i) => {
      const { channel, error } = buildChannel(item, taken);
      if (error) return void errors.push({ index: i, error });
      taken.add(channel.channelId);
      created.push(channel);
    });
    if (errors.length > 0) {
      const head = errors.slice(0, 3).map((e) => `${e.index + 1}번째: ${e.error}`).join(' / ');
      return res.status(400).json({ error: `${errors.length}개 항목이 잘못되었습니다. ${head}`, errors });
    }

    store.update((c) => c.channels.push(...created));
    await syncAllChannels(cfg().mediamtx, created, { includeDisabled: true });
    res.status(201).json({ created: created.length, channels: created });
  }));

  /**
   * 여러 채널 한 번에 삭제. "전체 삭제"도 화면이 전체 id를 실어 보내는 방식이라,
   * 본문이 비어 있는 요청이 실수로 전부를 지우는 일은 생기지 않는다.
   */
  router.post('/channels/bulk-delete', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids 배열이 필요합니다.' });
    const idSet = new Set(ids);
    const targets = cfg().channels.filter((c) => idSet.has(c.id));
    if (targets.length === 0) return res.status(404).json({ error: '삭제할 채널을 찾지 못했습니다.' });
    const channelIds = new Set(targets.map((c) => c.channelId));

    store.update((c) => {
      c.channels = c.channels.filter((x) => !idSet.has(x.id));
      c.rois = c.rois.filter((r) => !channelIds.has(r.channelId));
      // 화면 표시 순서(display.order)에서는 store.update가 알아서 빠진다
    });
    for (const channelId of channelIds) roiEngine.purge({ channelId });
    // MediaMTX가 응답하지 않아도(호출당 4초 타임아웃) 삭제 자체는 이미 끝났으므로 실패를 무시한다.
    await Promise.allSettled([...channelIds].map((channelId) => removeChannelPath(cfg().mediamtx, channelId)));
    res.json({ deleted: targets.length });
  }));

  /** 선택한 채널들의 같은 항목을 한 번에 바꾼다(현재는 사용 여부만). 저장과 알림이 한 번씩만 일어난다. */
  router.post('/channels/bulk-update', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    const patch = req.body?.patch || {};
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids 배열이 필요합니다.' });
    if (patch.enabled === undefined) return res.status(400).json({ error: '바꿀 항목이 없습니다. (지원: enabled)' });
    const idSet = new Set(ids);
    let updated = 0;
    store.update((c) => {
      for (const ch of c.channels) {
        if (!idSet.has(ch.id)) continue;
        ch.enabled = !!patch.enabled;
        updated += 1;
      }
    });
    res.json({ updated });
  }));

  router.put('/channels/:id', wrap(async (req, res) => {
    const ch = cfg().channels.find((c) => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    const { title, rtspUrl, enabled, camId, sourceId } = req.body || {};
    store.update((c) => {
      const target = c.channels.find((x) => x.id === req.params.id);
      if (title !== undefined) target.title = title;
      if (rtspUrl !== undefined) target.rtspUrl = rtspUrl;
      if (enabled !== undefined) target.enabled = !!enabled;
      if (camId !== undefined) target.camId = camId === '' ? null : String(camId);
      if (sourceId !== undefined) target.sourceId = sourceId === '' || sourceId === null ? null : String(sourceId);
    });
    const updated = cfg().channels.find((c) => c.id === req.params.id);
    if (rtspUrl !== undefined) await syncChannelPath(cfg().mediamtx, updated);
    res.json(updated);
  }));

  router.delete('/channels/:id', wrap(async (req, res) => {
    const ch = cfg().channels.find((c) => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    store.update((c) => {
      c.channels = c.channels.filter((x) => x.id !== req.params.id);
      c.rois = c.rois.filter((r) => r.channelId !== ch.channelId);
    });
    roiEngine.purge({ channelId: ch.channelId });
    await removeChannelPath(cfg().mediamtx, ch.channelId);
    res.status(204).end();
  }));

  // ---- 채널 유속 보정 (화면 기준점 4~8개 ↔ 수면 위 실제 좌표 → 호모그래피) ----
  // 계산과 검증은 화면 미리보기와 같은 public/js/homography.js 로 서버에서 다시 한다 — 화면을 거치지 않은 요청이나
  // 오래된 화면이 보낸 값도 같은 기준으로 걸러진다. 잘못된 입력이면 사람이 읽을 수 있는 이유로 400.
  router.put('/channels/:id/flow-calibration', (req, res) => {
    const ch = cfg().channels.find((c) => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    let calib;
    try {
      calib = computeCalibration(req.body || {});
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const saved = { ...calib, updatedAt: Date.now() };
    store.update((c) => { c.channels.find((x) => x.id === req.params.id).flowCalib = saved; });
    // 보정이 바뀌면 그 채널 유속 ROI의 평활화 이력(예전 환산값)을 버린다.
    for (const roi of cfg().rois.filter((r) => r.channelId === ch.channelId && r.thresholdMode === 'velocity')) {
      roiEngine.purge({ channelId: ch.channelId, roiId: roi.id });
    }
    res.json(saved);
  });

  router.delete('/channels/:id/flow-calibration', (req, res) => {
    const ch = cfg().channels.find((c) => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    store.update((c) => { c.channels.find((x) => x.id === req.params.id).flowCalib = null; });
    res.status(204).end();
  });

  // ---- ROI ----
  // thresholdMode='percent'(기본, 침범률 %) | 'height'(교각 수위표 눈금 기준 물높이 m) | 'velocity'(유속 m/s)
  router.post('/rois', (req, res) => {
    const { channelId, name, points, threshold, label, classFilter, thresholdMode, heightScale, thresholdM, thresholdMps } = req.body || {};
    if (!channelId || !Array.isArray(points) || points.length < 3) {
      return res.status(400).json({ error: 'channelId, points(3점 이상)는 필수입니다.' });
    }
    if (!cfg().channels.some((c) => c.channelId === channelId)) {
      return res.status(404).json({ error: '존재하지 않는 channelId 입니다.' });
    }
    const roi = normalizeRoi({
      id: newId('roi'),
      channelId,
      name: name || `ROI-${cfg().rois.filter((r) => r.channelId === channelId).length + 1}`,
      points,
      threshold: clampPct(threshold, 30),
      label: label || cfg().alarmSettings.defaultLabel,
      classFilter: classFilter || null,
      color: pickColor(cfg().rois.length),
      thresholdMode,
      heightScale,
      thresholdM,
      thresholdMps
    });
    const err = validateRoi(roi);
    if (err) return res.status(400).json({ error: err });
    store.update((c) => c.rois.push(roi));
    res.status(201).json(roi);
  });

  router.put('/rois/:id', (req, res) => {
    const roi = cfg().rois.find((r) => r.id === req.params.id);
    if (!roi) return res.status(404).json({ error: 'not found' });
    const { name, points, threshold, label, classFilter, thresholdMode, heightScale, thresholdM, thresholdMps } = req.body || {};

    // 부분 수정이므로 "합쳐진 결과"를 기준으로 검사해야 한다 (예: 눈금값만 따로 고치는 경우).
    const merged = normalizeRoi({
      ...roi,
      ...(thresholdMode !== undefined ? { thresholdMode } : {}),
      ...(heightScale !== undefined ? { heightScale: { ...roi.heightScale, ...heightScale } } : {}),
      ...(thresholdM !== undefined ? { thresholdM } : {}),
      ...(thresholdMps !== undefined ? { thresholdMps } : {})
    });
    const err = validateRoi(merged);
    if (err) return res.status(400).json({ error: err });

    store.update((c) => {
      const target = c.rois.find((r) => r.id === req.params.id);
      if (name !== undefined) target.name = name;
      if (points !== undefined) target.points = points;
      if (threshold !== undefined) target.threshold = clampPct(threshold, target.threshold);
      if (label !== undefined) target.label = label;
      if (classFilter !== undefined) target.classFilter = classFilter;
      target.thresholdMode = merged.thresholdMode;
      target.heightScale = merged.heightScale;
      target.thresholdM = merged.thresholdM;
      target.thresholdMps = merged.thresholdMps;
    });
    // 판정 기준이 바뀌면 이전 모드의 상태(진행 중 알람, 평활화 이력)를 그대로 끌고 가면 안 된다.
    if (thresholdMode !== undefined && thresholdMode !== roi.thresholdMode) {
      roiEngine.purge({ channelId: roi.channelId, roiId: roi.id });
    }
    res.json(cfg().rois.find((r) => r.id === req.params.id));
  });

  // 개별 ROI 삭제
  router.delete('/rois/:id', (req, res) => {
    const roi = cfg().rois.find((r) => r.id === req.params.id);
    if (!roi) return res.status(404).json({ error: 'not found' });
    store.update((c) => { c.rois = c.rois.filter((r) => r.id !== req.params.id); });
    roiEngine.purge({ channelId: roi.channelId, roiId: roi.id });
    res.status(204).end();
  });

  // 채널의 ROI 전체 삭제: DELETE /rois/by-channel/:channelId
  router.delete('/rois/by-channel/:channelId', (req, res) => {
    store.update((c) => { c.rois = c.rois.filter((r) => r.channelId !== req.params.channelId); });
    roiEngine.purge({ channelId: req.params.channelId });
    res.status(204).end();
  });

  // 전체 채널 ROI 모두 삭제
  router.delete('/rois', (req, res) => {
    store.update((c) => { c.rois = []; });
    roiEngine.purge();
    res.status(204).end();
  });

  // ---- TCP 추론 소스 (mode: client = VMS가 접속 / server = VMS가 포트를 열고 대기) ----
  router.post('/tcp-connections', (req, res) => {
    const { ip, port, label, enabled = true, autoReconnect = true } = req.body || {};
    const mode = req.body?.mode === 'server' ? 'server' : 'client';
    const portNum = Number(port);
    if (!isValidPort(portNum)) return res.status(400).json({ error: 'port는 1~65535 사이여야 합니다.' });
    if (mode === 'client' && !ip) return res.status(400).json({ error: '접속(client) 모드에서는 ip가 필수입니다.' });
    const bindConflict = mode === 'server' && findListenConflict(portNum, ip, null);
    if (bindConflict) return res.status(409).json({ error: `포트 ${portNum}은 "${bindConflict.label}"이(가) 이미 수신 대기 중입니다.` });
    const pairedSourceId = req.body?.pairedSourceId || null;
    const pairErr = checkPairedSource(pairedSourceId, null);
    if (pairErr) return res.status(400).json({ error: pairErr });

    const conn = normalizeTcpConnection({
      id: newId('tcp'), mode, ip, port: portNum, label, enabled: !!enabled, autoReconnect: !!autoReconnect, pairedSourceId
    });
    store.update((c) => c.tcpConnections.push(conn));
    res.status(201).json(conn);
  });

  router.put('/tcp-connections/:id', (req, res) => {
    const conn = cfg().tcpConnections.find((c) => c.id === req.params.id);
    if (!conn) return res.status(404).json({ error: 'not found' });
    const { ip, port, label, enabled, autoReconnect, mode } = req.body || {};
    const nextMode = mode === undefined ? (conn.mode || 'client') : (mode === 'server' ? 'server' : 'client');
    const nextPort = port === undefined ? conn.port : Number(port);
    const nextIp = ip === undefined ? conn.ip : ip;
    if (!isValidPort(nextPort)) return res.status(400).json({ error: 'port는 1~65535 사이여야 합니다.' });
    if (nextMode === 'server') {
      const bindConflict = findListenConflict(nextPort, nextIp, conn.id);
      if (bindConflict) return res.status(409).json({ error: `포트 ${nextPort}은 "${bindConflict.label}"이(가) 이미 수신 대기 중입니다.` });
    }
    const { pairedSourceId } = req.body || {};
    if (pairedSourceId !== undefined) {
      const pairErr = checkPairedSource(pairedSourceId || null, conn.id);
      if (pairErr) return res.status(400).json({ error: pairErr });
    }

    store.update((c) => {
      const idx = c.tcpConnections.findIndex((x) => x.id === req.params.id);
      const t = c.tcpConnections[idx];
      if (mode !== undefined) t.mode = nextMode;
      if (ip !== undefined) t.ip = ip;
      if (port !== undefined) t.port = nextPort;
      if (label !== undefined) t.label = label;
      if (enabled !== undefined) t.enabled = !!enabled;
      if (autoReconnect !== undefined) t.autoReconnect = !!autoReconnect;
      if (pairedSourceId !== undefined) t.pairedSourceId = pairedSourceId || null;
      // 접속 → 수신 대기로 바꾸면 ip가 바인딩 주소가 되므로 비어 있으면 모든 NIC로 채운다.
      c.tcpConnections[idx] = normalizeTcpConnection(t);
    });
    res.json(cfg().tcpConnections.find((c) => c.id === req.params.id));
  });

  /**
   * "채널 번호 기준 소스" 검사. 없는 소스, 자기 자신, 그리고 체인(기준 소스가 또 다른 소스를 기준으로 삼는 경우)은 막는다 —
   * 매칭은 한 단계만 따라가므로(matchSourceIdOf) 체인을 허용하면 화면에 고른 것과 실제 매칭이 달라진다.
   */
  function checkPairedSource(pairedId, selfId) {
    if (!pairedId) return null;
    const target = cfg().tcpConnections.find((c) => c.id === pairedId);
    if (!target) return '채널 번호 기준 소스가 존재하지 않습니다.';
    if (pairedId === selfId) return '자기 자신을 채널 번호 기준 소스로 지정할 수 없습니다.';
    if (target.pairedSourceId) return `"${target.label}"은(는) 이미 다른 소스의 번호를 따르고 있어 기준 소스로 쓸 수 없습니다.`;
    if (selfId && cfg().tcpConnections.some((c) => c.pairedSourceId === selfId)) {
      return '다른 소스가 이 소스를 번호 기준으로 쓰고 있어, 이 소스는 다른 소스를 기준으로 삼을 수 없습니다.';
    }
    return null;
  }

  /** 같은 포트를 두 항목이 동시에 열면 뒤엣것이 EADDRINUSE로 계속 실패하므로 미리 막는다. */
  function findListenConflict(port, ip, ignoreId) {
    const bind = (ip ?? '').toString().trim() || '0.0.0.0';
    return cfg().tcpConnections.find((c) =>
      c.id !== ignoreId && c.mode === 'server' && c.enabled !== false && Number(c.port) === Number(port) &&
      // 0.0.0.0(모든 NIC)은 어떤 주소와도 충돌한다.
      (bind === '0.0.0.0' || c.ip === '0.0.0.0' || c.ip === bind)
    ) || null;
  }

  router.delete('/tcp-connections/:id', (req, res) => {
    store.update((c) => {
      c.tcpConnections = c.tcpConnections.filter((x) => x.id !== req.params.id);
      // 이 소스로 한정돼 있던 채널은 "모든 소스"로 되돌린다 (없는 소스를 가리킨 채 조용히 안 받는 상태 방지).
      for (const ch of c.channels) if (ch.sourceId === req.params.id) ch.sourceId = null;
      // 이 소스를 채널 번호 기준으로 쓰던 소스도 자기 기준으로 되돌린다.
      for (const t of c.tcpConnections) if (t.pairedSourceId === req.params.id) t.pairedSourceId = null;
    });
    camObserver.forget(req.params.id);
    res.status(204).end();
  });

  /**
   * 소스별로 "최근 실제로 들어온 cam 번호"와 그것이 어느 채널로 매칭되는지.
   * 설정 > 채널/RTSP 탭이 이걸 주기적으로 읽어 cam ID 설정 실수를 눈에 보이게 한다.
   * 매칭 판정은 roiEngine과 완전히 같은 함수(findChannelForCam)를 쓴다.
   */
  router.get('/tcp-sources/observed-cams', (req, res) => {
    const channels = cfg().channels;
    const observed = camObserver.snapshot();
    const sources = {};
    for (const conn of cfg().tcpConnections) {
      sources[conn.id] = {
        label: conn.label,
        mode: conn.mode === 'server' ? 'server' : 'client',
        cams: (observed[conn.id] || []).map((c) => withMatch(c, conn.id))
      };
    }
    // 이제는 설정에 없는(삭제된) 소스에서 아직 관측이 남아 있을 수 있다 — 숨기지 말고 그대로 보여준다.
    for (const [connId, cams] of Object.entries(observed)) {
      if (sources[connId]) continue;
      sources[connId] = { label: '(삭제된 소스)', mode: null, cams: cams.map((c) => withMatch(c, connId)) };
    }
    res.json({ sources });

    function withMatch(cam, connId) {
      const ch = findChannelForCam(channels, cam.cam, matchSourceIdOf(cfg().tcpConnections, connId));
      return { ...cam, matchedChannelId: ch?.channelId ?? null, matchedTitle: ch?.title ?? null };
    }
  });

  // ---- 알람 설정 ----
  router.put('/alarm-settings', (req, res) => {
    store.update((c) => { c.alarmSettings = { ...c.alarmSettings, ...req.body }; });
    res.json(cfg().alarmSettings);
  });

  router.post('/alarm-settings/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
    const assetId = path.basename(req.file.path);
    // 이전 알람음 파일은 더 이상 아무도 가리키지 않으므로 지운다 — 안 지우면 업로드할 때마다 폴더에 쌓인다.
    const prev = cfg().alarmSettings.customAudioAssetId;
    if (prev && prev !== assetId) fs.unlink(path.join(store.alarmsDir(), prev), () => {});
    store.update((c) => { c.alarmSettings.customAudioAssetId = assetId; });
    res.json({ assetId, url: `/alarm-assets/${assetId}` });
  });

  router.delete('/alarm-settings/upload', (req, res) => {
    const assetId = cfg().alarmSettings.customAudioAssetId;
    if (assetId) {
      const p = path.join(store.alarmsDir(), assetId);
      fs.unlink(p, () => {});
    }
    store.update((c) => { c.alarmSettings.customAudioAssetId = null; });
    res.status(204).end();
  });

  // ---- 탐지(water/road) 오버레이 표시 여부 (침범률 계산은 항상 폴리곤 기준, 이 설정과 무관) ----
  router.put('/detection-settings', (req, res) => {
    const { showOverlay } = req.body || {};
    store.update((c) => {
      c.detectionSettings = { ...c.detectionSettings, ...(showOverlay !== undefined ? { showOverlay: !!showOverlay } : {}) };
    });
    res.json(cfg().detectionSettings);
  });

  // ---- 유속(flow_service) 표시/판정 기준 ----
  router.put('/flow-settings', (req, res) => {
    const { showVectors, fbMin, rMin } = req.body || {};
    const patch = {};
    if (showVectors !== undefined) patch.showVectors = !!showVectors;
    for (const [key, v] of [['fbMin', fbMin], ['rMin', rMin]]) {
      if (v === undefined) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 2) return res.status(400).json({ error: `${key}는 0~2 사이 숫자여야 합니다.` });
      patch[key] = n;
    }
    store.update((c) => { c.flowSettings = { ...c.flowSettings, ...patch }; });
    res.json(cfg().flowSettings);
  });

  // ---- MediaMTX 설정 ----
  router.put('/mediamtx-settings', wrap(async (req, res) => {
    store.update((c) => { c.mediamtx = { ...c.mediamtx, ...req.body }; });
    // 이 저장은 "전체 채널 재동기화" 트리거로도 쓰인다(MediaMTX를 나중에 띄운 경우 등) — 사용 안 함 채널까지 전부.
    await syncAllChannels(cfg().mediamtx, cfg().channels, { includeDisabled: true });
    res.json(cfg().mediamtx);
  }));

  // ---- 관제 화면 배치 (분할 수 + 채널 표시 순서) ----
  // 분할 수는 화면이 그릴 줄 아는 값만 받는다. 그 외 값이 저장되면 그리드가 엉뚱한 모양으로 그려진다.
  // order는 채널 ID 배열 — 빠진 채널/모르는 ID는 store.update(normalizeDisplay)가 보정한다.
  router.put('/display', (req, res) => {
    // custom(사용자분할 켜짐/꺼짐), customOrder(사용자분할에 고른 채널 ID 배열)도 같은 방식으로 받는다.
    const { layout, order, custom, customOrder } = req.body || {};
    if (layout !== undefined && !LAYOUT_OPTIONS.includes(Number(layout))) {
      return res.status(400).json({ error: `분할 수는 ${LAYOUT_OPTIONS.join(' / ')} 중 하나여야 합니다.` });
    }
    if (order !== undefined && !Array.isArray(order)) return res.status(400).json({ error: 'order는 채널 ID 배열이어야 합니다.' });
    if (customOrder !== undefined && !Array.isArray(customOrder)) return res.status(400).json({ error: 'customOrder는 채널 ID 배열이어야 합니다.' });
    store.update((c) => {
      if (layout !== undefined) c.display.layout = Number(layout);
      if (order !== undefined) c.display.order = order.map(String);
      if (custom !== undefined) c.display.custom = custom === true;
      if (customOrder !== undefined) c.display.customOrder = customOrder.map(String);
    });
    res.json(cfg().display);
  });

  // ---- 이벤트 로그 ----
  router.get('/events', (req, res) => {
    res.json(eventLog.list({ limit: Number(req.query.limit) || 100 }));
  });

  router.post('/events/:id/ack', (req, res) => {
    const found = eventLog.ack(req.params.id);
    if (!found) return res.status(404).json({ error: 'not found' });
    // 확인 처리된 채널×ROI는 "반복 경고 팝업 주기" 재알림 대상이 될 수 있도록 roiEngine에도 알린다.
    roiEngine.notifyAck(found.channelId, found.roiId);
    wsHub.broadcast({ type: 'event_ack', id: found.id });
    res.json(found);
  });

  router.get('/events/export.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');
    res.send('﻿' + eventLog.toCsv());
  });

  return router;
}

function slugify(title) {
  const base = title.toString().trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'ch') + '-' + Math.random().toString(36).slice(2, 6);
}
function isValidPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}
/**
 * 물높이(m)·유속(m/s) 기준 ROI가 실제로 판정 가능한 설정인지 검사한다 (normalizeRoi를 거친 객체를 받는다).
 * 여기서 막지 않으면 "저장은 됐는데 알람이 영영 안 울리는" 상태가 조용히 만들어진다.
 * 유속 ROI는 채널 유속 보정이 아직 없어도 저장은 허용한다(보정은 현장 측량 뒤에 넣는 경우가 많다) —
 * 보정이 없는 동안에는 화면에 "보정 전"으로 표시되고 알람은 울리지 않는다.
 */
function validateRoi(roi) {
  if (roi.thresholdMode === 'velocity') {
    if (!(roi.thresholdMps > 0)) return '임계 유속(m/s)을 0보다 큰 값으로 입력해야 합니다.';
    return null;
  }
  if (roi.thresholdMode !== 'height') return null;
  const { topM, bottomM, topY, bottomY } = roi.heightScale;
  if (topM === null || bottomM === null) return '상단/하단 기준선의 눈금값(m)을 모두 입력해야 합니다.';
  if (topM === bottomM) return '상단과 하단 기준선의 눈금값이 같으면 물높이를 계산할 수 없습니다.';
  if (topM < bottomM) return '상단 기준선의 눈금값이 하단보다 커야 합니다 (화면 위쪽이 더 높은 수위입니다).';
  // 기준선 위치는 생략 가능(= ROI 경계). 넣는다면 둘 다 있어야 하고 충분히 떨어져 있어야 한다.
  if (topY !== null || bottomY !== null) {
    if (topY === null || bottomY === null) return '기준선 위치는 상단/하단 둘 다 지정해야 합니다.';
    if (bottomY - topY < MIN_ANCHOR_GAP) return '두 기준선이 너무 가깝습니다. 더 멀리 떨어뜨려 놓으세요.';
  }
  if (roi.thresholdM === null) return '임계 물높이(m)를 입력해야 합니다.';
  return null;
}
function clampPct(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}
const PALETTE = ['#3aa0ff', '#ffb020', '#ff5c5c', '#4ade80', '#c084fc', '#f472b6'];
function pickColor(idx) {
  return PALETTE[idx % PALETTE.length];
}
