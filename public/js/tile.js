// 그리드 한 셀(채널 타일) — 영상 재생, ROI/탐지박스 오버레이, 제목 편집, 액션 버튼을 담당.
import { state, getRoisForChannel } from './state.js';
import { emit } from './bus.js';
import { api } from './api.js';
import { attachWhep } from './whepPlayer.js';
import * as roiEditor from './roiEditor.js';
import * as flowCalib from './flowCalibEditor.js';
import { getVideoContentRect, makeToPixel } from './videoRect.js';
import { isHeightRoi, roiBounds, metersToY, yToMeters, formatMeters, formatMps, levelTextOf } from './waterScale.js';

/**
 * 영상 자동 재연결.
 * 관제 화면은 며칠씩 켜 두므로 MediaMTX 재시작, 카메라 전원 차단, 네트워크 흔들림 뒤에 영상이 멈춘 채
 * "마지막 장면"만 남아 있으면 실시간으로 오해하기 쉽다(침수 감시에서는 가장 위험한 상태). 그래서
 *  - 연결 실패/끊김이면 영상을 내리고 사유를 표시한 뒤 3초→6초→…→30초 간격으로 다시 붙인다.
 *  - 연결은 살아 있는데 새 프레임이 30초간 안 들어오면(카메라/RTSP 쪽 문제) 정지로 보고 다시 붙인다.
 */
const VIDEO_RETRY_MIN_MS = 3000;
const VIDEO_RETRY_MAX_MS = 30000;
/** WebRTC 'disconnected'는 잠깐 흔들린 뒤 스스로 돌아오는 경우가 많아 이만큼은 기다려 본다 */
const VIDEO_DISCONNECT_GRACE_MS = 5000;
const VIDEO_STALL_CHECK_MS = 10000;
/** 이 횟수 연속으로 디코딩된 프레임 수가 안 늘면 정지로 판정 (10초 x 3 = 30초) */
const VIDEO_STALL_STRIKES = 3;
/** 유속 결과가 이보다 오래되면(유속 서비스 중단 등) 화살표를 지우고 ROI 유속을 "-"로 표시한다 */
const FLOW_STALE_MS = 5000;
/** 빈 칸(마지막 페이지의 남는 칸) 안내 — 채널은 자동 배치되므로 여기로 끌어다 놓으면 그 채널을 맨 뒤로 옮긴다 */
const EMPTY_TEXT = '빈 칸<br/>채널을 끌어다 놓으면 이 자리로 옮깁니다';

export class Tile {
  constructor(container, { cellIndex }) {
    this.cellIndex = cellIndex;
    this.channel = null;
    this.lastFrame = null;
    this.lastFlow = null; // 유속 서비스 결과 { grid, cells?, rois, receivedAt }
    this.whepHandle = null;
    this._alarmTimer = null;
    this._raf = 0;
    this._objectFit = 'fill';
    this._badgeText = '';
    // 영상 연결 상태. _videoGen은 setChannel/재연결마다 증가하는 세대 번호 — 기다리는 사이 채널이 바뀌었을 때
    // 뒤늦게 도착한 옛 연결 결과나 옛 PeerConnection의 상태 이벤트를 무시하기 위한 표시다.
    this._videoGen = 0;
    this._videoRetryTimer = null;
    this._videoRetryMs = VIDEO_RETRY_MIN_MS;
    this._videoGraceTimer = null;
    this._stallTimer = null;
    this._stallFrames = -1;
    this._stallStrikes = 0;

    this.el = document.createElement('div');
    this.el.className = 'tile';
    this.el.innerHTML = `
      <div class="tile-titlebar">
        <span class="tile-title" title="더블클릭하여 이름 수정"></span>
        <div class="tile-actions">
          <button class="act-roi" title="ROI 추가">＋ROI</button>
          <button class="act-roi-edit" title="ROI 수정">ROI수정</button>
          <button class="act-roi-clear" title="이 채널 ROI 전체삭제">ROI삭제</button>
          <button class="act-flow-calib" title="유속 보정 — 수면 기준점과 실제 좌표로 m/s 환산을 맞춘다">유속보정</button>
          <button class="act-expand" title="확대/축소">⛶</button>
          <!-- 사용자분할(.grid-custom)에서만 보인다 — 고른 목록에서 이 채널을 뺀다(채널 자체는 지워지지 않는다) -->
          <button class="act-remove" title="사용자분할에서 빼기">×</button>
          <!-- 확대 보기 중에만 보이는 닫기 버튼 -->
          <button class="act-zoom-close" title="확대 닫기 (Esc)">×</button>
        </div>
      </div>
      <div class="roi-chips"></div>
      <div class="tile-video-wrap">
        <video autoplay muted playsinline></video>
        <canvas class="overlay"></canvas>
        <div class="tile-empty-placeholder">${EMPTY_TEXT}</div>
        <div class="tile-badge" style="display:none"></div>
        <button class="tile-bigview" title="이 채널을 왼쪽 위 큰 화면으로">크게보기</button>
      </div>`;
    container.appendChild(this.el);

    this.titleEl = this.el.querySelector('.tile-title');
    this.chipsEl = this.el.querySelector('.roi-chips');
    this.roiEditBtn = this.el.querySelector('.act-roi-edit');
    this.videoWrap = this.el.querySelector('.tile-video-wrap');
    this.videoEl = this.el.querySelector('video');
    this.canvas = this.el.querySelector('canvas.overlay');
    this.placeholderEl = this.el.querySelector('.tile-empty-placeholder');
    this.badgeEl = this.el.querySelector('.tile-badge');
    this.ctx = this.canvas.getContext('2d');

    this._wireEvents();
    this._ro = new ResizeObserver(() => this._resizeCanvas());
    this._ro.observe(this.videoWrap);
    // 영상이 그려지는 영역(object-fit이 contain/cover면 영상 크기가 필요)을 계산하려면 영상 실제 크기를 알아야 하므로,
    // 메타데이터가 로드되는 시점에 즉시 다시 그린다(그 전까지는 캔버스 전체 기준으로 임시 표시됨).
    this.videoEl.addEventListener('loadedmetadata', () => this.render());
  }

