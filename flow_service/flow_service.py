#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI W-Guard 유속(표면 광류) 서비스

RTSP 영상을 직접 받아 연속 프레임 사이의 광류(Farneback)로 수면이 흘러가는 속도/방향을 격자 칸마다
구하고, 그 결과를 JSON Lines 로 TCP 클라이언트(VMS)에 보낸다. 침수 감지 엔진(ai_w_guard)과는 완전히
별개로 돌아간다 — 이 프로그램이 멈추거나 죽어도 침수 감지에는 아무 영향이 없다.

왜 이렇게 계산하는가 (2026-09-21 실측 근거, VMS 저장소 flow_service/README.md 참고):
  - AI 세그멘테이션 폴리곤은 "물 영역의 테두리"뿐이라 유속 정보가 없다. 유속은 영상 픽셀의 움직임으로만 알 수 있다.
  - 5fps 간격으로는 수면 무늬가 그 사이에 모양이 바뀌어 속도가 34~74% 낮게 나왔다. 15fps 이상의 연속 프레임을 쓴다.
  - 광류 결과를 그대로 믿으면 안 되는 칸(제자리에서 출렁이는 정상파, 맑은 물 아래 바닥 무늬)이 있어서
    칸마다 두 가지 신뢰도를 같이 보낸다.
      fb : forward-backward 일관성. 앞으로 구한 이동을 거꾸로 되돌렸을 때 1px 안에 돌아오는 픽셀 비율(0~1).
      r  : 간격 일관성. 프레임 간격을 2배로 늘렸을 때 구한 속도 / 1배 간격 속도. 실제로 떠내려가는 무늬면
           간격과 무관하게 속도가 같아 1 근처, 제자리 무늬·잡음이면 이동량이 간격과 무관해서 0.5 근처가 된다.

출력 단위: 정규화 좌표/초 — vx = 초당 이동량 / 프레임 가로, vy = 초당 이동량 / 프레임 세로.
  수신 측이 해상도와 무관하게 쓸 수 있고, px/s 가 필요하면 width/height 를 곱하면 된다.
  실제 m/s 로 바꾸려면 현장 기준 거리(보정)가 필요하며 그건 수신 측(VMS)의 몫이다.
