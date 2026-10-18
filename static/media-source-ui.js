import { DialogMotion } from './dialog-motion.js';
import { motionDuration, MOTION_EASING, setAnimatedText } from './ui-motion.js';

/** Local selection delegates to the existing file input; this layer owns presentation only. */
const $ = id => document.getElementById(id);
const YOUTUBE = /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;
const PASTE_KEYS = /Mac|iP(?:hone|ad|od)/.test(navigator.userAgentData?.platform ?? navigator.platform) ? '⌘V' : 'Ctrl+V';
// A pasted link is a single YouTube URL; anything else pastes normally.
const pastedLink = event => {
  const text = event.clipboardData?.getData('text/plain').trim() ?? '';
  return YOUTUBE.test(text) && !/\s/.test(text) ? text : null;
};
const editable = node => node instanceof Element && (node.isContentEditable
  || node.matches('textarea, input:not([type=range], [type=checkbox], [type=radio], [type=button], [type=submit], [type=file], [type=color])'));

/** Links that played, newest first, kept only in this browser. */
const RECENT_KEY = 'vhs-recent-links', RECENT_MAX = 6;
const recentLinks = {
  read() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY));
      return Array.isArray(list) ? list.filter(item => item && typeof item.url === 'string' && typeof item.title === 'string').slice(0, RECENT_MAX) : [];
    } catch { return []; }
  },
  write(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ } },
};
const clock = seconds => seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '';

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
    $('youtube-url').addEventListener('input', () => { if (!this.request) this.status(''); this.label(); });
    // Pasting a YouTube link puts it on at once: in the field, or anywhere on the page.
    document.addEventListener('paste', event => this.pasted(event));
    // Closing the chooser abandons a download; it never touches the seated record. A close
    // event queued before a quick reopen leaves the reopened chooser alone.
    this.dialog.addEventListener('close', () => { if (this.dialog.open) return; this.cancelLink(); this.hideLink(); });
    this.unsubscribe = controls.subscribe(state => this.render(state));
    $('recent-list').addEventListener('click', event => this.recentClicked(event));
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
    $('youtube-availability').textContent = `Paste a link · or press ${PASTE_KEYS} anywhere`;
    this.renderRecent();
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
    this.form.classList.toggle('busy', active);
    this.label();
  }

  /** An empty field offers to paste from the clipboard; a filled one puts the link on. */
  label() {
    const text = this.request ? 'Fetching…' : $('youtube-url').value.trim() ? 'Put it on' : 'Paste';
    setAnimatedText($('youtube-submit'), text);
  }

  async pasteLink() {
    const input = $('youtube-url');
    let text;
    try { text = (await navigator.clipboard.readText()).trim(); }
    catch { text = null; }
    // The chooser may have closed, or the field filled, while the browser asked for the clipboard.
    if (this.request || this.form.hidden || this.dialog.dataset.motion !== 'open' || input.value.trim()) return;
    input.focus({ preventScroll: true });
    if (text === null) { this.status(`Press ${PASTE_KEYS} to paste your link.`); return; }
    if (!YOUTUBE.test(text) || /\s/.test(text)) { this.status('Copy a YouTube video’s link first, then press Paste.', true); return; }
    this.put(text);
  }

  put(url) {
    $('youtube-url').value = url;
    this.label();
    void this.fetchLink();
  }

  pasted(event) {
    const url = $('youtube-url'), link = pastedLink(event);
    if (!link || event.defaultPrevented || $('source-youtube').disabled) return;
    // Other text fields and open panels keep their own paste.
    if (event.target !== url && (editable(event.target) || document.querySelector('dialog[open]:not(#media-source)'))) return;
    // A closing chooser has already abandoned its download; an open one keeps it.
    if (this.dialog.dataset.motion !== 'open') { this.cancelLink(); this.open(); }
    else if (this.request) return;
    event.preventDefault();
    this.showLink();
    this.put(link);
  }

  cancelLink() {
    this.request?.abort();
    this.request = null;
    this.busy(false);
  }

  async fetchLink() {
    if (this.request) return;
    const url = $('youtube-url').value.trim();
    if (!url) { void this.pasteLink(); return; }
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
      const video = decodeURIComponent(response.headers.get('X-Record-Id') || ''), seconds = Number(response.headers.get('X-Record-Duration')) || 0;
      const ext = response.headers.get('Content-Type')?.includes('webm') ? 'webm' : 'm4a';
      const blob = await response.blob();
      // Closing starts before the dialog's 'close' event: a download that lands then is dropped.
      if (request !== this.request || this.dialog.dataset.motion !== 'open') return;
      // A fixed timestamp lets tempo analysis recognize the same video again.
      const file = new File([blob], `${title}.${ext}`, { type: blob.type, lastModified: 0 });
      this.request = null;
      $('youtube-url').value = '';
      this.busy(false);
      this.remember({ id: video, url: /^[\w-]{6,}$/.test(video) ? `https://www.youtube.com/watch?v=${video}` : url, title, duration: seconds });
      this.close();
      void this.controls.load(file);
    } catch (error) {
      if (request !== this.request) return;
      this.request = null;
      this.busy(false);
      if (error.name !== 'AbortError') this.status(error instanceof TypeError ? 'The local studio server isn’t answering.' : error.message, true);
    }
  }

  /** A played link moves to the top; the same video under another link replaces its entry. */
  remember(entry) {
    const list = recentLinks.read().filter(item => (entry.id ? item.id !== entry.id : true) && item.url !== entry.url);
    recentLinks.write([entry, ...list].slice(0, RECENT_MAX));
    this.renderRecent();
  }

  renderRecent() {
    const list = $('source-youtube').disabled ? [] : recentLinks.read(), node = $('recent-list');
    $('recent-links').hidden = !list.length;
    node.replaceChildren(...list.map((item, index) => {
      const row = document.createElement('li'), play = document.createElement('button'), forget = document.createElement('button');
      const name = document.createElement('span'), length = document.createElement('small');
      play.type = forget.type = 'button'; play.className = 'recent-play'; forget.className = 'recent-forget';
      play.dataset.index = forget.dataset.index = String(index);
      play.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5 10.5 6 3 10.5Z"/></svg>';
      // Titles come from YouTube: text only, never markup.
      name.className = 'recent-name'; name.textContent = play.title = item.title; length.textContent = clock(item.duration);
      play.append(name, length);
      play.setAttribute('aria-label', `Put on ${item.title}${length.textContent ? `, ${length.textContent}` : ''}`);
      forget.textContent = '×'; forget.setAttribute('aria-label', `Forget ${item.title}`);
      row.append(play, forget);
      return row;
    }));
  }

  recentClicked(event) {
    const button = event.target.closest('button'), item = button && recentLinks.read()[Number(button.dataset.index)];
    if (!item) return;
    if (button.classList.contains('recent-forget')) {
      recentLinks.write(recentLinks.read().filter(other => other.url !== item.url));
      const index = Number(button.dataset.index);
      this.renderRecent();
      // Keep focus in the list (the next entry, or the one before), else on the YouTube option.
      const rows = $('recent-list').querySelectorAll('.recent-forget');
      (rows[Math.min(index, rows.length - 1)] ?? $('source-youtube')).focus({ preventScroll: true });
      return;
    }
    // Another recent link replaces a download still in progress.
    this.cancelLink();
    this.showLink();
    this.put(item.url);
  }

  render(s) {
    const empty = !s.recordLoaded && !s.busy;
    $('load').classList.toggle('needs-record', empty);
    // A record chosen another way (such as a drop) after the download began supersedes it.
    if (this.request && s.recordPhase === 'loading' && this.phase !== 'loading') { this.cancelLink(); this.status('Another record was chosen instead.'); }
    this.phase = s.recordPhase;
  }
}
