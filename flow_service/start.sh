#!/usr/bin/env bash
# 유속 서비스를 백그라운드로 띄운다(터미널/SSH 를 닫아도 계속 실행). 로그는 flow_service.log.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f flow_service.pid ] && kill -0 "$(cat flow_service.pid)" 2>/dev/null; then
  echo "이미 실행 중입니다 (PID $(cat flow_service.pid)). 다시 띄우려면 ./stop.sh 먼저."
  exit 0
fi

if [ ! -x .venv/bin/python ]; then
  echo "[setup] .venv 생성 및 의존성 설치 (최초 1회)"
  python3 -m venv .venv
  .venv/bin/pip install --disable-pip-version-check -q -r requirements.txt
fi
if [ ! -f flow.cfg ]; then
  cp flow.cfg.example flow.cfg
  echo "[setup] flow.cfg 가 없어 flow.cfg.example 을 복사했습니다. 채널(RTSP_URLn)을 확인하세요."
fi

# setsid: 새 세션으로 떼어 내서 SSH 가 끊겨도 SIGHUP 을 받지 않게 한다.
# 표준 출력은 버린다 — 같은 내용이 flow_service.log(5MB x 3 순환)에 남는다.
setsid nohup .venv/bin/python -u flow_service.py flow.cfg >/dev/null 2>&1 < /dev/null &
echo $! > flow_service.pid
sleep 2
if kill -0 "$(cat flow_service.pid)" 2>/dev/null; then
  echo "실행했습니다 (PID $(cat flow_service.pid)). 로그: $(pwd)/flow_service.log"
else
  echo "시작 직후 종료되었습니다. flow_service.log 를 확인하세요."
  rm -f flow_service.pid
  exit 1
fi