  _wireEvents() {
    // ROI 편집과 유속 보정 편집은 같은 캔버스 마우스를 쓰므로 한 번에 하나만 연다.
    this.el.querySelector('.act-roi').onclick = () => {
      if (!this.channel) return alert('채널이 없는 빈 칸입니다.');
      this._zoomIfDense();
      flowCalib.cancel(this);
      roiEditor.beginDraw(this);
    };
    this.roiEditBtn.onclick = () => {
      if (!this.channel) return;
      this._zoomIfDense();
      flowCalib.cancel(this);
      roiEditor.beginEdit(this);
    };
    this.el.querySelector('.act-flow-calib').onclick = () => {
      if (!this.channel) return alert('채널이 없는 빈 칸입니다.');
      this._zoomIfDense();
      roiEditor.cancel(this);
      flowCalib.begin(this);
    };
    this.el.querySelector('.act-roi-clear').onclick = async () => {
      if (!this.channel) return;
      if (!confirm(`"${this.channel.title}" 채널의 ROI를 모두 삭제할까요?`)) return;
      await api.deleteRoisByChannel(this.channel.channelId);
    };
    this.el.querySelector('.act-expand').onclick = () => emit('tile:expand', { cellIndex: this.cellIndex });
    this.el.querySelector('.act-remove').onclick = () => emit('tile:remove', { cellIndex: this.cellIndex });
    this.el.querySelector('.act-zoom-close').onclick = () => emit('tile:zoomClose', {});
    // 8분할 작은 화면의 "크게보기" (CSS가 보일 때만 누를 수 있다). 영상 영역의 클릭/더블클릭으로 번지지 않게 막는다.
    const bigBtn = this.el.querySelector('.tile-bigview');
    bigBtn.onclick = (e) => {
      e.stopPropagation();
      if (this.channel) emit('tile:promote', { cellIndex: this.cellIndex });
    };
    bigBtn.ondblclick = (e) => e.stopPropagation();

    // 채널 자리 옮기기는 왼쪽 채널 목록에서 끌어다 놓는 방식이다(app.js). 타일 제목줄은 끌지 않는다 —
    // v0.4.1에서 제목줄 끌기를 넣었다가 사용자 요청으로 목록 끌기로 통일함(v0.4.2).

    this.titleEl.ondblclick = () => {
      if (!this.channel) return;
      this.titleEl.contentEditable = 'true';
      this.titleEl.focus();
      document.execCommand('selectAll', false, null);
    };
    this.titleEl.onblur = async () => {
      if (this.titleEl.contentEditable !== 'true') return;
      this.titleEl.contentEditable = 'false';
      const title = this.titleEl.textContent.trim();
      if (this.channel && title && title !== this.channel.title) {
        await api.updateChannel(this.channel.id, { title });
      }
    };
    this.titleEl.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.titleEl.blur(); }
    };

    // 놓는 곳은 타일 전체(제목줄 포함). 확대 보기 안의 타일은 칸 번호가 의미 없으므로 받지 않는다.
    const acceptsDrop = () => !this.el.closest('.zoom-box');
    this.el.ondragover = (e) => {
      if (!acceptsDrop()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!this.el.classList.contains('drag-source')) this.el.classList.add('drag-over');
    };
    this.el.ondragleave = (e) => {
      if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drag-over');
    };
    this.el.ondrop = (e) => {
      if (!acceptsDrop()) return;
      e.preventDefault();
      this.el.classList.remove('drag-over');
      const channelId = e.dataTransfer.getData('text/plain');
      if (channelId && channelId !== this.channel?.channelId) emit('tile:drop', { cellIndex: this.cellIndex, channelId });
    };
    this.videoWrap.onclick = (e) => {
      if (roiEditor.isEditing(this) || flowCalib.isActive(this)) return; // 편집 모드에서는 canvas 핸들러가 처리
      // 사이드바에서 채널을 골라 둔 상태면 이 칸 자리로 옮긴다(자리에 있던 채널과는 서로 바뀜)
      if (state.armedChannelId) {
        emit('tile:drop', { cellIndex: this.cellIndex, channelId: state.armedChannelId });
      }
    };
    // 분할 화면에서 채널을 더블클릭하면 화면 정중앙에 확대해 보여준다.
    // ROI 편집 중에는 캔버스 더블클릭이 "폴리곤 그리기 완료"라 확대로 가로채면 안 된다.
    this.videoWrap.ondblclick = () => {
      if (roiEditor.isEditing(this) || flowCalib.isActive(this) || !this.channel) return;
      emit('tile:zoom', { cellIndex: this.cellIndex });
    };

    // 유속 보정 편집 중이면 캔버스 마우스는 전부 그쪽이 받는다(점 추가/이동). 아니면 ROI 편집기.
    this.canvas.addEventListener('click', (e) => { if (!flowCalib.isActive(this)) roiEditor.handleCanvasClick(this, e); });
    this.canvas.addEventListener('dblclick', (e) => { if (!flowCalib.isActive(this)) roiEditor.handleCanvasDoubleClick(this, e); });
    this.canvas.addEventListener('mousedown', (e) => (flowCalib.isActive(this)
      ? flowCalib.handleMouseDown(this, e) : roiEditor.handleCanvasMouseDown(this, e)));
    this.canvas.addEventListener('mousemove', (e) => (flowCalib.isActive(this)
      ? flowCalib.handleMouseMove(this, e) : roiEditor.handleCanvasMouseMove(this, e)));
    this.canvas.addEventListener('mouseup', (e) => (flowCalib.isActive(this)
      ? flowCalib.handleMouseUp(this, e) : roiEditor.handleCanvasMouseUp(this, e)));
  }

  /**
   * 36분할 타일은 영상 영역이 너무 낮아 ROI 편집 폼(저장 버튼 포함)이 타일 밖으로 잘린다.
   * 그래서 ROI 편집을 시작하기 전에 확대 보기로 먼저 옮긴다. emit은 동기 호출이라 확대가 끝난 뒤 편집이 시작되며,
   * 타일 DOM을 옮기는 것이라 편집 상태는 확대 보기 안에서 그대로 이어진다.
   * ⛶로 한 타일만 크게 보고 있거나 이미 확대 보기 안(그리드 밖)이면 할 필요가 없다.
   */
  _zoomIfDense() {
    if (this.el.closest('.grid-dense:not(.solo-active)')) emit('tile:zoom', { cellIndex: this.cellIndex });
  }

  _resizeCanvas() {
    const rect = this.videoWrap.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width));
    this.canvas.height = Math.max(1, Math.round(rect.height));
    // object-fit은 CSS로 정해지고 실행 중에는 바뀌지 않으므로 크기가 바뀔 때 한 번만 읽어 둔다.
    // 프레임마다 getComputedStyle을 부르면 36타일 x 초당 수십 프레임의 강제 스타일 재계산이 생긴다.
    this._objectFit = getComputedStyle(this.videoEl).objectFit || 'fill';
    // "탐지 N · 최대침범률" 배지도 유속값 라벨과 같은 크기 규칙(11~13px)을 쓴다.
    this.badgeEl.style.fontSize = `${flowLabelFontPx({ w: rect.width })}px`;
    this.render();
  }

  /**
   * 타일 DOM을 다른 컨테이너로 옮긴 뒤(확대 열기/닫기) 호출한다.
   * 캔버스를 새 크기에 맞춰 다시 잡아 ROI 오버레이가 어긋나지 않게 하고,
   * DOM 이동으로 멈추는 브라우저가 있어 재생을 다시 걸어 준다(스트림 자체는 그대로 유지된다).
   */
  reflow() {
    this._resizeCanvas();
    this.videoEl.play?.().catch(() => {});
  }

  async setChannel(channel) {
    this._stopVideo();
    this.channel = channel;
    this.lastFrame = null;
    this.lastFlow = null;
    this._badgeText = '';
    roiEditor.cancel(this);
    flowCalib.cancel(this);
    this.el.classList.toggle('has-channel', !!channel);

    if (!channel) {
      this.titleEl.textContent = '';
      // 직전 채널의 "영상 연결 실패" 같은 안내가 빈 칸에 남지 않도록 원래 문구로 되돌린다.
      this.placeholderEl.innerHTML = EMPTY_TEXT;
      this.placeholderEl.style.display = 'flex';
      this.badgeEl.style.display = 'none';
      this.renderChips(); // 칩을 비우고 "ROI수정" 버튼도 함께 비활성화한다
      this.render();
      return;
    }

    this.titleEl.textContent = channel.title;
    this.placeholderEl.style.display = channel.rtspUrl ? 'none' : 'flex';
    if (!channel.rtspUrl) this.placeholderEl.textContent = 'RTSP 주소가 설정되지 않았습니다 (설정 > 채널 관리)';
    this.badgeEl.style.display = 'block';
    this.badgeEl.textContent = '';
    this.renderChips();
    this.render();

    if (channel.rtspUrl && channel.enabled !== false) await this._startVideo();
  }

  /**
   * 같은 채널의 설정만 새로 받았을 때(제목/ROI 등). 영상 주소나 사용 여부가 바뀐 경우에만 영상을 다시 붙인다.
   * 미리 연결해 둔 타일을 화면에 올릴 때와 refreshSoft가 함께 쓴다.
   */
  refreshChannel(channel) {
    const prev = this.channel;
    if (!channel || !prev || channel.channelId !== prev.channelId
      || prev.rtspUrl !== channel.rtspUrl || (prev.enabled !== false) !== (channel.enabled !== false)) {
      this.setChannel(channel);
      return;
    }
    this.channel = channel;
    if (this.titleEl.contentEditable !== 'true') this.titleEl.textContent = channel.title;
    this.renderChips();
    this.render();
  }

  /**
   * 화면에서 내려 "미리 연결" 보관함(grid.js의 warmPool)으로 옮기기 전 정리. 영상 연결은 그대로 두고,
   * 편집 상태와 지난 탐지/유속 결과(보관 중에는 구독하지 않아 갱신되지 않는다)만 지운다 —
   * 그래야 다시 화면에 올렸을 때 오래된 침범률·유속이 실시간처럼 보이지 않는다.
   */
  park() {
    roiEditor.cancel(this);
    flowCalib.cancel(this);
    if (this.titleEl.contentEditable === 'true') this.titleEl.contentEditable = 'false';
    this.lastFrame = null;
    this.lastFlow = null;
    this._badgeText = '';
    if (this.channel) this.badgeEl.textContent = '';
    this.el.classList.remove('is-solo', 'drag-over', 'drag-source', 'tile-alarming', 'tile-alarm');
    clearTimeout(this._alarmTimer);
    this.cellIndex = -1;
    this.render();
  }

  // ---------------- 영상 연결 / 재연결 ----------------

  /** 현재 영상 연결과 모든 재시도/감시 타이머를 정리한다 (채널 교체·타일 제거 시). */
  _stopVideo() {
    this._videoGen++;
    clearTimeout(this._videoRetryTimer);
    this._videoRetryTimer = null;
    clearTimeout(this._videoGraceTimer);
    this._videoGraceTimer = null;
    clearInterval(this._stallTimer);
    this._stallTimer = null;
    this._videoRetryMs = VIDEO_RETRY_MIN_MS;
    if (this.whepHandle) { this.whepHandle.close(); this.whepHandle = null; }
  }

  async _startVideo() {
    const gen = ++this._videoGen;
    const channel = this.channel;
    const mtx = state.config.mediamtx;
    const whepUrl = `http://${mtx.host}:${mtx.whepPort}/${encodeURIComponent(channel.channelId)}/whep`;
    let handle;
    try {
      handle = await attachWhep(this.videoEl, whepUrl, {
        onStateChange: (st, pc) => this._onVideoState(gen, st, pc)
      });
    } catch (err) {
      if (gen !== this._videoGen) return; // 기다리는 사이 채널이 바뀌었거나 타일이 사라짐
      this._scheduleVideoRetry(gen, `영상 연결 실패 (MediaMTX 확인): ${err.message}`);
      return;
    }
    if (gen !== this._videoGen) { handle.close(); return; }
    this.whepHandle = handle;
    this._startStallWatch(gen);
  }

  _onVideoState(gen, st, pc) {
    if (gen !== this._videoGen) return;
    if (st === 'connected') {
      clearTimeout(this._videoGraceTimer);
      this._videoGraceTimer = null;
      this._videoRetryMs = VIDEO_RETRY_MIN_MS;
      this.placeholderEl.style.display = 'none';
      return;
    }
    if (st === 'failed' || st === 'closed') {
      this._scheduleVideoRetry(gen, `영상 연결 끊김 (${st})`);
      return;
    }
    if (st === 'disconnected') {
      clearTimeout(this._videoGraceTimer);
      this._videoGraceTimer = setTimeout(() => {
        this._videoGraceTimer = null;
        if (gen === this._videoGen && pc.connectionState !== 'connected') {
          this._scheduleVideoRetry(gen, '영상 연결 끊김');
        }
      }, VIDEO_DISCONNECT_GRACE_MS);
    }
  }

  /** 영상을 내리고 사유를 표시한 뒤 백오프 간격으로 다시 붙인다. 같은 세대에서 이미 예약돼 있으면 무시. */
  _scheduleVideoRetry(gen, reason) {
    if (gen !== this._videoGen || this._videoRetryTimer) return;
    const delay = this._videoRetryMs;
    this._videoRetryMs = Math.min(this._videoRetryMs * 2, VIDEO_RETRY_MAX_MS);
    this._videoRetryTimer = setTimeout(() => {
      this._videoRetryTimer = null;
      if (gen === this._videoGen && this.channel) this._startVideo();
    }, delay);
    clearInterval(this._stallTimer);
    this._stallTimer = null;
    // 멈춘 마지막 장면을 그대로 두면 실시간으로 오해할 수 있으니 영상을 내리고 상태를 보여준다.
    if (this.whepHandle) { this.whepHandle.close(); this.whepHandle = null; }
    this.placeholderEl.style.display = 'flex';
    this.placeholderEl.textContent = `${reason} — ${Math.round(delay / 1000)}초 후 다시 연결`;
  }

  /** 연결은 살아 있는데 디코딩되는 프레임이 늘지 않는 "정지" 상태를 감시한다. */
  _startStallWatch(gen) {
    clearInterval(this._stallTimer);
    this._stallFrames = -1;
    this._stallStrikes = 0;
    this._stallTimer = setInterval(() => {
      if (gen !== this._videoGen) { clearInterval(this._stallTimer); return; }
      // 숨겨진 탭이나 보이지 않는 타일(⛶ 단독 보기 중인 다른 타일)은 브라우저가 디코딩을 멈추므로 판단하지 않는다.
      if (document.visibilityState !== 'visible' || this.videoWrap.offsetWidth === 0) { this._stallStrikes = 0; return; }
      if (this.whepHandle?.pc?.connectionState !== 'connected') return;
      const frames = this._decodedFrames();
      if (frames === this._stallFrames) {
        if (++this._stallStrikes >= VIDEO_STALL_STRIKES) this._scheduleVideoRetry(gen, '영상 프레임 정지');
      } else {
        this._stallStrikes = 0;
      }
      this._stallFrames = frames;
    }, VIDEO_STALL_CHECK_MS);
  }

  _decodedFrames() {
    const q = this.videoEl.getVideoPlaybackQuality?.();
    return q ? q.totalVideoFrames : this.videoEl.currentTime;
  }

  // ---------------- 표시 ----------------

  renderChips() {
    const rois = this.channel ? getRoisForChannel(this.channel.channelId) : [];
    // 수정할 ROI가 있을 때만 "ROI수정"을 누를 수 있다 (ROI 추가/삭제 후에도 여기서 같이 갱신된다).
    this.roiEditBtn.disabled = rois.length === 0;
    this.roiEditBtn.title = rois.length === 0
      ? '수정할 ROI가 없습니다 — 먼저 ＋ROI로 추가하세요'
      : 'ROI 수정 (임계값·눈금 기준선·이름)';
    if (!this.channel) { this.chipsEl.innerHTML = ''; return; }
    this.chipsEl.innerHTML = '';
    for (const roi of rois) {
      const chip = document.createElement('span');
      chip.className = 'roi-chip';
      chip.style.borderColor = roi.color;
      // 물높이 기준 ROI는 임계값의 단위가 %가 아니라 m, 유속 기준 ROI는 m/s 다.
      chip.textContent = isHeightRoi(roi)
        ? `${roi.name} ${formatMeters(roi.thresholdM)}`
        : roi.thresholdMode === 'velocity'
          ? `${roi.name} ${formatMps(roi.thresholdMps)}`
          : `${roi.name} ${roi.threshold}%`;
      chip.onclick = () => { this._zoomIfDense(); flowCalib.cancel(this); roiEditor.selectForEdit(this, roi); };
      this.chipsEl.appendChild(chip);
    }
  }

  updateFrame(frame) {
    this.lastFrame = frame;
    const intrusions = frame.intrusions || [];
    const levels = intrusions.filter((i) => i.mode === 'height' && i.levelM != null);
    const percents = intrusions.filter((i) => i.mode !== 'height');
    // 서버는 "탐지 오버레이 표시"가 꺼져 있으면 폴리곤(objects) 대신 개수(objectCount)만 보낸다.
    const parts = [`탐지 ${frame.objectCount ?? frame.objects?.length ?? 0}`];
    if (levels.length > 0) parts.push(`최고수위 ${formatMeters(Math.max(...levels.map((i) => i.levelM)))}`);
    if (percents.length > 0 || levels.length === 0) {
      parts.push(`최대침범률 ${intrusions.reduce((m, i) => Math.max(m, i.ratePct), 0).toFixed(1)}%`);
    }
    const text = parts.join(' · ');
    // 같은 글자를 매 프레임 다시 써 넣으면 그때마다 레이아웃이 더러워진다 — 바뀌었을 때만 쓴다.
    if (text !== this._badgeText) {
      this._badgeText = text;
      this.badgeEl.textContent = text;
    }
    // ROI 편집 중이면 폼의 "현재 측정값"도 같이 갱신한다(눈금 기준자를 맞추는 데 필요).
    roiEditor.updateLiveReading(this);
    this.render();
  }

  /** 유속 서비스 결과(초당 1회). 도착 시각을 같이 기억해 끊기면 표시를 거둘 수 있게 한다. */
  updateFlow(flow) {
    this.lastFlow = { ...flow, receivedAt: Date.now() };
    roiEditor.updateLiveReading(this); // 유속 ROI 편집 중이면 "현재 유속"을 갱신
    this.render();
    // 다음 결과가 안 오면 FLOW_STALE_MS 뒤에 한 번 더 그려서 끊긴 상태("-")를 반영한다.
    clearTimeout(this._flowStaleTimer);
    this._flowStaleTimer = setTimeout(() => this.render(), FLOW_STALE_MS + 100);
  }

  _freshFlow() {
    const f = this.lastFlow;
    return f && Date.now() - f.receivedAt <= FLOW_STALE_MS ? f : null;
  }

  flashAlarm() {
    this.el.classList.add('tile-alarm');
    clearTimeout(this._alarmTimer);
    this._alarmTimer = setTimeout(() => this.el.classList.remove('tile-alarm'), 8000);
  }
  clearAlarmFlash() {
    this.el.classList.remove('tile-alarm');
    clearTimeout(this._alarmTimer);
  }

  /**
   * 다시 그리기 요청. 실제 그리기는 다음 화면 갱신 시점(requestAnimationFrame)에 한 번만 한다.
   * 여러 채널의 프레임이 같은 순간에 몰려오거나 마우스 드래그 이벤트가 연달아 와도 타일당 초당 60회를 넘지 않고,
   * 숨긴 탭에서는 브라우저가 rAF를 멈추므로 보이지 않는 화면을 그리느라 CPU를 쓰지 않는다.
   */
  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.renderNow();
    });
  }

  /** 즉시 그리기 — 캔버스 내용을 바로 읽어야 하는 곳(알람 스냅샷)에서만 쓴다. */
  renderNow() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.channel) return;
    if (w <= 1 && h <= 1) return; // display:none 상태(단독 보기 중인 다른 타일) — 그릴 곳이 없다

    // 정규화 좌표는 항상 "영상이 실제로 그려지는 영역" 기준으로 매핑해야 확대/축소해도 어긋나지 않는다.
    // 지금은 object-fit: fill이라 칸 전체가 곧 영상 영역이지만, 계산은 videoRect.js가 CSS 값을 읽어 알아서 맞춘다.
    const videoRect = getVideoContentRect(this.videoEl, w, h, this._objectFit);
    const toPx = makeToPixel(videoRect);

    const rois = getRoisForChannel(this.channel.channelId);
    const byRoi = new Map((this.lastFrame?.intrusions || []).map((i) => [i.roiId, i]));
    const flow = this._freshFlow();
    const byRoiFlow = new Map((flow?.rois || []).map((r) => [r.roiId, r]));

    const flowFont = flowLabelFontPx(videoRect);
    for (const roi of rois) {
      if (roi.thresholdMode === 'velocity') {
        drawVelocityRoi(ctx, roi, byRoiFlow.get(roi.id) || null, toPx, !!flow, videoRect);
        continue;
      }
      const it = byRoi.get(roi.id) || null;
      const rate = it?.ratePct ?? 0;
      // 편집 중이면 저장 전 입력값을 우선 사용한다 — 기준선을 끄는 즉시 결과가 보여야 맞출 수 있다.
      const draft = roiEditor.getDraftHeight(this, roi.id);
      const height = draft ? true : isHeightRoi(roi);
      const scale = draft || roi.heightScale;
      const thresholdM = draft ? draft.thresholdM : roi.thresholdM;
      // 수면선의 화면 위치는 눈금 기준자와 무관한 기하값이므로, 표시할 미터값만 현재 기준자로 다시 환산한다.
      const levelShown = height && it?.waterY != null
        ? yToMeters(it.waterY, scale, roiBounds(roi.points))
        : it?.levelM ?? null;
      // 물높이 임계값은 눈금값이라 0이나 음수도 정상 — 침범률처럼 >0으로 판단하지 않는다.
      const over = height
        ? levelShown != null && Number.isFinite(Number(thresholdM)) && levelShown >= thresholdM
        : rate >= roi.threshold && roi.threshold > 0;
      ctx.save();
      ctx.strokeStyle = over ? '#ff4d4f' : roi.color;
      ctx.fillStyle = over ? 'rgba(255,77,79,0.22)' : hexToRgba(roi.color, 0.14);
      ctx.lineWidth = over ? 3 : 2;
      ctx.beginPath();
      roi.points.forEach(([x, y], i) => {
        const [px, py] = toPx([x, y]);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // ROI 이름 라벨은 모든 모드에서 11px 고정(v0.4.7 사용자 선호 — v0.5.0 초안에서 물높이만 키웠다가 원복).
      // 키우는 것은 수면선/임계선 옆 값(drawLevelLines)뿐이다.
      drawRoiNameLabel(ctx, height
        ? `${roi.name} ${levelTextOf(levelShown, it?.saturated)} / ${formatMeters(thresholdM)}`
        : `${roi.name} ${rate.toFixed(0)}/${roi.threshold}%`, toPx(roi.points[0]), videoRect);
      ctx.restore();

      // 물높이 모드에서는 읽어낸 수면선과 임계 수위선을 눈금 위에 그대로 그려 준다.
      if (height) drawLevelLines(ctx, roi, { intrusion: it, toPx, over, scale, thresholdM, levelShown, fontPx: flowFont });
    }

    // 유속: 이 채널에 유속 결과가 한 번이라도 왔으면 ROI마다 속도/방향을 표시하고, 설정에 따라 칸별 화살표를 그린다.
    if (this.lastFlow) {
      const fs = flowSettingsOf(state.config);
      if (flow?.cells && fs.showVectors) drawFlowVectors(ctx, flow, videoRect, fs);
      for (const roi of rois) drawRoiFlowLabel(ctx, roi, byRoiFlow.get(roi.id) || null, toPx, !!flow, !!flow?.calibrated, flowFont);
    }

    // 탐지(water/road) 오버레이는 설정에서 켰을 때만 그린다 — 침범률 계산 자체는 이 표시 여부와 무관하게 항상 이뤄짐.
    // (꺼져 있으면 서버가 애초에 폴리곤을 보내지 않으므로 objects가 없다)
    if (this.lastFrame?.objects && state.config?.detectionSettings?.showOverlay) {
      for (const obj of this.lastFrame.objects) {
        const style = OBJECT_STYLES[obj.cls] || OBJECT_STYLES.default;
        const points = obj.polygon || bboxToPolygon(obj.bbox);
        if (!points) continue;
        ctx.save();
        ctx.strokeStyle = style.stroke;
        ctx.fillStyle = style.fill;
        ctx.lineWidth = 2;
        ctx.beginPath();
        points.forEach(([x, y], i) => {
          const [px, py] = toPx([x, y]);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    roiEditor.drawDraftOverlay(this, ctx, videoRect);
    flowCalib.drawOverlay(this, ctx, videoRect);
  }

  destroy() {
    roiEditor.cancel(this); // 편집 중이었다면 떠 있는 폼/키 리스너까지 정리한다
    flowCalib.cancel(this);
    this._stopVideo();
    this._ro.disconnect();
    clearTimeout(this._alarmTimer);
    clearTimeout(this._flowStaleTimer);
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this.el.remove();
  }
}

/**
 * 유속(m/s) 기준 ROI — 테두리와 "이름 유속/임계" 라벨. 판정은 서버(roiEngine.handleFlowSpeed)의 평활값 기준이며,
 * 여기서는 그 값이 임계 이상이면 빨갛게 그린다. 보정이 없거나 유속 결과가 끊기면 "-"로 보여 준다.
 */
function drawVelocityRoi(ctx, roi, rf, toPx, fresh, videoRect) {
  const v = fresh ? (rf?.speedMpsSmoothed ?? rf?.speedMps ?? null) : null;
  const thr = Number(roi.thresholdMps);
  const over = v != null && thr > 0 && v >= thr;
  ctx.save();
  ctx.strokeStyle = over ? '#ff4d4f' : roi.color;
  ctx.fillStyle = over ? 'rgba(255,77,79,0.22)' : hexToRgba(roi.color, 0.14);
  ctx.lineWidth = over ? 3 : 2;
  ctx.beginPath();
  roi.points.forEach(([x, y], i) => {
    const [px, py] = toPx([x, y]);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  drawRoiNameLabel(ctx, `${roi.name} ${formatMps(v)} / ${formatMps(thr)}`, toPx(roi.points[0]), videoRect);
  ctx.restore();
}

/**
 * ROI 이름/임계 라벨(11px 흰 글씨) — ROI 첫 꼭짓점 바로 위에 그린다.
 * ROI가 영상 맨 위나 오른쪽 끝에 붙어 있으면 라벨이 영상 밖으로 나가 잘리므로(v0.5.0 사용자 제보),
 * 영상 영역 안으로 밀어 넣는다(위로 넘치면 꼭짓점 아래쪽, 오른쪽으로 넘치면 왼쪽으로).
 */
function drawRoiNameLabel(ctx, text, [lpx, lpy], rect) {
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.font = '11px sans-serif';
  let x = lpx + 4;
  let y = lpy - 4;
  if (rect) {
    const tw = ctx.measureText(text).width;
    x = Math.max(rect.x + 2, Math.min(x, rect.x + rect.w - tw - 2));
    if (y - 11 < rect.y) y = lpy + 14; // 글자 윗부분이 영상 위로 나가면 꼭짓점 아래로
    y = Math.min(y, rect.y + rect.h - 3);
    // 안으로 밀려 들어오면 ROI 테두리 선과 겹치므로 그때만 옅은 바탕을 깐다(평소 모습은 이전 버전 그대로)
    if (x !== lpx + 4 || y !== lpy - 4) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - 3, y - 11, tw + 6, 15);
      ctx.fillStyle = '#fff';
    }
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * 유속값 라벨(drawRoiFlowLabel), 칸 오른쪽 아래 "탐지 N · 최대침범률" 배지, 물높이 수면선/임계선 옆 값(v0.5.0)의 글자 크기(px).
 * 영상 영역 폭에 비례하되(폭/60) 작은 칸에서는 11px, 1분할 전체화면에서도 최대 13px.
 * ROI 이름/임계 라벨(drawRoiNameLabel, 침범률·유속·물높이 전부)은 11px 고정이다 — 키웠다가 사용자 요청으로 원복(v0.4.7, v0.5.0).
 */
function flowLabelFontPx(videoRect) {
  return Math.round(Math.min(13, Math.max(11, (videoRect?.w || 0) / 60)));
}

/**
 * 물높이 기준 ROI 위에 가로선 두 개를 그린다.
 *  - 점선(빨강): 임계 수위 — 물이 여기까지 차면 알람
 *  - 실선: 지금 읽어낸 수면선 (임계 초과 시 빨강)
 * 선은 ROI 좌우 폭보다 조금 넓게 그려서 눈금판 위에서 바로 대조할 수 있게 한다.
 */
function drawLevelLines(ctx, roi, { intrusion, toPx, over, scale, thresholdM, levelShown, fontPx = 11 }) {
  const b = roiBounds(roi.points);

  const line = (normY, color, dash, text) => {
    if (!Number.isFinite(normY) || normY < b.minY || normY > b.maxY) return; // ROI 눈금 범위 밖이면 그리지 않는다
    const [x1, py] = toPx([b.minX, normY]);
    const [x2] = toPx([b.maxX, normY]);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x1 - 8, py);
    ctx.lineTo(x2 + 8, py);
    ctx.stroke();
    ctx.setLineDash([]);
    // 선 끝 오른쪽에 선 높이 가운데를 맞춘 라벨(유속값 라벨과 같은 크기/바탕)
    drawBoxedLabel(ctx, text, x2 + 11, py, fontPx, color, 'middle');
    ctx.restore();
  };

  if (Number.isFinite(Number(thresholdM))) {
    line(metersToY(thresholdM, scale, b), '#ff5c5c', [5, 4], `임계 ${formatMeters(thresholdM)}`);
  }
  if (intrusion?.waterY != null) {
    line(intrusion.waterY, over ? '#ff4d4f' : '#00e5ff', [], levelTextOf(levelShown, intrusion.saturated));
  }
}

/**
 * 굵은 글씨 + 반투명 검은 바탕 상자 라벨 (drawRoiFlowLabel과 같은 모양). x는 글자 왼쪽 끝.
 * anchorY는 align='bottom'이면 상자 아래 끝, 'middle'이면 상자 세로 가운데.
 */
function drawBoxedLabel(ctx, text, x, anchorY, fontPx, color, align = 'bottom') {
  ctx.save();
  ctx.font = `bold ${fontPx}px sans-serif`;
  const tw = ctx.measureText(text).width;
  const pad = Math.round(fontPx * 0.3);
  const boxH = fontPx + pad * 2;
  const boxTop = align === 'middle' ? anchorY - boxH / 2 : anchorY - boxH;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - pad, boxTop, tw + pad * 2, boxH);
  ctx.fillStyle = color;
  ctx.fillText(text, x, boxTop + pad + Math.round(fontPx * 0.85));
  ctx.restore();
}

/** 서버 server/roi/flowEngine.js 의 flowSettingsOf / isReliableCell 과 같은 기준이어야 한다(화살표 = ROI 계산에 쓴 칸). */
function flowSettingsOf(cfg) {
  const s = cfg?.flowSettings || {};
  return {
    showVectors: s.showVectors !== false,
    fbMin: Number.isFinite(Number(s.fbMin)) ? Number(s.fbMin) : 0.8,
    rMin: Number.isFinite(Number(s.rMin)) ? Number(s.rMin) : 0.7
  };
}

function isReliableCell(cell, { fbMin, rMin }) {
  if (!cell) return false;
  const [vx, vy, fb, r] = cell;
  return vx != null && vy != null && fb != null && r != null && fb >= fbMin && r >= rMin;
}

/**
 * 믿을 수 있는 칸마다 "1초 동안 수면이 움직이는 거리"만큼의 화살표를 그린다(칸 크기의 1.2배에서 자름).
 * 비스듬한 카메라는 화면 위쪽(먼 곳)이 같은 물살이어도 짧게 보인다 — 실제 m/s 는 현장 보정이 있어야 같아진다.
 */
function drawFlowVectors(ctx, flow, rect, fs) {
  const { cols, rows } = flow.grid || {};
  const cells = flow.cells;
  if (!cols || !rows || !cells || cells.length !== cols * rows) return;
  const cw = rect.w / cols;
  const ch = rect.h / rows;
  const maxLen = Math.min(cw, ch) * 1.2;
  ctx.save();
  ctx.strokeStyle = '#7CFFB2';
  ctx.fillStyle = '#7CFFB2';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 2;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const cell = cells[i * cols + j];
      if (!isReliableCell(cell, fs)) continue;
      let dx = cell[0] * rect.w;
      let dy = cell[1] * rect.h;
      const len = Math.hypot(dx, dy);
      if (len < 2) continue; // 거의 안 움직이는 칸은 점도 찍지 않는다(화면 잡음)
      if (len > maxLen) { dx *= maxLen / len; dy *= maxLen / len; }
      const x0 = rect.x + (j + 0.5) * cw;
      const y0 = rect.y + (i + 0.5) * ch;
      drawArrow(ctx, x0, y0, x0 + dx, y0 + dy);
    }
  }
  ctx.restore();
}

function drawArrow(ctx, x0, y0, x1, y1, headMax = 6) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const head = Math.min(headMax, Math.hypot(x1 - x0, y1 - y0) * 0.45);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45));
  ctx.lineTo(x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

/**
 * ROI 이름 아래에 "유속 47px/s ↗"(화면 기준 속도와 방향)을 표시한다. 방향 표시는 실제 방향으로 돌린 작은 화살표.
 * 유속 결과가 끊겼거나 ROI 안에 믿을 칸이 없으면 "-"로 표시해 오래된 값을 실시간으로 오해하지 않게 한다.
 */
function drawRoiFlowLabel(ctx, roi, rf, toPx, fresh, calibrated, fontPx = 14) {
  const [lpx, lpy] = toPx(roi.points[0]);
  const ok = fresh && rf && rf.speedPx != null;
  // 보정된 채널은 실제 유속(m/s). 유속 ROI는 알람 판정에 쓴 평활값을 보여 줘 위쪽 라벨·알람과 같은 숫자가 되게 한다.
  const mps = rf?.speedMpsSmoothed ?? rf?.speedMps;
  const speedText = calibrated
    ? (mps != null ? `${formatMps(mps)}${rf.outsideCalib ? ' 보정범위 밖' : ''}` : '- m/s')
    : `${Math.round(rf?.speedPx ?? 0)}px/s 보정 전`;
  const text = ok
    ? `유속 ${speedText} (${rf.cellsValid}/${rf.cellsInside}칸)`
    : (fresh ? '유속 - (믿을 칸 없음)' : '유속 - (수신 없음)');
  ctx.save();
  ctx.font = `bold ${fontPx}px sans-serif`;
  const tw = ctx.measureText(text).width;
  const pad = Math.round(fontPx * 0.3);
  const arrowR = Math.round(fontPx * 0.5);   // 방향 화살표 반길이
  const arrowW = ok ? arrowR * 2 + pad * 2 : 0;
  const x = lpx + 4;
  const boxTop = lpy + 3;                     // ROI 꼭짓점 바로 아래(위쪽 유속 ROI 라벨과 겹치지 않게)
  const boxH = fontPx + pad * 2;
  const y = boxTop + pad + Math.round(fontPx * 0.85); // 글자 바닥선
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - pad, boxTop, tw + pad * 2 + arrowW, boxH);
  ctx.fillStyle = ok ? '#7CFFB2' : '#c8cfd8';
  ctx.fillText(text, x, y);
  if (ok && rf.dirDeg != null) {
    ctx.strokeStyle = '#7CFFB2';
    ctx.lineWidth = Math.max(1.5, fontPx / 8);
    const a = rf.dirDeg * Math.PI / 180;
    const cx = x + tw + pad + arrowR;
    const cy = boxTop + boxH / 2;
    drawArrow(ctx, cx - arrowR * Math.cos(a), cy - arrowR * Math.sin(a), cx + arrowR * Math.cos(a), cy + arrowR * Math.sin(a), Math.max(6, fontPx * 0.45));
  }
  ctx.restore();
}

// 보드가 보내는 세그멘테이션 클래스별 표시 스타일 (water=침수 감지, road=도로 참고 영역)
const OBJECT_STYLES = {
  water: { stroke: '#38bdf8', fill: 'rgba(56,189,248,0.28)' },
  road: { stroke: '#a78bfa', fill: 'rgba(167,139,250,0.12)' },
  default: { stroke: '#ffcc33', fill: 'rgba(255,204,51,0.18)' }
};

function bboxToPolygon(bbox) {
  if (!bbox) return null;
  const [x, y, w, h] = bbox;
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#3aa0ff');
  if (!m) return `rgba(58,160,255,${alpha})`;
  const [, r, g, b] = m;
  return `rgba(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)},${alpha})`;
}
