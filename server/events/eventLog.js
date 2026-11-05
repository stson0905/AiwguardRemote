// 알람 이벤트 최근 목록(메모리 링버퍼) + 영속 로그(JSONL append)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_ROOT } from '../util/appRoot.js';

const LOG_PATH = path.join(DATA_ROOT, 'events.log');
const MAX_MEMORY = 500;
/**
 * events.log가 이 크기를 넘으면 events.log.1로 밀어내고 새로 쓴다(직전 세대 하나만 보관).
 * 몇 달~몇 년 켜 두는 관제 서버에서 로그 파일이 무한정 커져 디스크를 채우는 일을 막는다.
 * 레코드 하나가 300B 남짓이라 20MB면 6만 건이 넘게 남는다.
 */
const MAX_LOG_BYTES = 20 * 1024 * 1024;
/** 크기 확인은 이만큼 기록할 때마다 한 번만 한다(매번 stat하지 않도록) */
const ROTATE_CHECK_EVERY = 200;

class EventLog {
  constructor() {
    this.items = [];
    this._sinceRotateCheck = 0;
    this._rotateIfNeeded();
  }

  add(evt) {
    const record = {
      id: 'evt_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      ackedAt: null,
      ...evt
    };
    this.items.unshift(record);
    if (this.items.length > MAX_MEMORY) this.items.length = MAX_MEMORY;
    fs.appendFile(LOG_PATH, JSON.stringify(record) + '\n', () => {});
    if (++this._sinceRotateCheck >= ROTATE_CHECK_EVERY) {
      this._sinceRotateCheck = 0;
      this._rotateIfNeeded();
    }
    return record;
  }

  _rotateIfNeeded() {
    fs.stat(LOG_PATH, (err, st) => {
      if (err || st.size < MAX_LOG_BYTES) return;
      // rename은 원자적이고, 실패(다른 프로세스가 잡고 있음 등)해도 다음 확인 때 다시 시도하면 된다.
      fs.rename(LOG_PATH, LOG_PATH + '.1', () => {});
    });
  }

  ack(id) {
    const found = this.items.find((e) => e.id === id);
    if (found) found.ackedAt = Date.now();
    return found || null;
  }

  list({ limit = 100 } = {}) {
    return this.items.slice(0, limit);
  }

  toCsv() {
    // mode=percent면 ratePct/threshold(%)가, height면 levelM/thresholdM(m)이, velocity면 speedMps/thresholdMps(m/s)가
    // 판정에 쓰인 값이다. 새 열은 맨 뒤에 붙여 예전 CSV를 읽던 도구의 열 위치가 바뀌지 않게 한다.
    const header = 'id,channelId,channelTitle,roiName,label,mode,ratePct,threshold,levelM,thresholdM,ts,ackedAt,speedMps,thresholdMps\n';
    const rows = this.items.map((e) =>
      [e.id, e.channelId, e.channelTitle, e.roiName, e.label, e.mode ?? 'percent',
        e.ratePct, e.threshold ?? '', e.levelM ?? '', e.thresholdM ?? '', e.ts, e.ackedAt ?? '',
        e.speedMps ?? '', e.thresholdMps ?? '']
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
    return header + rows.join('\n');
  }
}

export const eventLog = new EventLog();
