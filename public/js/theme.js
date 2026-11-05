// 화면 테마 — 메인 화면/설정 창/알람 팝업 등 전체 UI의 색상 테마를 고른다.
//
// 상태는 브라우저별(localStorage)로 둔다. 개발자 모드와 같은 이유로, 서버 설정에 넣으면 한 명이
// 바꾸는 순간 상황실의 모든 화면이 함께 바뀌어 버린다. 대형 모니터처럼 "항상 이 테마"로 띄우고
// 싶은 화면은 주소에 ?theme=<id>를 붙여 열면 그 값이 저장된다(initTheme 참고).
//
// 실제 색은 전부 css/style.css의 CSS 변수로 정의되어 있고, 여기서는 <html data-theme="..."> 속성만
// 바꾼다. index.html <head>의 인라인 스크립트가 같은 키를 먼저 읽어 첫 화면부터 올바른 테마로 그리므로
// (module 스크립트는 화면이 그려진 뒤 실행되어 깜빡임이 생긴다), 저장 키 이름을 바꾸면 그쪽도 같이 바꿔야 한다.
import { emit } from './bus.js';

export const THEMES = [
  {
    id: 'classic',
    name: '클래식 다크',
    icon: '🌑',
    desc: '기존 VMS 화면. 무채색의 어두운 패널과 파란 강조색으로, 장시간 감시에 눈이 편한 표준 관제 화면입니다.'
  },
  {
    id: 'ocean',
    name: '딥 오션',
    icon: '🌊',
    desc: '물속에서 올려다본 바다가 모티브. 짙은 남청색 바탕에 잔잔한 물결 무늬, 반투명 유리 패널과 아쿠아 빛, 산호색 경보.'
  },
  {
    id: 'hydro',
    name: '하이드로 차트',
    icon: '🗺️',
    desc: '수문 측량 도면이 모티브. 종이색 바탕에 등고선·모눈 무늬, 남색 제도 잉크 글자, 칸마다 번호표와 수위 눈금자. 맨 위 감시 상태 띠는 평소 남색이다가 경보가 나면 주홍 줄무늬로 바뀌어 어느 화면을 보고 있든 알 수 있습니다. 밝은 사무실·주간 근무용.'
  }
];

const KEY = 'aiwguard.theme';
const DEFAULT_THEME = THEMES[0].id;
/** 없어진 테마 id → 대신 쓸 테마. v0.5.0에서 "데이라이트"를 "하이드로 차트"로 교체했다(index.html 인라인 스크립트에도 같은 표가 있다). */
const ALIASES = { daylight: 'hydro' };

function normalize(id) {
  return ALIASES[id] || id;
}

function isValid(id) {
  return THEMES.some((t) => t.id === id);
}

export function getTheme() {
  try {
    const v = normalize(localStorage.getItem(KEY));
    return isValid(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // 시크릿 모드 등에서 접근이 막히면 기본 테마
  }
}

export function getThemeInfo(id = getTheme()) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function setTheme(id) {
  id = normalize(id);
  if (!isValid(id)) id = DEFAULT_THEME;
  try {
    if (id === DEFAULT_THEME) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch { /* 저장 못 해도 이번 세션 동안은 아래 속성으로 동작한다 */ }
  applyTheme(id);
  emit('theme:changed', id);
}

/** <html data-theme> 하나로 모든 색/배치가 결정된다 (css/style.css 참고). 선택 UI는 설정 > 화면 테마 탭에만 있다. */
export function applyTheme(id = getTheme()) {
  document.documentElement.setAttribute('data-theme', id);
}

/**
 * 시작 시 1회 호출. 주소의 ?theme=<id>가 있으면 그 테마를 저장하고(대형 모니터 자동 실행용),
 * 없으면 저장된 값을 적용한다. 알 수 없는 값은 기본 테마로 정리한다.
 */
export function initTheme() {
  let fromUrl = null;
  try { fromUrl = normalize(new URLSearchParams(location.search).get('theme')); } catch { /* ignore */ }
  if (fromUrl && isValid(fromUrl) && fromUrl !== getTheme()) {
    setTheme(fromUrl);
    return;
  }
  // 없어진 테마 id(예: daylight)로 저장돼 있으면 새 id로 고쳐 저장해 둔다
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (stored && ALIASES[stored]) { setTheme(stored); return; }
  applyTheme();
}
