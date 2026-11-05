#!/usr/bin/env bash
# 유속 서비스를 현재 터미널에서 실행한다(Ctrl+C 로 종료). 처음이면 .venv 를 만들고 의존성을 설치한다.
# 백그라운드로 띄우려면 start.sh / stop.sh 를 쓴다.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "[setup] .venv 생성 및 의존성 설치 (최초 1회)"
  python3 -m venv .venv
  .venv/bin/pip install --disable-pip-version-check -q -r requirements.txt
fi
if [ ! -f flow.cfg ]; then
  cp flow.cfg.example flow.cfg
  echo "[setup] flow.cfg 가 없어 flow.cfg.example 을 복사했습니다. 채널(RTSP_URLn)을 확인하세요."
fi

exec .venv/bin/python -u flow_service.py flow.cfg
