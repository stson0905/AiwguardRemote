// 프론트엔드 내부 모듈 간 pub/sub. 서버 WebSocket 메시지는 ws.js가 'ws:<type>'으로 재발행한다.
export const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, handler) {
  const listener = (e) => handler(e.detail);
  bus.addEventListener(name, listener);
  return () => bus.removeEventListener(name, listener);
}
