/** Presentation-only motion: model commands and accessible text update immediately. */
const preferences = matchMedia('(prefers-reduced-motion: reduce)');
export const MOTION_EASING = 'cubic-bezier(.22, 1, .36, 1)';
export function motionDuration(kind = 'panel') {
  if (preferences.matches) return 0;
  const configured = getComputedStyle(document.documentElement).getPropertyValue(`--ui-motion-${kind}`).trim();
  const fallback = kind === 'quick' ? 140 : 220;
  if (!configured) return fallback;
  const value = Number.parseFloat(configured);
  return Number.isFinite(value) ? value * (configured.endsWith('ms') ? 1 : 1000) : fallback;
}

const textAnimations = new WeakMap(), activeTextAnimations = new Set();
export function setAnimatedText(node, value) {
  value = String(value);
  if (node.textContent === value) return;
  const previous = node.textContent;
  textAnimations.get(node)?.cancel();
  node.textContent = value;
  const duration = motionDuration('quick');
  if (!previous || !value || !duration || !node.getClientRects().length) return;
  const animation = node.animate([
    { opacity: .35, transform: 'translateY(2px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration, easing: MOTION_EASING });
  textAnimations.set(node, animation); activeTextAnimations.add(animation);
  const cleanup = () => {
    activeTextAnimations.delete(animation);
    if (textAnimations.get(node) === animation) textAnimations.delete(node);
  };
  animation.finished.then(cleanup, cleanup);
}
preferences.addEventListener('change', () => {
  if (preferences.matches) for (const animation of activeTextAnimations) animation.cancel();
});

/** A single-line label too long for its box scrolls as a seamless loop: a copy of the
 * text follows after a gap (CSS ::after from data-loop) and the track moves by exactly one
 * text-plus-gap width. Reduced motion keeps the ellipsis; the tooltip has the full text. */
export function marquee(node) {
  const GAP = 48, SPEED = 38;
  const update = () => {
    node.classList.remove('marquee'); node.title = node.textContent;
    if (node.scrollWidth - node.clientWidth <= 1 || preferences.matches) return;
    const distance = node.scrollWidth + GAP;
    node.dataset.loop = node.textContent;
    node.style.setProperty('--marquee-gap', `${GAP}px`);
    node.style.setProperty('--marquee-distance', `${distance}px`);
    node.style.setProperty('--marquee-duration', `${(distance / SPEED).toFixed(2)}s`);
    node.classList.add('marquee');
  };
  // Observe the clipping box, not the label: the running ticker changes the label's own width.
  new ResizeObserver(update).observe(node.parentElement);
  new MutationObserver(update).observe(node, { childList: true, characterData: true, subtree: true });
  preferences.addEventListener('change', update);
  update();
}

/** Keep a popup painted while it exits, but make it inert as soon as it closes. */
export class PopupMotion {
  constructor(node, place = () => {}) {
    this.node = node; this.place = place; this.expanded = !node.hidden;
    this.animation = null; this.generation = 0;
    node.inert = !this.expanded;
    node.setAttribute('aria-hidden', String(!this.expanded));
    preferences.addEventListener('change', () => { if (preferences.matches) this.settle(); });
  }
  open() { this.move(true); }
  close({ immediate = false } = {}) { this.move(false, immediate); }
  move(expanded, immediate = false) {
    if (this.expanded === expanded) {
      if (immediate) this.settle();
      return;
    }
    const node = this.node, wasHidden = node.hidden;
    const current = this.animation ? getComputedStyle(node) : null;
    const from = current ? { opacity: current.opacity, transform: current.transform } : null;
    this.animation?.cancel(); this.animation = null;
    const generation = ++this.generation;
    this.expanded = expanded;
    node.inert = !expanded; node.setAttribute('aria-hidden', String(!expanded));
    node.dataset.motion = expanded ? 'opening' : 'closing';
    if (expanded) { node.hidden = false; this.place(); }
    const below = node.dataset.placement === 'below';
    const closed = { opacity: 0, transform: `translateX(-50%) translateY(${below ? -7 : 7}px) scale(.98)` };
    const opened = { opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1)' };
    node.style.transformOrigin = below ? 'center top' : 'center bottom';
    const duration = immediate ? 0 : motionDuration(expanded ? 'panel' : 'quick');
    if (!duration || (!expanded && wasHidden)) { this.settle(); return; }
    this.animation = node.animate([from || (expanded ? closed : opened), expanded ? opened : closed],
      { duration, easing: MOTION_EASING, fill: 'both' });
    this.animation.finished.then(() => {
      if (generation === this.generation) this.settle();
    }, () => {});
  }
  settle() {
    ++this.generation;
    this.node.hidden = !this.expanded;
    this.node.inert = !this.expanded;
    this.node.dataset.motion = this.expanded ? 'open' : 'closed';
    this.animation?.cancel(); this.animation = null;
  }
}
