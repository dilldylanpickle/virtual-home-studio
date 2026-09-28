import { CONDITIONS, CONDITION_DESCRIPTIONS } from './condition-profiles.js';

const $ = id => document.getElementById(id);
export const VINYL = Object.freeze({
  Black: ['#0b0c0d', '#25282a', 1], Clear: ['#cadbd3', '#f4fbf8', .22],
  Smoke: ['#46504c', '#929c96', .62], White: ['#c5c8c1', '#f1f0e8', 1],
  Red: ['#650f1d', '#b73448', 1], Orange: ['#983a16', '#e39343', 1],
  Amber: ['#714614', '#ca963f', 1], Yellow: ['#8c7619', '#d8c763', 1],
  Lime: ['#53601f', '#a0b954', 1], Green: ['#124637', '#519977', 1],
  Teal: ['#174a4b', '#4b9891', 1], Cyan: ['#1c566d', '#68b1c4', 1],
  Blue: ['#112f5c', '#467eaa', 1], Navy: ['#101e37', '#374e74', 1],
  Purple: ['#3b204e', '#8a589e', 1], Violet: ['#3d2b70', '#8e7ac1', 1],
  Pink: ['#784154', '#d495b2', 1], Rose: ['#6d2d3d', '#b97482', 1],
});
export const LABELS = Object.freeze({
  Cream: '#e7dec5', White: '#eeeee7', Charcoal: '#49504f', Black: '#202824',
  Red: '#a94249', Burgundy: '#733548', Orange: '#db974f', Amber: '#c29550',
  Yellow: '#e3cb70', Olive: '#8a925d', Green: '#699578', Teal: '#6a948b',
  Cyan: '#87bbc5', Blue: '#829aad', Navy: '#3c526e', Purple: '#8b699c',
  Violet: '#9e90ba', Pink: '#d5a1af', Rose: '#b87b88',
});
const wowDescription = value => value === 0 ? 'Off' : value <= .35 ? 'Subtle' : value <= .7 ? 'Moderate' : 'Noticeable';
const centeringDescription = value => value === 0 ? 'Perfect' : value <= .35 ? 'Slightly off-center' : value <= .7 ? 'Moderately off-center' : 'Off-center';
export function contrastColor(hex) {
  const linear = hex.match(/[a-f\d]{2}/gi).map(x => {
    const c = parseInt(x, 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  const light = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  return (light + .05) / .05 >= 1.05 / (light + .05) ? '#000000' : '#ffffff';
}
export function setupCustomization(change) {
  for (const [id, values, key] of [['vinyl-swatches', VINYL, 'vinylColor'], ['label-swatches', LABELS, 'labelColor']]) {
    for (const [name, color] of Object.entries(values)) {
      const button = document.createElement('button');
      button.className = 'swatch'; button.type = 'button'; button.dataset.name = name;
      button.setAttribute('aria-label', `${id === 'vinyl-swatches' ? 'Vinyl' : 'Label'}: ${name}`);
      button.setAttribute('aria-pressed', 'false'); button.title = name;
      button.style.setProperty('--swatch', Array.isArray(color) ? color[1] : color);
      if (name === 'Clear') button.classList.add('clear-swatch');
      button.addEventListener('click', () => change(key, name));
      $(id).append(button);
    }
  }
  for (const name of Object.keys(CONDITIONS)) {
    const label = document.createElement('label');
    label.className = 'condition-option';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'record-condition'; input.value = name;
    input.addEventListener('change', () => { if (input.checked) change('condition', name); });
    const text = document.createElement('span'); text.textContent = name;
    label.append(input, text); $('condition').append(label);
  }
  for (const key of ['wow', 'centering']) $(key).addEventListener('input', e => change(key, Number(e.target.value)));
  $('customize-open').addEventListener('click', () => $('customize').showModal());
  $('customize-close').addEventListener('click', () => $('customize').close());
  $('customize').addEventListener('click', event => {
    if (event.target !== $('customize')) return;
    const r = $('customize').getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('customize').close();
  });
  // Small deterministic hairlines rotate with the record; no random regeneration on render.
  const marks = document.createDocumentFragment();
  for (let i = 0; i < 24; i++) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const a = i * 2.39996, r = 158 + (i * 53 % 160), span = 5 + i % 9;
    const x = 498 + Math.cos(a) * r, y = 598 + Math.sin(a) * r;
    path.setAttribute('d', `M${x} ${y}l${Math.cos(a + .6) * span} ${Math.sin(a + .6) * span}`);
    path.setAttribute('stroke-width', '.45'); marks.append(path);
  }
  $('record-wear').append(marks);
}
let previousMaterial = '';
export function renderMaterial(state) {
  for (const input of $('condition').querySelectorAll('input')) input.checked = input.value === state.condition;
  for (const key of ['wow', 'centering']) if ($(key).value !== String(state[key])) $(key).value = state[key];
  const key = [state.vinylColor, state.labelColor, state.condition].join('|');
  if (key !== previousMaterial) {
    previousMaterial = key;
    const [base, highlight, opacity] = VINYL[state.vinylColor];
    $('vinyl').querySelectorAll('stop').forEach((node, i) => node.setAttribute('stop-color', i % 2 ? highlight : base));
    $('vinyl-body').setAttribute('opacity', opacity);
    $('grooves').setAttribute('stroke', ['White', 'Clear'].includes(state.vinylColor) ? '#17221b' : '#bac8be');
    $('record-label').style.setProperty('--label-color', LABELS[state.labelColor]);
    $('record-label').style.setProperty('--label-ink', contrastColor(LABELS[state.labelColor]));
    for (const id of ['mini-record', 'customize-preview']) {
      $(id).style.setProperty('--record-color', base);
      $(id).style.setProperty('--label-color', LABELS[state.labelColor]);
    }
    $('record-wear').setAttribute('opacity', CONDITIONS[state.condition].visualWear);
    const description = CONDITION_DESCRIPTIONS[state.condition];
    if ($('condition-help').textContent !== description) $('condition-help').textContent = description;
    for (const [id, selected] of [['vinyl-swatches', state.vinylColor], ['label-swatches', state.labelColor]]) {
      $(id).querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', button.dataset.name === selected));
    }
    $('vinyl-selection').textContent = state.vinylColor;
    $('label-selection').textContent = state.labelColor;
  }
  const wow = wowDescription(state.wow), centering = centeringDescription(state.centering);
  $('wow-value').textContent = wow; $('wow').setAttribute('aria-valuetext', wow);
  $('centering-value').textContent = centering; $('centering').setAttribute('aria-valuetext', centering);
}
