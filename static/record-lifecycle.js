/** Latest request wins; physical operations serialize through one shared removal. */
export class RecordLifecycle {
  constructor(deck, view) {
    this.deck = deck; this.view = view; this.generation = 0;
    this.insertion = null; this.removal = null;
  }
  get busy() { return !['empty', 'ready'].includes(this.deck.state.recordPhase); }
  phase(value) {
    this.deck.state.recordPhase = value;
    this.deck.state.loading = value === 'loading' || value === 'inserting';
    this.deck.emit();
  }
  async remove() {
    if (this.removal) return this.removal;
    this.removal = (async () => {
      if (this.insertion) await this.insertion;
      if (this.deck.parking) await this.deck.parking;
      if (!this.deck.state.recordPresent) return;
      this.phase('ejecting');
      await this.view.park();
      await this.view.motion('eject');
      this.deck.engine?.port.postMessage({ type: 'clear' });
      this.deck.change((s) => {
        s.recordLoaded = false; s.recordPresent = false; s.filename = ''; s.pendingFilename = ''; s.duration = 0; s.position = 0;
        s.grooveRegion = 'music'; s.runInRemaining = 0;
      }, true);
    })();
    try { await this.removal; } finally { this.removal = null; }
  }
  async eject() {
    if (this.removal && this.deck.state.recordPhase === 'ejecting') return this.removal;
    const version = ++this.generation;
    // This also invalidates a decoder even when the platter is still empty.
    await this.remove();
    if (version !== this.generation) return;
    this.phase('empty');
    this.view.notice('Record removed. Choose another pressing whenever you’re ready.');
  }
  async load(file) {
    if (!file) return;
    if (!/\.(mp3|wav)$/i.test(file.name)) { this.view.notice('Please choose an MP3 or WAV audio file.', true); return; }
    const version = ++this.generation;
    // Finish any physical move already in flight before changing its phase.
    if (this.removal) await this.removal;
    if (this.insertion) await this.insertion;
    if (version !== this.generation) return;
    this.phase('loading');
    this.view.notice(`Cutting your record · decoding ${file.name}…`);
    try {
      await this.view.park();
      if (version !== this.generation) return;
      const ctx = this.deck.audioContext();
      const data = await file.arrayBuffer();
      if (version !== this.generation) return;
      const [decoded] = await Promise.all([ctx.decodeAudioData(data), this.deck.initializeEngine()]);
      if (version !== this.generation) return;
      if (!decoded.length || !Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('This file contains no playable audio.');
      await this.remove();
      if (version !== this.generation) return;
      await this.view.park();
      if (version !== this.generation) return;
      this.view.grooves(decoded);
      const channels = [];
      for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) channels.push(decoded.getChannelData(c).slice());
      this.deck.engine.port.postMessage({ type: 'load', channels, sampleRate: decoded.sampleRate }, channels.map(pcm => pcm.buffer));
      this.deck.change((s) => {
        s.recordPresent = true; s.recordLoaded = false; s.recordPhase = 'inserting'; s.loading = true;
        s.pendingFilename = file.name; s.position = 0;
        s.stylusRaised = true; s.tonearmAngle = this.view.rest; s.dragging = false; s.scratching = false;
      }, true);
      // The seated record owns its metadata. Newer requests wait for this
      // complete physical move, then may remove it; a failed replacement must
      // still leave this pressing usable, even if it was selected mid-insertion.
      this.insertion = (async () => {
        await this.view.motion('insert');
        this.deck.change(s => {
          s.recordLoaded = true; s.recordPhase = 'ready'; s.loading = false;
          s.filename = file.name; s.pendingFilename = ''; s.duration = decoded.duration;
        });
      })();
      try { await this.insertion; } finally { this.insertion = null; }
      if (version !== this.generation) return;
      this.view.notice('Your record is ready. Press Play.');
    } catch (error) {
      if (version !== this.generation) return;
      this.deck.state.pendingFilename = '';
      this.deck.state.recordLoaded = this.deck.state.recordPresent;
      this.phase(this.deck.state.recordPresent ? 'ready' : 'empty');
      this.view.notice(`Could not load this record. Try another MP3 or WAV. ${error.message}`, true);
    }
  }
}