"""
import json
import logging
import logging.handlers
import math
import os
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import warnings
from collections import deque
from datetime import datetime

import cv2
import numpy as np

VERSION = '1.0.0'
HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULTS = {
    'SERVER_BIND': '0.0.0.0',
    'SERVER_PORT': '7200',
    'SERVER_MAX_CLIENTS': '8',
    'PUBLISH_INTERVAL_MS': '1000',
    'DECODE_FPS': '15',
    'HWACCEL': 'cuda',
    'FFMPEG_PATH': 'ffmpeg',
    'FFPROBE_PATH': 'ffprobe',
    'PROC_WIDTH': '640',
    'GRID_COLS': '16',
    'GRID_ROWS': '9',
    # Farneback 1회가 640x360에서 약 70ms(스레드를 늘려도 거의 안 빨라짐, 2026-09-21 측정)이고 표본 1개에 3회를
    # 돌리므로 채널당 초당 4개 정도가 한계다. 3이면 여유가 있고 WINDOW_SEC=3 창에 표본 9개가 모인다.
    'SAMPLES_PER_SEC': '3',
    'WINDOW_SEC': '3',
    'STATUS_LOG_INTERVAL_SEC': '30',
    'LOG_FILE': 'flow_service.log',
}

# Farneback 파라미터 — 2026-09-21 실측(640px 폭 처리)에서 검증한 값 그대로.
FARNEBACK = dict(pyr_scale=0.5, levels=4, winsize=21, iterations=5, poly_n=7, poly_sigma=1.5, flags=0)
FB_OK_PX = 1.0        # forward-backward 오차가 이보다 작으면 "일관됨"
DUP_MAD = 0.2         # 연속 프레임 평균 밝기차가 이보다 작으면 같은 프레임(소스 멈춤 / fps 필터의 복제 프레임)
JUMP_MAD = 35.0       # 이보다 크면 장면이 통째로 바뀐 것(영상 루프 재시작, 카메라 회전 등) — 그 쌍은 버린다
MIN_MOVE_PX = 0.05    # 간격 일관성(r)을 계산할 최소 이동량(처리 해상도 px/프레임). 이보다 작으면 비율이 무의미
STALL_SEC = 10.0      # 이 시간 동안 프레임이 안 오면 멈춘 것으로 보고 FFmpeg 을 다시 띄운다
PROBE_TIMEOUT_SEC = 15

log = logging.getLogger('flow')


# ---------------------------------------------------------------------------
# 설정 파일 — ai_w_guard 의 config.cfg 와 같은 형식 (KEY = VALUE, # 주석, 값 뒤 " // ..." / " # ..." 메모)
# ---------------------------------------------------------------------------
def load_config(path):
    cfg = dict(DEFAULTS)
    with open(path, encoding='utf-8-sig') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            # 공백이 앞선 " //", " #" 만 주석으로 본다 — rtsp://... 의 // 는 건드리지 않는다.
            value = re.split(r'\s(?://|#)', value, maxsplit=1)[0]
            cfg[key.strip()] = value.strip()
    return cfg


def cfg_int(cfg, key, lo, hi):
    try:
        v = int(float(cfg.get(key, DEFAULTS.get(key, '0'))))
    except ValueError:
        v = int(DEFAULTS[key])
        log.warning('%s 값이 숫자가 아니라 기본값 %s 을(를) 씁니다.', key, v)
    return max(lo, min(hi, v))


def channels_of(cfg):
    """RTSP_URLn / RTSP_TITLEn — n 이 그대로 보내는 카메라 번호가 된다(ai_w_guard 와 같은 번호 체계)."""
    out = []
    for key, url in cfg.items():
        m = re.fullmatch(r'RTSP_URL(\d+)', key)
        if m and url:
            n = int(m.group(1))
            out.append((n, url, cfg.get('RTSP_TITLE%d' % n, 'T%d' % n)))
    return sorted(out)


# ---------------------------------------------------------------------------
# 채널: 디코딩(FFmpeg 파이프) + 광류 계산 + 시간창 집계
# ---------------------------------------------------------------------------
class Channel:
    def __init__(self, num, url, title, cfg, stop_event):
        self.num = num
        self.url = url
        self.title = title
        self.stop_event = stop_event
        self.fps = cfg_int(cfg, 'DECODE_FPS', 5, 60)
        self.proc_width = cfg_int(cfg, 'PROC_WIDTH', 160, 1920)
        self.cols = cfg_int(cfg, 'GRID_COLS', 1, 64)
        self.rows = cfg_int(cfg, 'GRID_ROWS', 1, 64)
        self.sample_every = max(1, round(self.fps / cfg_int(cfg, 'SAMPLES_PER_SEC', 1, 60)))
        self.window_sec = cfg_int(cfg, 'WINDOW_SEC', 1, 60)
        self.ffmpeg = cfg.get('FFMPEG_PATH') or 'ffmpeg'
        self.ffprobe = cfg.get('FFPROBE_PATH') or 'ffprobe'
        self.use_hw = cfg.get('HWACCEL', 'cuda').strip().lower() == 'cuda'

        self.lock = threading.Lock()
        # 연결 상태: connecting(아직 한 프레임도 못 받음) | streaming(수신 중) | reconnecting(끊겨서 다시 연결 중)
        # 전송 메시지의 state 는 여기에 "최근 표본이 있는가"를 더해 ok / waiting 으로 바꿔 내보낸다.
        self.state = 'connecting'
        self.width = 0                   # 원본 해상도
        self.height = 0
        self.frames = 0                  # 디코딩한 프레임 수(누적)
        self.samples = deque()           # (도착 시각, v1x, v1y, fb, r) — 각 배열은 (rows, cols)
        self.proc = None
        self.last_frame_at = 0.0
        # 통계(상태 로그용)
        self.stat_samples = 0
        self.stat_dropped = 0
        self.stat_skipped = 0
        self.stat_compute_ms = 0.0

        self.jobs = queue.Queue(maxsize=1)  # 계산이 밀리면 새 표본을 버린다(디코딩을 절대 막지 않음)
        self.reader = threading.Thread(target=self._read_loop, name='read-%d' % num, daemon=True)
        self.worker = threading.Thread(target=self._compute_loop, name='flow-%d' % num, daemon=True)

    def start(self):
        self.reader.start()
        self.worker.start()

    # ---- 디코딩 ----
    def _probe_size(self):
        cmd = [self.ffprobe, '-v', 'error']
        if self.url.lower().startswith('rtsp://'):
            cmd += ['-rtsp_transport', 'tcp']
        cmd += ['-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', self.url]
        out = subprocess.run(cmd, capture_output=True, timeout=PROBE_TIMEOUT_SEC, check=True).stdout
        st = json.loads(out.decode('utf-8', 'replace'))['streams'][0]
        return int(st['width']), int(st['height'])

    def _ffmpeg_cmd(self, pw, ph, hw):
        cmd = [self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin']
        if self.url.lower().startswith('rtsp://'):
            cmd += ['-rtsp_transport', 'tcp']
        else:
            cmd += ['-re', '-stream_loop', '-1']  # 파일 시험용: 실시간 속도로 반복 재생
        if hw:
            cmd += ['-hwaccel', 'cuda']
        cmd += ['-i', self.url, '-an', '-sn',
                '-vf', 'fps=%d,scale=%d:%d:flags=area,format=gray' % (self.fps, pw, ph),
                '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']
        return cmd

    def _read_loop(self):
        backoff = 2
        hw = self.use_hw
        while not self.stop_event.is_set():
            got_any = False
            probed = False
            try:
                w, h = self._probe_size()
                probed = True
                pw = min(self.proc_width, w)
                ph = max(2, int(round(h * pw / w / 2.0)) * 2)
                with self.lock:
                    self.width, self.height = w, h
                log.info('[CH %d] 연결: %dx%d -> 처리 %dx%d, %dfps, hwaccel=%s', self.num, w, h, pw, ph, self.fps,
                         'cuda' if hw else 'none')
                # 버퍼 모드여야 한다: 버퍼 없는(raw) 파이프의 read(n)은 n바이트보다 적게 돌아올 수 있어
                # 프레임 경계가 어긋난다. BufferedReader.read(n)은 n바이트가 차거나 EOF일 때만 돌아온다.
                self.proc = subprocess.Popen(self._ffmpeg_cmd(pw, ph, hw), stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, bufsize=1 << 20)
                threading.Thread(target=self._drain_stderr, args=(self.proc,), daemon=True).start()
                self.last_frame_at = time.monotonic()
                got_any = self._consume(self.proc, pw, ph)
            except Exception as e:  # 프로브 실패, 실행 파일 없음 등
                log.warning('[CH %d] 연결 실패: %s', self.num, e)
            finally:
                self._kill()
            if self.stop_event.is_set():
                break
            if hw and probed and not got_any:
                # 스트림은 열리는데(프로브 성공) GPU 디코딩으로 한 프레임도 못 받았다 — 다음부터 소프트웨어 디코딩.
                # (프로브 자체가 실패한 경우는 네트워크/카메라 문제라 GPU 탓이 아니므로 그대로 둔다)
                hw = False
                log.warning('[CH %d] GPU 디코딩 실패 -> 소프트웨어 디코딩으로 다시 시도', self.num)
            elif got_any:
                backoff = 2
            with self.lock:
                self.state = 'reconnecting' if self.frames > 0 else 'connecting'
            self.stop_event.wait(backoff)
            backoff = min(backoff * 2, 10)

    def _drain_stderr(self, proc):
        for raw in iter(proc.stderr.readline, b''):
            msg = raw.decode('utf-8', 'replace').strip()
            if msg:
                log.warning('[CH %d] ffmpeg: %s', self.num, msg[:300])

    def _consume(self, proc, pw, ph):
        """프레임을 끝까지 읽는다. 한 프레임이라도 받았으면 True."""
        n = pw * ph
        ring = deque(maxlen=3)   # 연속한 최근 3 프레임 (표본 = f0, f1=f0+1, f2=f0+2)
        since_sample = 0
        got_any = False
        while not self.stop_event.is_set():
            buf = proc.stdout.read(n)  # 파이프가 닫히면(EOF/kill) 짧게 돌아온다
            if not buf or len(buf) < n:
                return got_any
            got_any = True
            self.last_frame_at = time.monotonic()
            ring.append(np.frombuffer(buf, np.uint8).reshape(ph, pw))
            with self.lock:
                self.frames += 1
                self.state = 'streaming'
            since_sample += 1
            if len(ring) == 3 and since_sample >= self.sample_every:
                since_sample = 0
                try:
                    self.jobs.put_nowait((ring[0], ring[1], ring[2], time.monotonic()))
                except queue.Full:
                    self.stat_dropped += 1
        return got_any

    def check_stall(self):
        """감시 스레드가 주기적으로 부른다 — 프레임이 멈추면 FFmpeg 을 죽여 _read_loop 가 다시 연결하게 한다."""
        p = self.proc
        if p and p.poll() is None and time.monotonic() - self.last_frame_at > STALL_SEC:
            log.warning('[CH %d] %d초간 프레임 없음 -> 다시 연결', self.num, STALL_SEC)
            self._kill()

    def _kill(self):
        p = self.proc
        if p and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=3)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    # ---- 광류 계산 ----
    def _compute_loop(self):
        while not self.stop_event.is_set():
            try:
                f0, f1, f2, at = self.jobs.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                t0 = time.perf_counter()
                sample = self._compute(f0, f1, f2)
                ms = (time.perf_counter() - t0) * 1000
            except Exception:
                log.exception('[CH %d] 광류 계산 오류 (이 표본은 건너뜀)', self.num)
                continue
            if sample is None:
                self.stat_skipped += 1
                continue
            with self.lock:
                self.samples.append((at,) + sample)
                # 창보다 조금 더 오래된 것까지만 들고 있는다
                while self.samples and at - self.samples[0][0] > self.window_sec + 2:
                    self.samples.popleft()
            self.stat_samples += 1
            self.stat_compute_ms += ms

    def _compute(self, f0, f1, f2):
        mad01 = float(cv2.absdiff(f0, f1).mean())
        mad12 = float(cv2.absdiff(f1, f2).mean())
        if min(mad01, mad12) < DUP_MAD or max(mad01, mad12) > JUMP_MAD:
            return None  # 복제 프레임 또는 장면 전환 — 이 쌍의 움직임은 수면 흐름이 아니다

        fwd = cv2.calcOpticalFlowFarneback(f0, f1, None, **FARNEBACK)
        bwd = cv2.calcOpticalFlowFarneback(f1, f0, None, **FARNEBACK)
        fwd2 = cv2.calcOpticalFlowFarneback(f0, f2, None, **FARNEBACK)

        ph, pw = f0.shape
        gx, gy = np.meshgrid(np.arange(pw, dtype=np.float32), np.arange(ph, dtype=np.float32))
        back_at = cv2.remap(bwd, gx + fwd[..., 0], gy + fwd[..., 1], cv2.INTER_LINEAR)
        fb_ok = (np.hypot(fwd[..., 0] + back_at[..., 0], fwd[..., 1] + back_at[..., 1]) < FB_OK_PX)

        rows, cols = self.rows, self.cols
        ys = [int(round(i * ph / rows)) for i in range(rows + 1)]
        xs = [int(round(j * pw / cols)) for j in range(cols + 1)]
        v1x = np.full((rows, cols), np.nan, np.float32)
        v1y = np.full((rows, cols), np.nan, np.float32)
        fb = np.full((rows, cols), np.nan, np.float32)
        rr = np.full((rows, cols), np.nan, np.float32)
        dt = 1.0 / self.fps
        for i in range(rows):
            for j in range(cols):
                sl = (slice(ys[i], ys[i + 1]), slice(xs[j], xs[j + 1]))
                c1 = fwd[sl]
                if c1.size == 0:
                    continue
                dx1, dy1 = float(np.median(c1[..., 0])), float(np.median(c1[..., 1]))
                c2 = fwd2[sl]
                dx2, dy2 = float(np.median(c2[..., 0])), float(np.median(c2[..., 1]))
                v1x[i, j] = dx1 / pw / dt
                v1y[i, j] = dy1 / ph / dt
                fb[i, j] = float(fb_ok[sl].mean())
                m1 = math.hypot(dx1, dy1)
                if m1 >= MIN_MOVE_PX:
                    rr[i, j] = (math.hypot(dx2, dy2) / 2.0) / m1
        return v1x, v1y, fb, rr

    # ---- 전송 메시지 ----
    def snapshot_line(self, ts_ms):
        now = time.monotonic()
        with self.lock:
            recent = [s for s in self.samples if now - s[0] <= self.window_sec]
            state = self.state
            frames, width, height = self.frames, self.width, self.height
        if recent:
            state = 'ok'
        elif state == 'streaming':
            state = 'waiting'  # 프레임은 오는데 아직 계산된 표본이 없음(막 연결됨 / 복제 프레임만 옴)
        cells = []
        if recent:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', RuntimeWarning)  # 모든 표본이 NaN 인 칸(움직임 없음)의 경고
                med = [np.nanmedian(np.stack([s[k] for s in recent]), axis=0) for k in range(1, 5)]
            for i in range(self.rows):
                for j in range(self.cols):
                    cells.append([
                        _num(med[0][i, j], 5), _num(med[1][i, j], 5), _num(med[2][i, j], 2), _num(med[3][i, j], 2)
                    ])
        msg = {
            'type': 'flow',
            # 'channel'/'cam' 이 아니라 'camera' 를 쓰는 이유: 유속을 모르는 예전 VMS 는 channel/cam 이 있는 줄을
            # 전부 물 탐지 좌표로 읽는다. 그러면 폴리곤이 0개인 탐지로 오인돼 침범률 0%(알람 해제)가 될 수 있다.
            # camera 필드는 예전 VMS 가 모르는 줄이라 그냥 무시된다.
            'camera': self.num,
            'title': self.title,
            'ts': datetime.fromtimestamp(ts_ms / 1000).isoformat(timespec='milliseconds'),
            'ts_ms': ts_ms,
            'frame': frames,
            'width': width,
            'height': height,
            'state': state,
            'fps': self.fps,
            'window_ms': self.window_sec * 1000,
            'pairs': len(recent),
            'grid': [self.cols, self.rows],
            'cells': cells,
        }
        return json.dumps(msg, ensure_ascii=False, separators=(',', ':'))

    def stats_line(self, interval):
        with self.lock:
            frames, state = self.frames, self.state
        fps = (frames - getattr(self, '_stat_frames', 0)) / interval
        self._stat_frames = frames
        avg_ms = self.stat_compute_ms / self.stat_samples if self.stat_samples else 0.0
        line = 'CH %d(%s): %s %.1ffps, 표본 %d(건너뜀 %d, 밀려서 버림 %d), 계산 평균 %.0fms' % (
            self.num, self.title, state, fps, self.stat_samples, self.stat_skipped, self.stat_dropped, avg_ms)
        self.stat_samples = self.stat_skipped = self.stat_dropped = 0
        self.stat_compute_ms = 0.0
        return line


def _num(v, digits):
    v = float(v)
    return round(v, digits) if math.isfinite(v) else None


# ---------------------------------------------------------------------------
# TCP 서버 (JSON Lines). 접속 직후 hello 한 줄, 이후 채널마다 주기적으로 flow 한 줄씩.
# ---------------------------------------------------------------------------
class LineServer:
    def __init__(self, bind, port, max_clients):
        self.bind, self.port, self.max_clients = bind, port, max_clients
        self.clients = []
        self.lock = threading.Lock()
        self.greeting = b''
        self.sock = None

    def start(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((self.bind, self.port))
        s.listen(16)
        self.sock = s
        threading.Thread(target=self._accept_loop, name='accept', daemon=True).start()

    def _accept_loop(self):
        while True:
            try:
                conn, addr = self.sock.accept()
            except OSError:
                return  # 서버 소켓이 닫힘(종료)
            with self.lock:
                if len(self.clients) >= self.max_clients:
                    log.warning('접속 거부(최대 %d): %s:%d', self.max_clients, *addr)
                    conn.close()
                    continue
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            conn.settimeout(2.0)  # 받는 쪽이 멈춰 있으면 2초 뒤 끊는다(다른 클라이언트까지 막지 않도록)
            try:
                conn.sendall(self.greeting)
            except OSError:
                conn.close()
                continue
            with self.lock:
                self.clients.append((conn, addr))
            log.info('클라이언트 접속: %s:%d (현재 %d)', addr[0], addr[1], len(self.clients))

    def broadcast(self, lines):
        data = ''.join(line + '\n' for line in lines).encode('utf-8')
        with self.lock:
            clients = list(self.clients)
        for conn, addr in clients:
            try:
                conn.sendall(data)
            except OSError:
                self._drop(conn, addr)

    def _drop(self, conn, addr):
        with self.lock:
            self.clients = [c for c in self.clients if c[0] is not conn]
            n = len(self.clients)
        try:
            conn.close()
        except OSError:
            pass
        log.info('클라이언트 종료: %s:%d (현재 %d)', addr[0], addr[1], n)

    def count(self):
        with self.lock:
            return len(self.clients)

    def stop(self):
        try:
            self.sock.close()
        except Exception:
            pass
        with self.lock:
            for conn, _ in self.clients:
                try:
                    conn.close()
                except OSError:
                    pass
            self.clients = []


# ---------------------------------------------------------------------------
def setup_logging(cfg):
    log.setLevel(logging.INFO)
    fmt = logging.Formatter('%(asctime)s [%(levelname)s] %(message)s')
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(sh)
    path = cfg.get('LOG_FILE', '').strip()
    if path:
        if not os.path.isabs(path):
            path = os.path.join(HERE, path)
        fh = logging.handlers.RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8')
        fh.setFormatter(fmt)
        log.addHandler(fh)


def main():
    cfg_path = os.environ.get('AIWG_FLOW_CONFIG') or (sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'flow.cfg'))
    cfg = load_config(cfg_path)
    setup_logging(cfg)
    cv2.setNumThreads(4)
    log.info('AI W-Guard 유속 서비스 %s 시작 (설정: %s, OpenCV %s)', VERSION, cfg_path, cv2.__version__)

    chans_cfg = channels_of(cfg)
    if not chans_cfg:
        log.error('RTSP_URLn 이 하나도 없습니다 — 유속을 잴 채널을 설정하세요.')
        return 2

    stop = threading.Event()
    channels = [Channel(n, url, title, cfg, stop) for n, url, title in chans_cfg]

    server = LineServer(cfg['SERVER_BIND'], cfg_int(cfg, 'SERVER_PORT', 1, 65535), cfg_int(cfg, 'SERVER_MAX_CLIENTS', 1, 64))
    c0 = channels[0]
    server.greeting = (json.dumps({
        'type': 'hello', 'service': 'AI W-Guard Flow', 'version': VERSION,
        'publish_interval_ms': cfg_int(cfg, 'PUBLISH_INTERVAL_MS', 100, 60000),
        'grid': [c0.cols, c0.rows], 'fps': c0.fps, 'window_ms': c0.window_sec * 1000,
        'unit': 'normalized/s', 'cell_fields': ['vx', 'vy', 'fb', 'r'],
        'cameras': [{'camera': c.num, 'title': c.title} for c in channels],
    }, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    server.start()
    log.info('수신 대기: %s:%d  채널: %s', server.bind, server.port,
             ', '.join('%d(%s)' % (c.num, c.title) for c in channels))

    def on_signal(signum, frame):
        log.info('종료 신호(%s) 수신', signum)
        stop.set()

    signal.signal(signal.SIGINT, on_signal)
    if hasattr(signal, 'SIGTERM'):
        signal.signal(signal.SIGTERM, on_signal)

    for c in channels:
        c.start()

    period = cfg_int(cfg, 'PUBLISH_INTERVAL_MS', 100, 60000) / 1000.0
    stat_every = cfg_int(cfg, 'STATUS_LOG_INTERVAL_SEC', 0, 3600)
    next_pub = time.monotonic()
    last_stat = time.monotonic()
    try:
        while not stop.is_set():
            now = time.monotonic()
            if now >= next_pub:
                next_pub = now + period
                ts_ms = int(time.time() * 1000)
                if server.count() > 0:
                    server.broadcast([c.snapshot_line(ts_ms) for c in channels])
                for c in channels:
                    c.check_stall()
            if stat_every and now - last_stat >= stat_every:
                interval = now - last_stat
                last_stat = now
                log.info('상태: 클라이언트 %d | %s', server.count(), ' | '.join(c.stats_line(interval) for c in channels))
            stop.wait(0.05)
    except KeyboardInterrupt:
        stop.set()
    finally:
        for c in channels:
            c._kill()
        server.stop()
        log.info('종료했습니다.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
