import { motionDuration, MOTION_EASING } from './ui-motion.js';

const controllers = new WeakMap();

class DetailsMotion {
  constructor(details) {
    this.details = details;
    this.summary = details.querySelector(':scope > summary');
    this.targetOpen = details.open;
    this.expectedNativeOpen = details.open;
    this.animation = null;
    this.finishTransition = null;
    this.generation = 0;
    this.originalOverflow = details.style.overflow;
    this.originalInert = new Map();
    this.updateContent(details.open);
    details.dataset.motion = details.open ? 'open' : 'closed';
    this.summary?.addEventListener('keydown', event => {
      // Keep native Enter/Space activation from also reaching the deck's shortcuts.
      if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
    });
    this.summary?.addEventListener('click', event => {
      // Keep links or form controls nested inside a summary independent of its toggle.
      if (event.target.closest('a,button,input,select,textarea')) return;
      event.preventDefault();
      this.toggle(!this.targetOpen);
    });
    details.addEventListener('toggle', () => {
      if (details.open === this.expectedNativeOpen) return;
      // Programmatic native changes remain authoritative over an older animation.
      this.cancelAnimation();
      this.targetOpen = this.expectedNativeOpen = details.open;
      details.dataset.motion = details.open ? 'open' : 'closed';
      this.updateContent(details.open);
    });
    window.addEventListener('resize', () => this.finishTransition?.());
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
      if (event.matches) this.finishTransition?.();
    });
  }

  updateContent(open) {
    const active = document.activeElement;
    for (const child of this.details.children) {
      if (child === this.summary) continue;
      if (!this.originalInert.has(child)) this.originalInert.set(child, child.inert);
      child.inert = open ? this.originalInert.get(child) : true;
    }
    if (!open && this.details.contains(active) && !this.summary?.contains(active)) this.summary?.focus({ preventScroll: true });
  }

  cancelAnimation() {
    this.generation++;
    this.finishTransition = null;
    this.animation?.cancel();
    this.animation = null;
    this.details.style.overflow = this.originalOverflow;
  }

  toggle(open) {
    const details = this.details;
    const start = details.getBoundingClientRect().height;
    this.cancelAnimation();
    this.targetOpen = open;
    this.updateContent(open);
    details.dataset.motion = open ? 'open' : 'closed';
    const duration = motionDuration('panel');
    if (!duration || !details.getClientRects().length || !this.summary) {
      this.expectedNativeOpen = open;
      details.open = open;
      return;
    }
    // Native details stays open during collapse so its contents can leave smoothly.
    this.expectedNativeOpen = true;
    details.open = true;
    const style = getComputedStyle(details);
    const end = open ? details.getBoundingClientRect().height
      : this.summary.getBoundingClientRect().height + ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
        .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
    details.style.overflow = 'hidden';
    const generation = this.generation;
    const animation = details.animate([{ height: `${start}px` }, { height: `${end}px` }], { duration, easing: MOTION_EASING, fill: 'both' });
    this.animation = animation;
    const complete = () => {
      if (generation !== this.generation || this.animation !== animation) return;
      this.finishTransition = null;
      this.expectedNativeOpen = open;
      details.open = open;
      animation.cancel();
      this.animation = null;
      details.style.overflow = this.originalOverflow;
    };
    this.finishTransition = complete;
    animation.finished.then(complete, () => {});
  }
}

/** Idempotent setup; native summary activation still supplies pointer and keyboard clicks. */
export function setupDetailsMotion(root = document) {
  return [...root.querySelectorAll('details')].map(details => {
    if (!controllers.has(details)) controllers.set(details, new DetailsMotion(details));
    return controllers.get(details);
  });
}
