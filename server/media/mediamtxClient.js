// MediaMTX(별도 프로세스로 구동) REST API와 통신해 채널의 RTSP 소스를 path로 동기화하고
// 브라우저 재생용 WHEP(WebRTC)/HLS URL을 계산한다.
// MediaMTX API 문서: https://github.com/bluenviron/mediamtx#api

function apiBase(mediamtxCfg) {
  return `http://${mediamtxCfg.host}:${mediamtxCfg.apiPort}`;
}

async function safeFetch(url, options) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(4000) });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

/** 채널을 MediaMTX path로 추가/갱신 (없으면 add, 있으면 replace 시도) */
export async function syncChannelPath(mediamtxCfg, channel) {
  if (!channel.rtspUrl) return { ok: false, error: 'rtspUrl 없음' };
  const base = apiBase(mediamtxCfg);
  const body = JSON.stringify({ source: channel.rtspUrl, sourceOnDemand: true });
  const headers = { 'Content-Type': 'application/json' };

  let res = await safeFetch(`${base}/v3/config/paths/add/${encodeURIComponent(channel.channelId)}`, {
    method: 'POST', headers, body
  });
  if (!res.ok) {
    // 이미 존재하는 path면 replace로 재시도
    res = await safeFetch(`${base}/v3/config/paths/replace/${encodeURIComponent(channel.channelId)}`, {
      method: 'POST', headers, body
    });
  }
  return res;
}

export async function removeChannelPath(mediamtxCfg, channelId) {
  const base = apiBase(mediamtxCfg);
  return safeFetch(`${base}/v3/config/paths/delete/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
}

/** 동시에 보내는 MediaMTX API 호출 수 — 64채널을 순서대로 하면 응답 없는 호스트에서 수 분이 걸린다. */
const SYNC_CONCURRENCY = 8;

/**
 * 여러 채널의 path를 한꺼번에 동기화한다(동시 SYNC_CONCURRENCY개씩).
 * 기본은 사용 중(enabled)인 채널만, includeDisabled=true면 전부.
 */
export async function syncAllChannels(mediamtxCfg, channels, { includeDisabled = false } = {}) {
  const list = includeDisabled ? [...channels] : channels.filter((c) => c.enabled !== false);
  const results = {};
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const ch = list[next++];
      results[ch.channelId] = await syncChannelPath(mediamtxCfg, ch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, list.length) }, worker));
  return results;
}

export function whepUrl(mediamtxCfg, channelId) {
  return `http://${mediamtxCfg.host}:${mediamtxCfg.whepPort}/${encodeURIComponent(channelId)}/whep`;
}

export function hlsUrl(mediamtxCfg, channelId) {
  return `http://${mediamtxCfg.host}:${mediamtxCfg.hlsPort}/${encodeURIComponent(channelId)}/index.m3u8`;
}

export async function pingApi(mediamtxCfg) {
  const base = apiBase(mediamtxCfg);
  const res = await safeFetch(`${base}/v3/paths/list`);
  return res.ok;
}
