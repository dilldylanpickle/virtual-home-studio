import { PLAYBACK_PRESETS, selectedPreset } from './playback-presets.js';
import { ProgressControl } from './progress-control.js';
import { playbackEnded } from './simulation-state.js';
import { PopupMotion, setAnimatedText } from './ui-motion.js';
/** A replaceable presentation layer: every action delegates to the turntable. */
const $ = id => document.getElementById(id);
export class ListeningHUD {
  constructor(controls, formatTime) {
    this.controls = controls;
    this.formatTime = formatTime;
    const chooser = $('playback-presets'), toggle = $('preset-toggle'), options = $('preset-options');
    const close = (restoreFocus = false) => {
      popup.close();
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus({ preventScroll: true });
    };
    this.closePresets = close;
    const placeOptions = () => {
      if (options.hidden) return;
      const rect = toggle.getBoundingClientRect();
      const above = rect.top - 16, below = innerHeight - rect.bottom - 16;
      const openAbove = above >= Math.min(options.scrollHeight, 420) || above >= below;
      options.dataset.placement = openAbove ? 'above' : 'below';
      options.style.bottom = openAbove ? 'calc(100% + 8px)' : 'auto';
      options.style.top = openAbove ? 'auto' : 'calc(100% + 8px)';
      options.style.maxHeight = `${Math.max(80, Math.min(420, openAbove ? above : below))}px`;
    };
    const popup = new PopupMotion(options, placeOptions);
    const open = () => {
      toggle.setAttribute('aria-expanded', 'true');
      popup.open();
    };
    for (const preset of PLAYBACK_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.preset = preset.id;
      button.setAttribute('aria-pressed', 'false');
      const name = document.createElement('span'), settings = document.createElement('small');
      name.textContent = preset.name;
      settings.textContent = `${preset.rpm === 100 / 3 ? '33⅓' : preset.rpm} RPM · ${preset.pitch > 0 ? '+' : preset.pitch < 0 ? '−' : ''}${Math.abs(preset.pitch)}%`;
      button.append(name, settings);
      button.addEventListener('click', () => { controls.applyPreset(preset.id); close(true); });
      options.append(button);
    }
    toggle.addEventListener('click', () => {
      if (popup.expanded) close(); else open();
    });
    chooser.addEventListener('keydown', event => {
      if (event.key === 'Escape' && popup.expanded) { event.preventDefault(); event.stopPropagation(); close(true); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); open();
        const buttons = [...options.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : index < 0 ? (event.key === 'ArrowUp' ? buttons.length - 1 : 0)
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next].focus({ preventScroll: true });
        buttons[next].scrollIntoView({ block: 'nearest' });
      }
    });
    document.addEventListener('pointerdown', event => { if (!chooser.contains(event.target)) close(); });
    chooser.addEventListener('focusout', event => { if (!chooser.contains(event.relatedTarget)) close(); });
    window.addEventListener('blur', () => close());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { close(); popup.close({ immediate: true }); }
    });
    window.addEventListener('resize', placeOptions);
    window.addEventListener('scroll', placeOptions);
    this.unsubscribe = controls.subscribe(state => this.render(state));
    $('transport').addEventListener('click', () => {
      const s = controls.getState();
      if (s.assistPhase !== 'idle' || (!playbackEnded(s) && !s.transportPaused && s.platterRunning && s.stylusContact)) controls.pause();
      else controls.play();
    });
    $('replay-toggle').addEventListener('click', () => controls.setReplayEnabled(!controls.getState().replayEnabled));
    this.progress = new ProgressControl($('groove-progress'), controls, formatTime);
    $('volume').addEventListener('input', e => controls.setVolume(Number(e.target.value)));
  }
  render(s) {
    this.progress?.sync(s);
    const preset = selectedPreset(s);
    setAnimatedText($('preset-name'), s.presetMotion ? `Applying ${s.presetMotion.name}…` : preset?.name ?? (s.rpm === null ? 'Choose a preset' : 'Custom'));
    $('preset-toggle').disabled = s.busy;
    if (s.busy) this.closePresets();
    for (const button of $('preset-options').children) {
      button.disabled = s.busy;
      button.setAttribute('aria-pressed', String(button.dataset.preset === (s.presetMotion?.id ?? preset?.id)));
    }

    const starting = s.assistPhase !== 'idle';
    const ended = playbackEnded(s);
    const playing = !ended && !s.transportPaused && s.platterRunning && s.stylusContact;
    const replay = $('replay-toggle');
    replay.disabled = s.busy || !s.recordLoaded;
    replay.setAttribute('aria-pressed', String(s.replayEnabled));
    replay.dataset.tooltip = replay.title = s.replayEnabled ? 'Repeat on' : 'Repeat off';
    const button = $('transport');
    button.disabled = s.busy || !s.recordLoaded;
    button.setAttribute('aria-label', starting ? 'Cancel startup and pause' : playing ? 'Pause playback' : ended ? 'Play again' : s.transportPaused ? 'Resume playback' : 'Play record');
    button.dataset.action = starting || playing ? 'pause' : 'play';
    setAnimatedText($('transport-label'), starting ? 'Starting…' : playing ? 'Pause' : ended ? 'Play again' : 'Play');
    setAnimatedText($('transport-hint'), s.busy ? 'Handling record' : !s.recordLoaded ? ''
      : starting ? 'Cueing your record · click to pause' : s.directScrubbing ? '' : s.seeking ? 'Traversing grooves' : ended ? 'Ready for another listen'
      : s.transportPaused ? '' : s.grooveRegion === 'run-in' && s.stylusContact ? 'Finding the first groove' : '');
    const progress = $('groove-progress');
    progress.disabled = s.busy || !s.recordLoaded;
    // During drag this state is the pointer anchor; click seeks follow the audio cursor.
    progress.value = s.grooveProgress * 100;
    progress.dataset.seeking = String(s.seeking);
    progress.dataset.scrubbing = String(s.directScrubbing);
    progress.style.setProperty('--progress', `${s.grooveProgress * 100}%`);
    progress.setAttribute('aria-valuetext', `${this.formatTime(s.position)} of ${this.formatTime(s.duration)}`);
    const volume = $('volume');
    if (Number(volume.value) !== s.volume) volume.value = s.volume;
    volume.setAttribute('aria-valuetext', `${Math.round(s.volume * 100)} percent`);
    $('volume-value').textContent = `${Math.round(s.volume * 100)}%`;
    $('listening-hud').dataset.transport = s.transportState;
    $('physical-rpm').textContent = `Actual: ${s.actualRPM.toFixed(1)} RPM · ${s.motorState}`;
    $('physical-rpm').title = `Actual platter speed · ${s.motorState}`;
  }
  rotate(angle) { $('mini-record').style.transform = `rotate(${angle % 360}deg)`; }
}
