import { DialogMotion } from './dialog-motion.js';

/** Local selection delegates to the existing file input; this layer owns presentation only. */
const $ = id => document.getElementById(id);

export class MediaSourceUI {
  constructor(controls) {
    this.dialog = $('media-source');
    this.motion = new DialogMotion(this.dialog, { initialFocus: $('source-local'), returnFocus: $('load') });
    $('load').addEventListener('click', () => this.open());
    $('media-source-close').addEventListener('click', () => this.close());
    $('source-local').addEventListener('click', () => {
      // Keep the native picker in the trusted Local file activation stack.
      this.motion.close({ immediate: true });
      $('file-input').click();
    });
    this.unsubscribe = controls.subscribe(state => this.render(state));
  }

  open() {
    this.motion.open();
  }

  close() {
    this.motion.close();
  }

  render(s) {
    const empty = !s.recordLoaded && !s.busy;
    $('load').classList.toggle('needs-record', empty);
  }
}
