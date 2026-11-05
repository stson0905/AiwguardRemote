// 채널 x ROI 별 침범 판정 상태머신. TCP로 들어온 detection 프레임(세그멘테이션 폴리곤)을 소비해
// 임계값 초과 시 alarm 이벤트를, 해제 시 alarm_clear 이벤트를 발행한다.
//
// ROI마다 판정 기준이 세 가지다 (roi.thresholdMode):
//  - 'percent' (기본): ROI 면적 중 water 폴리곤이 덮은 비율(%)이 임계값 이상이면 알람
//  - 'height'        : 교각 수위표에 그린 ROI 안에서 읽어낸 물높이(m)가 임계 수위 이상이면 알람
//  - 'velocity'      : 유속 서비스가 보낸 광류를 채널 보정으로 환산한 유속(m/s)이 임계값 이상이면 알람.
//                      물 탐지 프레임(handleDetection)이 아니라 유속 결과(handleFlowSpeed, flowEngine이 호출)로 판정하지만,
//                      쿨다운·히스테리시스·확인(Ack)·재알림은 아래의 같은 상태머신을 그대로 쓴다.
import { EventEmitter } from 'node:events';
import { roiCoverageRatio } from './intrusion.js';
import { isHeightRoi, measureWaterLevel, metersToY, yToMeters, roiYBounds, median } from './waterLevel.js';

/**
 * 물높이는 최근 alarmSettings.levelSmoothSec 초 동안 읽은 값들의 "중앙값"으로 평활화한다.
 * 실제 하천은 파도·물보라 때문에 수면선이 초 단위로 출렁이고(실측: 30초 동안 0.55~0.98m),
 * 매 프레임 값을 그대로 쓰면 임계 수위 근처에서 알람이 켜졌다 꺼졌다 한다.
 * 평균이 아니라 중앙값을 쓰는 이유는 순간적으로 크게 튄 프레임에 끌려가지 않기 위해서다.
 *
 * 프레임 수가 아니라 시간으로 창을 잡는 이유: 소스마다 전송 주기가 달라서(1fps~10fps) 프레임 수로 잡으면
 * 실제 평활화 구간이 소스에 따라 제멋대로 달라진다.
 */
const LEVEL_SAMPLE_CAP = 600; // 고프레임 소스에서 표본 배열이 무한정 커지지 않도록 하는 상한

/**
 * 좌표 한 프레임이 어느 채널로 갈지 정하는 규칙.
 * 보드/윈도우 프로그램의 cam 번호는 채널 설정의 "cam ID"(camId)와 매칭한다 (channelId 문자열과는 별개).
 * 소스가 여럿일 때 cam 번호가 겹칠 수 있으므로(예: Jetson도 1번, 윈도우도 1번), 채널에 sourceId가
 * 지정돼 있으면 그 소스에서 온 좌표만 받는다. sourceId가 null이면 어느 소스든 받는다.
 *
 * 설정 화면의 "수신 현황" 표시(routes/api.js)도 이 함수를 그대로 쓴다 — 규칙이 두 곳에 복사되면
 * "화면에는 매핑됐다고 나오는데 실제로는 안 받는" 최악의 상황이 생기므로 반드시 여기 한 곳만 둔다.
 * @returns {object|null} 매칭된 채널, 없으면 null (그 좌표는 버려진다)
 */
export function findChannelForCam(channels, cam, connId) {
  const sameCam = channels.filter((c) => c.camId != null && String(c.camId) === String(cam));
  // 소스를 명시한 채널이 우선, 없으면 "모든 소스"(sourceId=null) 채널이 받는다.
  return sameCam.find((c) => c.sourceId && c.sourceId === connId)
    || sameCam.find((c) => !c.sourceId)
    || null;
}

/**
 * 이 소스의 cam 번호를 어느 소스의 번호 체계로 매칭할지 (findChannelForCam 의 connId 로 넘길 값).
 * 소스에 "채널 번호 기준 소스"(pairedSourceId)가 지정돼 있으면 그 소스로 온 것처럼 매칭한다 — 유속 서비스가
 * AI W-Guard 와 같은 번호를 보내므로, 채널이 AI W-Guard 로 한정돼 있어도 같은 채널에 붙게 하려는 것이다.
 * findChannelForCam 과 마찬가지로 규칙은 여기 한 곳에만 둔다(침수 판정·유속·설정 화면 수신 현황이 공유).
 */
