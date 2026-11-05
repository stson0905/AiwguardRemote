// 서버 콘솔 시작 로그에 표시할 이 PC의 LAN IP를 추정한다 (localhost 대신 다른 PC에서도 접속 가능한 주소를 안내).
import os from 'node:os';

const DEPRIORITIZE_RE = /virtual|vethernet|hyper-v|wsl|docker|vmware|virtualbox|loopback|tailscale|zerotier/i;

/** @returns {string|null} 감지된 LAN IPv4 주소, 없으면 null */
export function getLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) candidates.push({ name, address: addr.address });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (DEPRIORITIZE_RE.test(a.name) ? 1 : 0) - (DEPRIORITIZE_RE.test(b.name) ? 1 : 0));
  return candidates[0].address;
}
