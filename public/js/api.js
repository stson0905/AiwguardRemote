// REST API 얇은 래퍼
async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const api = {
  getConfig: () => req('GET', '/api/config'),

  getAppInfo: () => req('GET', '/api/app-info'),
  getBackupInfo: () => req('GET', '/api/backup-info'),
  // 비밀번호 확인은 서버에서만 한다 — 실패하면 서버가 준 사유가 예외 메시지로 올라온다.
  unlockDevMode: (password) => req('POST', '/api/dev-mode/unlock', { password }),

  addChannel: (data) => req('POST', '/api/channels', data),
  updateChannel: (id, data) => req('PUT', `/api/channels/${id}`, data),
  deleteChannel: (id) => req('DELETE', `/api/channels/${id}`),
  // 여러 채널을 한 번에 — 서버가 한 번만 저장하고 한 번만 알리므로 64채널도 즉시 처리된다.
  addChannelsBulk: (channels) => req('POST', '/api/channels/bulk', { channels }),
  deleteChannelsBulk: (ids) => req('POST', '/api/channels/bulk-delete', { ids }),
  updateChannelsBulk: (ids, patch) => req('POST', '/api/channels/bulk-update', { ids, patch }),

  addRoi: (data) => req('POST', '/api/rois', data),
  updateRoi: (id, data) => req('PUT', `/api/rois/${id}`, data),
  deleteRoi: (id) => req('DELETE', `/api/rois/${id}`),
  deleteRoisByChannel: (channelId) => req('DELETE', `/api/rois/by-channel/${channelId}`),
  deleteAllRois: () => req('DELETE', '/api/rois'),

  addTcpConnection: (data) => req('POST', '/api/tcp-connections', data),
  updateTcpConnection: (id, data) => req('PUT', `/api/tcp-connections/${id}`, data),
  deleteTcpConnection: (id) => req('DELETE', `/api/tcp-connections/${id}`),
  // 소스가 실제로 보내고 있는 cam 번호 + 그것이 어느 채널로 매칭되는지 (cam ID 설정 대조용)
  getObservedCams: () => req('GET', '/api/tcp-sources/observed-cams'),

  updateAlarmSettings: (data) => req('PUT', '/api/alarm-settings', data),
  updateDetectionSettings: (data) => req('PUT', '/api/detection-settings', data),
  updateFlowSettings: (data) => req('PUT', '/api/flow-settings', data),
  saveFlowCalibration: (channelDbId, data) => req('PUT', `/api/channels/${channelDbId}/flow-calibration`, data),
  deleteFlowCalibration: (channelDbId) => req('DELETE', `/api/channels/${channelDbId}/flow-calibration`),
  removeAlarmAudio: () => req('DELETE', '/api/alarm-settings/upload'),

  updateMediamtxSettings: (data) => req('PUT', '/api/mediamtx-settings', data),

  updateDisplay: (data) => req('PUT', '/api/display', data),

  listEvents: (limit = 100) => req('GET', `/api/events?limit=${limit}`),
  ackEvent: (id) => req('POST', `/api/events/${id}/ack`),

  async uploadAlarmAudio(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/alarm-settings/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('업로드 실패');
    return res.json();
  }
};