export function matchSourceIdOf(connections, connId) {
  const paired = (connections || []).find((c) => c.id === connId)?.pairedSourceId;
  return paired && connections.some((c) => c.id === paired) ? paired : connId;
}

/**
 * key = `${channelId}::${roiId}` 상태:
 *  { state: 'OK'|'ALARM', value: number, alarmSince: number|null, lastClearAt: number,
 *    lastNotifiedAt: number, acked: boolean, levelHistory: number[] }
 * value는 판정 기준값 — percent 모드면 침범률(%), height 모드면 물높이(m).
 */
export class RoiEngine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.states = new Map();
    /**
     * key -> 아직 확인(Ack)되지 않은 채 진행 중인 알람 이벤트 레코드.
     * 알람은 OK→ALARM으로 "바뀌는 순간"에만 브로드캐스트되므로, 그 뒤에 접속한(또는 새로고침한)
     * 브라우저는 침수가 계속되는 중인데도 화면에 팝업이 하나도 없는 상태가 된다.
     * 그래서 진행 중인 알람을 여기 들고 있다가 새 접속 시 init에 실어 다시 띄운다.
     */
    this.activeAlarms = new Map();
  }

  reset() {
    this.states.clear();
    this.activeAlarms.clear();
  }

  /** channelId 하나가 사라지거나 ROI가 삭제되었을 때 관련 상태 정리 */
  purge({ channelId, roiId } = {}) {
    for (const map of [this.states, this.activeAlarms]) {
      for (const key of [...map.keys()]) {
        const [ch, roi] = key.split('::');
        if (channelId && ch !== channelId) continue;
        if (roiId && roi !== roiId) continue;
        map.delete(key);
      }
    }
  }

  /** 클라이언트가 이벤트를 확인(Ack)했을 때 호출 — 확인된 채널×ROI는 이후 반복 경고 팝업 재알림 대상이 된다. */
  notifyAck(channelId, roiId) {
    const st = this.states.get(`${channelId}::${roiId}`);
    if (st) st.acked = true;
    // 확인된 알람은 새로고침해도 다시 띄우지 않는다(침수가 계속되면 repeatPopupMinutes 주기로 새 알람이 뜬다).
    this.activeAlarms.delete(`${channelId}::${roiId}`);
  }

  /**
   * 발행된 알람에 이벤트 로그 id가 붙은 최종 레코드를 기억해 둔다(server/index.js에서 호출).
   * id까지 같이 보관해야 새 접속에서 다시 띄운 팝업의 "확인" 버튼이 원래 이벤트를 Ack할 수 있다.
   */
  rememberActiveAlarm(record) {
    if (!record?.channelId || !record?.roiId) return;
    this.activeAlarms.set(`${record.channelId}::${record.roiId}`, record);
  }

  /**
   * 지금 경보(ALARM) 상태인 채널×ROI 전부 — 확인(Ack) 여부와 상관없다. 화면의 페이지 지도/채널 목록이
   * "어느 채널이 아직 침수 중인지"를 보여주는 데 쓴다(팝업을 확인해 닫아도 침수가 계속되면 표시가 남아야 한다).
   */
  getAlarmingRois() {
    const out = [];
    for (const [key, st] of this.states) {
      if (st.state !== 'ALARM') continue;
      const [channelId, roiId] = key.split('::');
      out.push({ channelId, roiId });
    }
    return out;
  }

  /** 새로 접속한 브라우저에 다시 띄워 줄, 진행 중이며 아직 확인되지 않은 알람 목록 */
  getActiveAlarms() {
    return [...this.activeAlarms.values()];
  }

  /**
   * TCP에서 올라온 한 프레임(cam 번호 + water/road 폴리곤들)을 처리.
   *
   * 시각은 소스가 보낸 ts_ms가 아니라 **도착 시각(서버 시계)** 으로 다룬다. 쿨다운/재알림 주기/평활화 창은
   * 모두 "얼마나 지났는가"인데, 보드 시계가 어긋나 있거나(RTC 없이 재부팅한 Jetson 등) 소스마다 시계가
   * 다르면 소스 ts로는 이 간격이 엉망이 된다(쿨다운이 안 걸리거나 재알림이 영영 안 뜨는 식).
   * 소스가 보낸 원래 값은 sourceTs로 같이 실어 보낸다(진단용).
   */
  handleDetection({ cam, ts: sourceTs, objects, connId }) {
    const cfg = this.store.get();
    const channel = findChannelForCam(cfg.channels, cam, matchSourceIdOf(cfg.tcpConnections, connId));
    // camId가 매핑되지 않은 cam의 좌표는 무시한다. 다만 그냥 버리기만 하면 설정 실수를 알아챌 방법이
    // 없으므로, 들어온 cam 번호 자체는 camObserver가 따로 기록해 설정 화면에 보여준다.
    if (!channel) return;
    const channelId = channel.channelId;
    const ts = Date.now();

    const rois = cfg.rois.filter((r) => r.channelId === channelId && r.points?.length >= 3);
    if (rois.length === 0) {
      this.emit('frame', { channelId, ts, sourceTs, objects, intrusions: [] });
      return;
    }

    // 계산은 항상 원본(water/road) 폴리곤 기준 — 정확도를 위해 bbox 근사는 쓰지 않는다.
    // (화면에 이 폴리곤을 그릴지는 순전히 detectionSettings.showOverlay의 표시 여부 문제이며 계산과 무관)
    const intrusions = [];
    // 같은 클래스의 폴리곤 목록은 ROI가 여러 개여도 한 번만 추린다.
    const polygonsByClass = new Map();
    for (const roi of rois) {
      // classFilter 미지정 시 기본적으로 'water'(침수 감지 폴리곤)만 계산에 사용.
      const targetClass = roi.classFilter || 'water';
      let polygons = polygonsByClass.get(targetClass);
      if (!polygons) {
        polygons = [];
        for (const o of objects) if (o.cls === targetClass) polygons.push(o.polygon);
        polygonsByClass.set(targetClass, polygons);
      }
      if (roi.thresholdMode === 'velocity') {
        // 유속 ROI는 여기서 판정하지 않는다(침범률로 판정하면 유속 알람이 엉뚱하게 켜지고 꺼진다). 침범률은 참고로만 싣는다.
        intrusions.push({ roiId: roi.id, roiName: roi.name, mode: 'velocity', ratePct: roiCoverageRatio(roi.points, polygons) * 100 });
        continue;
      }
      const metrics = this._measure(channel, roi, polygons, ts);
      intrusions.push({ roiId: roi.id, roiName: roi.name, ...metrics });
      this._evaluate(channel, roi, metrics, ts);
    }

    this.emit('frame', { channelId, ts, sourceTs, objects, intrusions });
  }

  /**
   * 유속(m/s) ROI 하나의 새 측정값(flowEngine이 유속 결과마다 호출). 최근 alarmSettings.flowSmoothSec 초의 중앙값으로
   * 평활화한 값으로 판정하고, 그 값을 돌려준다(화면에 보여 줄 숫자와 판정에 쓴 숫자를 같게 하려고).
   * speedMps가 null(보정 없음, 믿을 칸 없음)이면 이력에 넣지 않고 상태도 바꾸지 않는다.
   * @returns {number|null} 평활화된 유속(m/s)
   */
  handleFlowSpeed(channel, roi, speedMps, now = Date.now()) {
    const st = this._stateFor(`${channel.channelId}::${roi.id}`);
    const windowMs = Math.max(0, Number(this.store.get().alarmSettings.flowSmoothSec) || 0) * 1000;
    if (speedMps != null && Number.isFinite(speedMps)) {
      st.flowHistory.push({ at: now, v: speedMps });
      while (st.flowHistory.length > LEVEL_SAMPLE_CAP) st.flowHistory.shift();
    }
    while (st.flowHistory.length > 1 && now - st.flowHistory[0].at > windowMs) st.flowHistory.shift();
    // 창보다 오래된 값 하나만 남은 경우(유속 결과가 끊긴 뒤)는 판정에 쓰지 않는다 — 멈춘 값으로 알람을 켜거나 끄지 않도록.
    const fresh = st.flowHistory.filter((s) => now - s.at <= Math.max(windowMs, 5000));
    const smoothed = fresh.length ? round(median(fresh.map((s) => s.v)), 3) : null;
    this._evaluate(channel, roi, { mode: 'velocity', speedMps: smoothed }, now);
    return smoothed;
  }

  _stateFor(key) {
    let st = this.states.get(key);
    if (!st) {
      st = { state: 'OK', value: 0, alarmSince: null, lastClearAt: 0, lastNotifiedAt: 0, acked: false, levelHistory: [], flowHistory: [] };
      this.states.set(key, st);
    }
    return st;
  }

  /**
   * ROI 한 개의 이번 프레임 측정값. 침범률(%)은 모드와 무관하게 항상 계산하고(화면 표시용),
   * height 모드면 수위표 눈금 기준 물높이(m)를 추가로 읽는다.
   */
  _measure(channel, roi, polygons, now) {
    const st = this._stateFor(`${channel.channelId}::${roi.id}`);
    const ratePct = roiCoverageRatio(roi.points, polygons) * 100;

    if (!isHeightRoi(roi)) {
      st.levelHistory.length = 0; // 모드를 되돌렸을 때 옛 이력이 남지 않도록
      return { mode: 'percent', ratePct };
    }

    const m = measureWaterLevel(roi.points, polygons, roi.heightScale);
    // 표본의 시각은 소스가 보낸 ts가 아니라 도착 시각을 쓴다 — 소스 시계가 어긋나 있어도 창이 망가지지 않는다.
    const windowMs = Math.max(0, Number(this.store.get().alarmSettings.levelSmoothSec) || 0) * 1000;
    st.levelHistory.push({ at: now, v: m.levelM });
    while (st.levelHistory.length > LEVEL_SAMPLE_CAP) st.levelHistory.shift();
    // 가장 최근 표본 하나는 항상 남긴다 (평활화 0초 = 평활화 안 함).
    while (st.levelHistory.length > 1 && now - st.levelHistory[0].at > windowMs) st.levelHistory.shift();
    const bounds = roiYBounds(roi.points);
    const levelM = round(median(st.levelHistory.map((s) => s.v)), 3);
    // 화면에 그릴 수면선은 평활화된 값에서 되돌려 계산한다 — 숫자와 선이 서로 다른 값을 가리키지 않도록.
    const waterY = levelM == null ? null : metersToY(levelM, roi.heightScale, bounds);

    return {
      mode: 'height',
      ratePct,
      levelM,
      waterY,
      // 이번 프레임에서 실제로 찾은 수면선(평활화 전). 기준선을 맞출 때 "지금 이 순간 화면"과 대조해야 하고,
      // 눈금 기준자와 무관한 순수 기하값이라 설정 화면이 저장 전 값으로 다시 환산해 미리보기를 만들 수 있다.
      waterYRaw: m.waterY,
      thresholdM: Number.isFinite(Number(roi.thresholdM)) ? Number(roi.thresholdM) : null,
      detected: m.detected,
      // "눈금 범위를 벗어남" 표시는 화면에 실제로 보여줄 평활화된 값 기준으로 판단한다
      // (프레임 하나의 판정을 그대로 쓰면 "< 0.83m"처럼 값과 부등호가 서로 안 맞는 표시가 나온다).
      saturated: saturationOf(levelM, roi.heightScale, bounds)
    };
  }

  _evaluate(channel, roi, metrics, ts) {
    const key = `${channel.channelId}::${roi.id}`;
    const alarmSettings = this.store.get().alarmSettings;
    const mode = metrics.mode;
    const height = mode === 'height';
    const velocity = mode === 'velocity';
    // 판정 기준값과 임계값/히스테리시스는 모드에 따라 단위가 통째로 바뀐다 (%, m, m/s).
    const value = height ? metrics.levelM : velocity ? metrics.speedMps : metrics.ratePct;
    const threshold = height ? Number(roi.thresholdM) : velocity ? Number(roi.thresholdMps) : (Number(roi.threshold) || 0);
    // 임계값이 "설정되어 있는가". 물높이는 눈금값이므로 0m나 음수도 정상적인 임계값이 될 수 있어
    // (예: 하단 눈금이 -0.5m인 수위표의 0m 지점) 침범률처럼 >0으로 판단하면 안 된다. 유속은 0보다 커야 의미가 있다.
    const armed = height ? Number.isFinite(threshold) : threshold > 0;
    const hysteresis = height
      ? (Number(alarmSettings.hysteresisM) || 0)
      : velocity
        ? (Number(alarmSettings.hysteresisMps) || 0)
        : (Number(alarmSettings.hysteresisPct) || 0);
    const cooldownMs = (Number(alarmSettings.cooldownSec) || 0) * 1000;
    // 확인(Ack) 여부와 무관하게, 침수가 계속 감지되는 동안 이 주기(분)마다 팝업을 다시 띄운다. 0 이하면 반복 안 함.
    const repeatPopupMs = (Number(alarmSettings.repeatPopupMinutes) || 0) * 60_000;

    const st = this._stateFor(key);
    if (value == null) return; // 아직 읽어낸 값이 없음(눈금 기준자 미설정 등) — 상태를 바꾸지 않는다
    st.value = value;

    if (st.state === 'OK') {
      if (armed && value >= threshold) {
        if (ts - st.lastClearAt < cooldownMs) return; // 쿨다운 중이면 재발생 억제
        st.state = 'ALARM';
        st.alarmSince = ts;
        st.lastNotifiedAt = ts;
        st.acked = false;
        this._emitAlarm(channel, roi, metrics, threshold, ts, alarmSettings);
      }
    } else if (st.state === 'ALARM') {
      if (value < threshold - hysteresis) {
        st.state = 'OK';
        st.lastClearAt = ts;
        st.alarmSince = null;
        this.activeAlarms.delete(key);
        this.emit('alarm_clear', { channelId: channel.channelId, roiId: roi.id, ts });
      } else if (repeatPopupMs > 0 && st.acked && ts - st.lastNotifiedAt >= repeatPopupMs) {
        // 임계값을 계속 넘긴 상태로 지속 중이고, 직전 팝업은 이미 확인(Ack)됨 — 재알림 팝업을 새로 띄운다.
        // (아직 확인 전인 팝업은 클라이언트의 사운드 반복(초단위)으로 이미 알리고 있으므로 여기서 중복 생성하지 않는다.)
        st.lastNotifiedAt = ts;
        st.acked = false;
        this._emitAlarm(channel, roi, metrics, threshold, ts, alarmSettings);
      }
    }
  }

  _emitAlarm(channel, roi, metrics, threshold, ts, alarmSettings) {
    const height = metrics.mode === 'height';
    const velocity = metrics.mode === 'velocity';
    this.emit('alarm', {
      channelId: channel.channelId,
      channelTitle: channel.title,
      roiId: roi.id,
      roiName: roi.name,
      label: roi.label || alarmSettings.defaultLabel || '침수발생',
      mode: metrics.mode,
      // 침범률은 침범률·물높이 모드에서 참고값으로 같이 남긴다(이벤트 로그/CSV에서 상황 파악에 유용).
      // 유속 판정은 유속 결과로만 이뤄져 그 순간의 침범률이 없다.
      ratePct: velocity ? null : round(metrics.ratePct, 1),
      // 임계값은 그 모드에서 실제로 쓰인 것만 채운다 — 안 쓰인 쪽이 남아 있으면 로그를 오해하게 된다.
      threshold: height || velocity ? null : threshold,
      levelM: height ? round(metrics.levelM, 2) : null,
      thresholdM: height ? threshold : null,
      speedMps: velocity ? round(metrics.speedMps, 2) : null,
      thresholdMps: velocity ? threshold : null,
      ts
    });
  }
}

/**
 * 읽어낸 수위가 ROI가 덮는 범위의 위/아래 끝에 붙어 있는지 (그 바깥의 실제 수면 위치는 볼 수 없다).
 * 기준은 기준선 눈금값이 아니라 **ROI가 화면에서 덮고 있는 구간**이다 — 기준선은 ROI 안쪽 임의 위치에
 * 놓을 수 있으므로 ROI가 그보다 더 넓은 범위를 볼 수 있다.
 */
function saturationOf(levelM, scale, bounds) {
  if (levelM == null) return null;
  if (levelM <= yToMeters(bounds.maxY, scale, bounds)) return 'below';
  if (levelM >= yToMeters(bounds.minY, scale, bounds)) return 'above';
  return null;
}

function round(v, digits) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
