// 모달 창을 제목 표시줄 드래그로 옮길 수 있게 한다.
//
// .modal은 flex로 화면 가운데 정렬되어 있으므로 left/top을 직접 건드리지 않고 transform으로 옮긴다.
// 이렇게 하면 (1) 기존 정렬 CSS를 그대로 두고 "가운데 기준 상대 위치"만 기억하면 되고,
// (2) 브라우저 창 크기가 바뀌어도 모달이 화면 중앙 근처에 자연스럽게 따라간다.
//
// 창은 화면(뷰포트) 밖으로 단 1px도 나가지 못한다. 드래그 중 매 이동마다 경계로 잘라내므로
// 커서가 화면 밖으로 나가도 창은 경계에 붙어 멈추고, 커서가 다시 들어오면 그대로 따라온다.
// 창 크기 변경·브라우저 확대/축소·탭 전환으로 모달 높이가 달라질 때도 같은 규칙을 다시 적용한다.

/**
 * @param {HTMLElement} boxEl   실제로 움직일 요소 (모달 박스)
 * @param {HTMLElement} handleEl 드래그 손잡이 (제목 표시줄)
 * @param {{storageKey?: string}} opts storageKey를 주면 옮긴 위치를 브라우저에 기억한다
 */
export function makeDraggable(boxEl, handleEl, { storageKey } = {}) {
  let dx = 0;
  let dy = 0;
  let drag = null;

  if (storageKey) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && Number.isFinite(saved.dx) && Number.isFinite(saved.dy)) {
        dx = saved.dx;
        dy = saved.dy;
      }
    } catch { /* 저장값이 깨졌으면 그냥 가운데에서 시작한다 */ }
  }
  apply();

  handleEl.addEventListener('pointerdown', (e) => {
    // 제목 표시줄 안의 버튼(닫기 등)은 드래그가 아니라 원래 동작을 해야 한다.
    if (e.button !== 0 || isInteractive(e.target)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, baseX: dx, baseY: dy };
    // 포인터를 붙잡아 두어야 커서가 손잡이 밖으로 나가도 계속 따라온다.
    // (이미 놓인 포인터면 브라우저가 던지므로 감싼다 — 그래도 드래그 자체는 계속 동작한다.)
    try { handleEl.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    boxEl.classList.add('dragging');
    e.preventDefault(); // 드래그 중 텍스트가 선택되는 것 방지
  });

  handleEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // 매번 "드래그 시작점 기준 절대 이동량"으로 다시 계산한다(누적 합산이 아님).
    // 그래서 경계에서 잘려도 어긋남이 쌓이지 않고, 커서가 화면 안으로 돌아오면 즉시 다시 따라온다.
    dx = drag.baseX + (e.clientX - drag.x);
    dy = drag.baseY + (e.clientY - drag.y);
    apply();
    clampIntoView(); // 손을 뗄 때가 아니라 이동하는 매 순간 경계를 지킨다
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    boxEl.classList.remove('dragging');
    clampIntoView();
    save();
  };
  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('pointercancel', endDrag);

  // 제목 표시줄 더블클릭 = 가운데로 복귀. 창을 구석으로 밀어놨을 때의 탈출구.
  handleEl.addEventListener('dblclick', (e) => {
    if (isInteractive(e.target)) return;
    reset();
  });

  // 브라우저 창 크기 변경 / 확대·축소 / 전체화면 전환 — 좁아진 화면 밖으로 밀려나지 않게 다시 가둔다.
  window.addEventListener('resize', () => {
    clampIntoView();
    save();
  });

  // 탭을 바꾸면 모달 높이가 달라진다 — 화면 아래쪽에 붙여 둔 상태에서 창이 커지면 경계를 넘으므로
  // 크기 변화 자체를 감시한다. (창 크기 변경/확대에서도 vw·vh 기반 max-width/height 때문에 함께 발동한다.)
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => clampIntoView()).observe(boxEl);
  }

  function apply() {
    // 일부러 반올림하지 않는다 — 반올림하면 경계에 붙였을 때 최대 0.5px 삐져나올 수 있다.
    // 경계 보정이 소수점을 만들어야 정확히 0 / vw-width 에 딱 맞춰진다.
    boxEl.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
  }

  function save() {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ dx, dy })); } catch { /* 시크릿 모드 등 */ }
  }

  /**
   * 모달 전체를 화면(뷰포트) 안에 가둔다 — 상하좌우 어느 쪽으로도 경계를 넘지 못한다.
   * getBoundingClientRect는 transform이 반영된 "지금 화면상 위치"라서, 넘어간 만큼을 그대로
   * dx/dy에서 빼주면 된다. 창 크기나 모달 높이가 바뀐 뒤에 불러도 똑같이 동작한다.
   */
  function clampIntoView() {
    const r = boxEl.getBoundingClientRect();
    if (!r.width || !r.height) return; // 모달이 닫혀 있으면(display:none) 크기가 0 — 계산할 것이 없다

    // 스크롤바가 있을 때 그 아래로 파고들지 않도록 innerWidth가 아니라 clientWidth(스크롤바 제외)를 쓴다.
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    // 모달이 화면보다 큰 비정상 상황(창을 아주 작게 줄인 경우 등)에서는 범위가 음수가 되어
    // 좌우로 튀게 되므로, 그때는 좌상단에 붙이는 것으로 정한다.
    const maxLeft = Math.max(0, vw - r.width);
    const maxTop = Math.max(0, vh - r.height);
    const adjX = clamp(r.left, 0, maxLeft) - r.left;
    const adjY = clamp(r.top, 0, maxTop) - r.top;

    if (adjX || adjY) {
      dx += adjX;
      dy += adjY;
      apply();
    }
  }

  function reset() {
    dx = 0;
    dy = 0;
    apply();
    save();
  }

  return { reset, clampIntoView };
}

function isInteractive(el) {
  return !!(el.closest && el.closest('button, a, input, select, textarea, label'));
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
