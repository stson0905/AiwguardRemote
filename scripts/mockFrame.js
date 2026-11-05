// 모의 추론 프레임 생성기 — mockJetsonServer.js(수동 접속형)와 mockWindowsClient.js(밀어넣기형)가 공유한다.
// 실제 보드/윈도우 프로그램에서 확인된 메시지 포맷과 동일하다 (docs/PROTOCOL.md 참고).

/**
 * 화면을 원을 그리며 도는 가짜 water(침수) 폴리곤 한 프레임을 만든다.
 * @param {string|number} cam 카메라 번호 (채널 설정의 "cam ID"와 맞춰야 함)
 * @param {number} frameIdx 프레임 순번
 * @param {string} [titlePrefix] 소스 구분용 title 접두사
 */
export function makeDetectionFrame(cam, frameIdx, titlePrefix = '모의채널') {
  const t = Date.now() / 1000;
  const size = 0.18 + 0.14 * Math.sin(t / 3);
  const cx = 0.5 + 0.32 * Math.sin(t / 6);
  const cy = 0.5 + 0.32 * Math.cos(t / 6);
  const half = size / 2;

  // 정사각형이 아니라 살짝 찌그러진 사각 폴리곤으로 흉내
  const waterPolygon = [
    [clamp01(cx - half), clamp01(cy - half)],
    [clamp01(cx + half), clamp01(cy - half * 0.9)],
    [clamp01(cx + half * 0.9), clamp01(cy + half)],
    [clamp01(cx - half * 0.9), clamp01(cy + half * 0.9)]
  ];

  return {
    type: 'detect',
    cam: Number(cam),
    title: `${titlePrefix}${cam}`,
    ts_ms: Date.now(),
    frame_idx: frameIdx,
    frame: { w: 1920, h: 1080 },
    area_roi: null,
    avg_window_sec: 20,
    alarm_interval_min: 1,
    water: [waterPolygon],
    road: []
  };
}

export function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}
