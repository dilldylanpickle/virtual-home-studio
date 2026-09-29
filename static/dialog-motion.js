import { motionDuration, MOTION_EASING } from './ui-motion.js';

const resting = { opacity: '1', transform: 'none' };
const tucked = { opacity: '0', transform: 'translateY(10px) scale(.985)' };
const resolveElement = value => typeof value === 'function' ? value() : value;

/** Native modality and focus stay in force until a reversible visual close finishes. */
export class DialogMotion {
  constructor(dialog, { initialFocus, returnFocus } = {}) {
    this.dialog = dialog;
    this.initialFocus = initialFocus;
    this.returnFocus = returnFocus;
    this.opener = null;
    this.animation = null;
    this.finishTransition = null;
    this.generation = 0;
    this.opening = dialog.open;
    dialog.dataset.motion = dialog.open ? 'open' : 'closed';
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close();
    });
    dialog.addEventListener('close', () => {
      // A queued close event from an earlier operation cannot cancel a reopened panel.
      if (dialog.open) return;
      this.cancelAnimation();
      this.opening = false;
      dialog.dataset.motion = 'closed';
    });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
      if (event.matches) this.finishTransition?.();
    });
  }

  cancelAnimation() {
    this.generation++;
    this.finishTransition = null;
    this.animation?.cancel();
    this.animation = null;
  }

  currentAppearance() {
    const style = getComputedStyle(this.dialog);
    return { opacity: style.opacity, transform: style.transform };
  }

  open() {
    if (this.dialog.open && this.opening) return;
    const wasOpen = this.dialog.open;
    const start = wasOpen ? this.currentAppearance() : tucked;
    this.cancelAnimation();
    this.opening = true;
    if (!wasOpen) {
      this.opener = document.activeElement;
      this.dialog.dataset.motion = 'closed';
      this.dialog.showModal();
      // Establish the backdrop's transparent starting style before its CSS transition.
      getComputedStyle(this.dialog, '::backdrop').backgroundColor;
    }
    this.dialog.dataset.motion = 'open';
    const focus = resolveElement(this.initialFocus);
    if (focus && this.dialog.contains(focus)) focus.focus({ preventScroll: true });
    this.transition(start, resting, () => {});
  }

  close({ immediate = false, restoreFocus = true } = {}) {
    if (!this.dialog.open) return;
    if (!this.opening && !immediate) return;
    const start = this.currentAppearance();
    this.cancelAnimation();
    this.opening = false;
    this.dialog.dataset.motion = 'closed';
    const finish = () => {
      this.dialog.close();
      if (restoreFocus) {
        const focus = resolveElement(this.returnFocus) || this.opener;
        if (focus?.isConnected && !focus.disabled) focus.focus({ preventScroll: true });
      }
    };
    if (immediate) finish();
    else this.transition(start, tucked, finish);
  }

  transition(start, end, finish) {
    const duration = motionDuration('panel');
    if (!duration) { finish(); return; }
    const generation = this.generation;
    const animation = this.dialog.animate([start, end], { duration, easing: MOTION_EASING, fill: 'both' });
    this.animation = animation;
    const complete = () => {
      if (generation !== this.generation || this.animation !== animation) return;
      this.finishTransition = null;
      finish();
      animation.cancel();
      this.animation = null;
    };
    this.finishTransition = complete;
    animation.finished.then(complete, () => {});
  }
}
