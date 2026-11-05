// 소스(TCP 연결)별로 "최근에 어떤 cam 번호가 실제로 들어왔는지"를 기억하는 관찰자.
//
// 존재 이유: 채널 설정의 cam ID가 소스가 보내는 번호와 어긋나면 좌표가 조용히 버려지기만 한다
// (roiEngine.handleDetection이 매칭 실패 시 그냥 return). 화면에 아무 표시도 없어서 원인을 찾기가
// 매우 어렵다 — 2026-09-07에 실제로 겪음: AI W-Guard는 화면 이름이 T5~T8이어도 채널 번호는
// RTSP_URL 순번대로 1~4를 보내는데, 설정에는 5~8로 넣어 두어 4개 채널이 통째로 먹통이었다.
// 그래서 "실제로 들어오는 번호"를 설정 화면에 그대로 보여주고 미매핑을 경고한다.

const DEFAULT_TTL_MS = 60_000; // 이 시간 넘게 안 들어온 cam은 목록에서 지운다
const MAX_CAMS_PER_SOURCE = 128; // 채널 최대 개수(store.js MAX_CHANNELS)와 맞춘다 — 작으면 정상 cam 번호가 목록에서 밀려난다

export class CamObserver {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, Map<string, {cam:string,title:string|null,lastSeen:number,frameIdx:number|null,polygons:number,count:number}>>} */
    this.bySource = new Map();
  }

  /** tcpSourceManager의 detection / flow 이벤트를 그대로 받는다(kind로 구분해 설정 화면에 표시). */
  record({ connId, cam, title, frameIdx, objects, kind }) {
    if (cam === undefined || cam === null) return;
    const sourceKey = connId || '(unknown)';
    let cams = this.bySource.get(sourceKey);
    if (!cams) {
      cams = new Map();
      this.bySource.set(sourceKey, cams);
    }

    const camKey = String(cam);
    const info = cams.get(camKey);
    if (info) {
      // 매 프레임 불리는 경로라 새 객체를 만들지 않고 제자리에서 갱신한다.
      // 제목은 매 프레임 오지 않을 수도 있으니 한 번 받은 값을 유지한다.
      if (title != null) info.title = title;
      info.lastSeen = Date.now();
      info.frameIdx = Number.isFinite(frameIdx) ? frameIdx : null;
      info.polygons = Array.isArray(objects) ? objects.length : 0;
      info.kind = kind || 'detection';
      info.count += 1;
      return;
    }
    cams.set(camKey, {
      cam: camKey,
      title: title ?? null,
      lastSeen: Date.now(),
      frameIdx: Number.isFinite(frameIdx) ? frameIdx : null,
      polygons: Array.isArray(objects) ? objects.length : 0,
      kind: kind || 'detection',
      count: 1
    });

    // 오작동하는 송신기가 cam 번호를 무한정 늘려도 메모리가 새지 않도록 제한.
    if (cams.size > MAX_CAMS_PER_SOURCE) {
      let oldest = null;
      for (const info of cams.values()) if (!oldest || info.lastSeen < oldest.lastSeen) oldest = info;
      if (oldest) cams.delete(oldest.cam);
    }
  }

  /**
   * 소스별 최근 cam 목록. 호출 시점에 TTL이 지난 항목을 정리한다
   * (주기 타이머를 따로 돌리지 않아도 되도록 읽을 때 청소하는 방식).
   * @returns {Record<string, Array<{cam:string,title:string|null,ageMs:number,frameIdx:number|null,polygons:number,count:number}>>}
   */
  snapshot() {
    const now = Date.now();
    const out = {};
    for (const [connId, cams] of this.bySource) {
      for (const [camKey, info] of cams) {
        if (now - info.lastSeen > this.ttlMs) cams.delete(camKey);
      }
      if (cams.size === 0) {
        this.bySource.delete(connId);
        continue;
      }
      out[connId] = [...cams.values()]
        .sort(byCamNumber)
        .map(({ cam, title, lastSeen, frameIdx, polygons, kind, count }) => ({
          cam, title, frameIdx, polygons, kind, count, ageMs: now - lastSeen
        }));
    }
    return out;
  }

  /** 소스가 삭제되었을 때 그 소스의 관측 기록도 함께 버린다. */
  forget(connId) {
    this.bySource.delete(connId);
  }

  reset() {
    this.bySource.clear();
  }
}

/** cam 번호는 보통 정수 문자열이라 숫자로 비교해야 1,2,10 순서가 된다(문자열 정렬은 1,10,2). */
function byCamNumber(a, b) {
  const na = Number(a.cam);
  const nb = Number(b.cam);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a.cam).localeCompare(String(b.cam));
}

export const camObserver = new CamObserver();
