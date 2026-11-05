// 개발자 모드 — 켜져 있을 때만 설정 화면의 자세한 설명 팁(.tip)이 보인다.
//
// 상태는 브라우저별(localStorage)로 둔다. 서버 설정에 넣으면 한 명이 켜는 순간 상황실의 모든
// 화면에서 설명문이 튀어나오게 되므로, "이 브라우저에서만" 켜지는 편이 맞다.
//
// 잠금 해제(비밀번호 확인)는 전적으로 서버가 한다(POST /api/dev-mode/unlock).
// 여기 저장되는 것은 "확인을 통과했다"는 사실뿐이며, 비밀번호나 해시는 브라우저에 남지 않는다.
const KEY = 'aiwguard.devMode';

export function isDevMode() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false; // 시크릿 모드 등에서 접근이 막히면 그냥 꺼진 것으로 본다
  }
}

export function setDevMode(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* 저장 못 해도 이번 세션 동안은 아래 클래스로 동작한다 */ }
  applyDevMode();
}

/** body의 dev-mode 클래스 하나로 설명 팁 표시 여부가 결정된다 (css/style.css 참고). */
export function applyDevMode() {
  document.body.classList.toggle('dev-mode', isDevMode());
}
