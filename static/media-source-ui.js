import { DialogMotion } from './dialog-motion.js';
import { motionDuration, MOTION_EASING } from './ui-motion.js';

/** Local selection delegates to the existing file input; this layer owns presentation only. */
const $ = id => document.getElementById(id);
const YOUTUBE = /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;

export class MediaSourceUI {
  constructor(controls) {
    this.controls = controls;
    this.dialog = $('media-source');
    this.form = $('youtube-form');
    this.request = null;
    this.phase = null;
    this.motion = new DialogMotion(this.dialog, { initialFocus: $('source-local'), returnFocus: $('load') });
    $('load').addEventListener('click', () => this.open());
    $('media-source-close').addEventListener('click', () => this.close());
    $('source-local').addEventListener('click', () => {
      // Keep the native picker in the trusted Local file activation stack.
      this.motion.close({ immediate: true });
      $('file-input').click();
    });
    $('source-youtube').addEventListener('click', () => this.showLink());
    this.form.addEventListener('submit', event => { event.preventDefault(); void this.fetchLink(); });
    $('youtube-url').addEventListener('input', () => { if (!this.request) this.status(''); });
    // Closing the chooser abandons a download; it never touches the seated record.
    this.dialog.addEventListener('close', () => { this.cancelLink(); this.hideLink(); });
    this.unsubscribe = controls.subscribe(state => this.render(state));
    void this.detectLinks();
  }

  /** Only the local server can fetch YouTube audio; static hosts (GitHub Pages) are never asked. */
  async detectLinks() {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return;
    try {
      const response = await fetch('./api/youtube', { cache: 'no-store' });
      if (!response.ok || !(await response.json()).available) return;
    } catch { return; }
    $('source-youtube').disabled = false;
    $('youtube-availability').textContent = 'Paste a link · the full turntable experience';
  }

  open() {
    this.motion.open();
  }

  close() {
    this.motion.close();
  }

  showLink() {
    const input = $('youtube-url');
    if (this.form.hidden) {
      this.form.hidden = false;
      $('source-youtube').setAttribute('aria-expanded', 'true');
      const duration = motionDuration('panel');
      if (duration) this.form.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration, easing: MOTION_EASING });
    }
    input.focus({ preventScroll: true });
  }

  hideLink() {
    this.form.hidden = true;
    $('source-youtube').setAttribute('aria-expanded', 'false');
    this.status('');
  }

  status(message, error = false) {
    const node = $('youtube-status');
    node.textContent = message;
    node.classList.toggle('error', error);
  }

  busy(active) {
    // Keep keyboard focus in the form when the focused button becomes disabled.
    if (active && document.activeElement === $('youtube-submit')) $('youtube-url').focus({ preventScroll: true });
    $('youtube-url').readOnly = active;
    $('youtube-submit').disabled = active;
    $('youtube-submit').textContent = active ? 'Fetching…' : 'Put it on';
    this.form.classList.toggle('busy', active);
  }

  cancelLink() {
    this.request?.abort();
    this.request = null;
    this.busy(false);
  }

  async fetchLink() {
    if (this.request) return;
    const url = $('youtube-url').value.trim();
    if (!YOUTUBE.test(url)) { this.status('Paste a link to a YouTube video, like youtube.com/watch?v=…', true); $('youtube-url').focus(); return; }
    const request = this.request = new AbortController();
    this.busy(true);
    this.status('Fetching the audio from YouTube… Closing cancels.');
    try {
      const response = await fetch('./api/youtube', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: request.signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})).then(body => body.detail);
        throw new Error(typeof detail === 'string' ? detail : 'The studio couldn’t fetch that video.');
      }
      const title = decodeURIComponent(response.headers.get('X-Record-Title') || 'YouTube record').replace(/[\\/]/g, '-');
      const ext = response.headers.get('Content-Type')?.includes('webm') ? 'webm' : 'm4a';
      const blob = await response.blob();
      // Closing starts before the dialog's 'close' event: a download that lands then is dropped.
      if (request !== this.request || this.dialog.dataset.motion !== 'open') return;
      // A fixed timestamp lets tempo analysis recognize the same video again.
      const file = new File([blob], `${title}.${ext}`, { type: blob.type, lastModified: 0 });
      this.request = null;
      this.busy(false);
      this.close();
      void this.controls.load(file);
    } catch (error) {
      if (request !== this.request) return;
      this.request = null;
      this.busy(false);
      if (error.name !== 'AbortError') this.status(error instanceof TypeError ? 'The local studio server isn’t answering.' : error.message, true);
    }
  }

  render(s) {
    const empty = !s.recordLoaded && !s.busy;
    $('load').classList.toggle('needs-record', empty);
    // A record chosen another way (such as a drop) after the download began supersedes it.
    if (this.request && s.recordPhase === 'loading' && this.phase !== 'loading') { this.cancelLink(); this.status('Another record was chosen instead.'); }
    this.phase = s.recordPhase;
  }
}
