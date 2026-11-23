// Phones: while the on-screen keyboard is open, hide the bottom navigation (like WhatsApp) instead of
// letting it ride up on top of the keyboard. Sets `kb-open` on <html>; the CSS does the rest.
const TEXT_FIELD = 'textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=button]):not([type=submit]), [contenteditable=""], [contenteditable="true"]';
const phone = window.matchMedia('(max-width: 860px) and (pointer: coarse)');

let fullHeight = 0; // tallest viewport seen in this orientation = no keyboard

function viewportHeight() {
  return window.visualViewport?.height ?? window.innerHeight;
}

function update() {
  const h = Math.max(window.innerHeight, viewportHeight());
  if (h > fullHeight) fullHeight = h;
  const field = document.activeElement?.matches?.(TEXT_FIELD);
  // Some browsers shrink the page for the keyboard, others only the visual viewport: either way it gets shorter.
  const shrunk = fullHeight - viewportHeight() > 120 || fullHeight - window.innerHeight > 120;
  document.documentElement.classList.toggle('kb-open', Boolean(phone.matches && field && shrunk));
}

export function watchKeyboard() {
  window.visualViewport?.addEventListener('resize', update);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', () => {
    fullHeight = 0;
    setTimeout(update, 300);
  });
  document.addEventListener('focusin', () => setTimeout(update, 50));
  document.addEventListener('focusout', () => setTimeout(update, 50));
  update();
}
