import { ProgressControl } from './progress-control.js';
import { playbackEnded } from './simulation-state.js';
/** A replaceable presentation layer: every action delegates to the turntable. */
const $ = id => document.getElementById(id);
export class ListeningHUD {
  constructor(controls, formatTime) {
    this.controls = controls;
    this.formatTime = formatTime;
    this.unsubscribe = controls.subscribe(state => this.render(state));
    $('transport').addEventListener('click', () => {
      const s = controls.getState();
      if (s.assistPhase !== 'idle' || (!playbackEnded(s) && !s.transportPaused && s.platterRunning && s.stylusContact)) controls.pause();
      else controls.play();
    });
    this.progress = new ProgressControl($('groove-progress'), controls, formatTime);
    $('volume').addEventListener('input', e => controls.setVolume(Number(e.target.value)));
  }
  render(s) {
    this.progress?.sync(s);
    const starting = s.assistPhase !== 'idle';
    const ended = playbackEnded(s);
    const playing = !ended && !s.transportPaused && s.platterRunning && s.stylusContact;
    const button = $('transport');
    button.disabled = s.busy || !s.recordLoaded;
    button.setAttribute('aria-label', starting ? 'Cancel startup and pause' : playing ? 'Pause playback' : ended ? 'Play again' : s.transportPaused ? 'Resume playback' : 'Play record');
    button.dataset.action = starting || playing ? 'pause' : 'play';
    $('transport-label').textContent = starting ? 'Starting…' : playing ? 'Pause' : ended ? 'Play again' : 'Play';
    $('transport-hint').textContent = s.busy ? 'Handling record' : !s.recordLoaded ? ''
      : starting ? 'Cueing your record · click to pause' : s.directScrubbing ? '' : s.seeking ? 'Traversing grooves' : ended ? 'Ready for another listen'
      : s.transportPaused ? 'Paused' : s.grooveRegion === 'run-in' && s.stylusContact ? 'Finding the first groove' : '';
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
