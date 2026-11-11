// One small dropdown, used by the transcript's "move to…" menu and the speaker chips' "who is
// this?" menu. Anchored to an element, kept on screen (below it, else above, else pinned to the
// bottom edge), closed by a click elsewhere or Escape. Only one is open at a time.

let open = null; // { el, off }

export function closeMenu() {
  if (!open) return;
  open.el.remove();
  document.removeEventListener('click', open.off, true);
  document.removeEventListener('keydown', open.key);
  open = null;
}

// Pure: where the menu goes. `box` is the anchor's rect, `size` the menu's {w, h}, `view` the window.
export function menuPosition(box, size, view) {
  const left = Math.max(8, Math.min(box.left, view.w - size.w - 8));
  let top = box.bottom + 6;
  if (top + size.h > view.h - 12) top = box.top - size.h - 6 >= 12 ? box.top - size.h - 6 : Math.max(12, view.h - size.h - 12);
  return { left: Math.round(left), top: Math.round(top) };
}

// html: the menu's contents. onClick(event, menuElement) gets every click inside it. Returns the element.
export function openMenu(anchor, html, { onClick, label = 'Menu' } = {}) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'popover'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', label);
  el.innerHTML = html;
  el.style.cssText = `position:fixed;right:auto;left:0;top:0;max-height:${Math.round(window.innerHeight * 0.7)}px;overflow:auto;width:300px`;
  document.body.appendChild(el);
  const pos = menuPosition(anchor.getBoundingClientRect(), { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
  el.style.left = `${pos.left}px`; el.style.top = `${pos.top}px`;
  const off = (e) => { if (!el.contains(e.target)) closeMenu(); };
  const key = (e) => { if (e.key === 'Escape') closeMenu(); };
  // capture phase, so a click that opens another menu closes this one first
  setTimeout(() => { if (open?.el === el) document.addEventListener('click', off, true); }, 0);
  document.addEventListener('keydown', key);
  el.onclick = (e) => onClick?.(e, el);
  open = { el, off, key };
  return el;
}
