// 서버 WebSocket 연결 + 자동 재접속. 수신 메시지를 'ws:<type>' 버스 이벤트로 재발행한다.
import { emit } from './bus.js';

let socket = null;
/** 마지막으로 정한 구독 채널 목록 — 재접속하면 서버는 새 소켓이라 모르므로 열릴 때마다 다시 보낸다 */
let subscribedIds = null;

export function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.addEventListener('open', () => {
    sendSubscribe();
    emit('ws:open');
  });
  socket.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg && msg.type) emit('ws:' + msg.type, msg);
  });
  socket.addEventListener('close', () => {
    emit('ws:close');
    setTimeout(connectWs, 2000);
  });
  socket.addEventListener('error', () => socket && socket.close());
}

/**
 * 지금 화면에 보이는 채널만 프레임/유속 메시지를 받는다(서버 wsHub.js가 걸러 보냄).
 * 알람·설정 변경 등은 구독과 상관없이 항상 온다 — 감지와 알람은 서버가 모든 채널에 대해 처리한다.
 */
export function setSubscription(channelIds) {
  const next = [...new Set(channelIds)].sort();
  if (subscribedIds && next.length === subscribedIds.length && next.every((id, i) => id === subscribedIds[i])) return;
  subscribedIds = next;
  sendSubscribe();
}

function sendSubscribe() {
  if (!subscribedIds || socket?.readyState !== WebSocket.OPEN) return;
  try { socket.send(JSON.stringify({ type: 'subscribe', channelIds: subscribedIds })); } catch { /* 다음 open 때 다시 보낸다 */ }
}
