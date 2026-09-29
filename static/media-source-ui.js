/** Local selection delegates to the existing file input; this layer owns presentation only. */
const $ = id => document.getElementById(id);

export class MediaSourceUI {
  constructor(controls) {
    this.dialog = $('media-source');
    $('load').addEventListener('click', () => this.open());
    $('media-source-close').addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('click', event => {
      if (event.target !== this.dialog) return;
      const rect = this.dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close();
    });
    $('source-local').addEventListener('click', () => {
      // Keep the native picker in the trusted Local file activation stack.
      this.close();
      $('file-input').click();
    });
    this.unsubscribe = controls.subscribe(state => this.render(state));
  }

  open() {
    this.dialog.showModal();
    $('source-local').focus({ preventScroll: true });
  }

  close() {
    this.dialog.close();
    $('load').focus({ preventScroll: true });
  }

  render(s) {
    const empty = !s.recordLoaded && !s.busy;
    $('load').classList.toggle('needs-record', empty);
  }
}
