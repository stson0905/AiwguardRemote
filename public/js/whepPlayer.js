// 외부 라이브러리 없이 WHEP(WebRTC-HTTP Egress Protocol)로 MediaMTX 스트림을 재생한다.
// https://github.com/bluenviron/mediamtx 의 WHEP 엔드포인트를 사용.

function waitIceGatheringComplete(pc, timeoutMs = 3000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener('icegatheringstatechange', function onChange() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    });
  });
}

/** 구형 브라우저(AbortSignal.timeout 없음)에서는 타임아웃 없이 진행한다 */
function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/**
 * @param {HTMLVideoElement} videoEl
 * @param {string} whepUrl
 * @param {{onStateChange?: (state: RTCPeerConnectionState, pc: RTCPeerConnection) => void, timeoutMs?: number}} [opts]
 *   onStateChange: 연결 상태가 바뀔 때마다 호출된다(끊김 감지 → 타일이 재연결을 결정하는 데 쓴다).
 *   timeoutMs: WHEP 협상 HTTP 요청 제한 시간. MediaMTX가 응답하지 않으면 무한정 기다리지 않는다.
 * @returns {Promise<{pc: RTCPeerConnection, close: Function}>}
 */
export async function attachWhep(videoEl, whepUrl, { onStateChange, timeoutMs = 8000 } = {}) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  let sessionUrl = null;

  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.addEventListener('track', (ev) => {
      if (videoEl.srcObject !== ev.streams[0]) {
        videoEl.srcObject = ev.streams[0];
      }
    });
    if (onStateChange) {
      pc.addEventListener('connectionstatechange', () => onStateChange(pc.connectionState, pc));
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc);

    const res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
      signal: timeoutSignal(timeoutMs)
    });
    if (!res.ok) throw new Error(`WHEP negotiation failed (${res.status})`);
    // 세션 주소(Location). 닫을 때 DELETE를 보내면 MediaMTX가 ICE 타임아웃을 기다리지 않고 바로 세션을 정리해
    // (sourceOnDemand인 RTSP 소스도 곧 놓아준다) 재연결/채널 교체가 잦을 때 MediaMTX 쪽 자원이 덜 쌓인다.
    const loc = res.headers.get('location');
    if (loc) {
      try { sessionUrl = new URL(loc, whepUrl).href; } catch { /* 주소가 이상하면 DELETE는 생략 */ }
    }
    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch (err) {
    // 어느 단계에서 실패하든 PeerConnection을 닫아야 브라우저의 WebRTC 자원(스레드/소켓)이 새지 않는다.
    try { pc.close(); } catch { /* 이미 닫힘 */ }
    throw err;
  }

  return {
    pc,
    close() {
      try { pc.close(); } catch { /* 이미 닫힘 */ }
      videoEl.srcObject = null;
      if (sessionUrl) {
        fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {});
        sessionUrl = null;
      }
    }
  };
}
