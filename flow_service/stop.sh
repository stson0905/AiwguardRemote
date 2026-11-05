#!/usr/bin/env bash
# start.sh 로 띄운 유속 서비스를 멈춘다. SIGTERM(정상 종료: FFmpeg 자식까지 정리) -> 10초 뒤에도 살아 있으면 SIGKILL.
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -f flow_service.pid ]; then
  echo "PID 파일이 없습니다 — 실행 중이 아닙니다."
  exit 0
fi
pid="$(cat flow_service.pid)"
if ! kill -0 "$pid" 2>/dev/null; then
  echo "PID $pid 는 이미 종료되었습니다."
  rm -f flow_service.pid
  exit 0
fi

kill -TERM "$pid"
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  echo "정상 종료되지 않아 강제 종료합니다."
  kill -KILL "$pid"
fi
rm -f flow_service.pid
echo "종료했습니다."
