/** Ship Lab — standalone dev tool for designing procedural ship silhouettes. Not part of gameplay. */

import { Vec2 } from '../math.js';
import { Camera } from '../camera.js';
import {
  DEFAULT_PARAMS, PARAM_RANGES, drawProceduralShip, invalidateShipGeometryCache,
  mutateParams, randomizeParams, hashStringToSeed,
} from '../proceduralShips.js';
import type { ProceduralShipDefinition, ProceduralShipParams, ShipDebugOverlay } from '../proceduralShips.js';
import { SHIP_PRESETS } from '../proceduralShipPresets.js';

const canvas = document.getElementById('ship-lab-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const panel = document.getElementById('panel')!;
const camera = new Camera();

let current: ProceduralShipDefinition = { seed: SHIP_PRESETS[0].def.seed, params: { ...SHIP_PRESETS[0].def.params } };
let history: ProceduralShipParams[] = [];
const debug: ShipDebugOverlay = {};

const PARAM_ORDER: (keyof ProceduralShipParams)[] = [
  'length', 'maxWidth', 'noseSharpness', 'tailWidth', 'widestPoint', 'edgeCurve',
  'edgeWaveAmplitude', 'edgeWaveFrequency', 'edgeWavePhase',
  'ribCount', 'ribCurvature', 'ribInset', 'spineThickness',
  'corePosition', 'coreSize', 'innerStructureDensity', 'asymmetry',
  'lineThickness', 'glowAmount', 'hullFillOpacity', 'interiorLineOpacity',
];

function step(key: keyof ProceduralShipParams): number {
  const [lo, hi] = PARAM_RANGES[key];
  return (hi - lo) / 400;
}

function invalidate(): void {
  invalidateShipGeometryCache();
}

function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  camera.setScreenSize(canvas.width, canvas.height);
}
window.addEventListener('resize', resizeCanvas);

function render(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  camera.zoom = 2.5;
  drawProceduralShip(ctx, camera, current, { position: new Vec2(0, 0), rotation: -Math.PI / 2 }, debug);
  requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------
// Panel building
// ---------------------------------------------------------------------------

function buildPanel(): void {
  panel.innerHTML = '';

  addSection('Seed');
  const seedRow = document.createElement('div');
  seedRow.className = 'row';
  const seedInput = document.createElement('input');
  seedInput.type = 'text';
  seedInput.value = String(current.seed);
  seedInput.style.flex = '1';
  seedInput.addEventListener('change', () => {
    const n = Number(seedInput.value);
    current.seed = Number.isFinite(n) ? n >>> 0 : hashStringToSeed(seedInput.value);
    invalidate();
  });
  seedRow.appendChild(seedInput);
  panel.appendChild(seedRow);

  const seedBtns = document.createElement('div');
  seedBtns.className = 'btnrow';
  seedBtns.appendChild(makeButton('PREVIOUS SEED', () => { current.seed = (current.seed - 1) >>> 0; invalidate(); refreshSeedField(); }));
  seedBtns.appendChild(makeButton('NEXT SEED', () => { current.seed = (current.seed + 1) >>> 0; invalidate(); refreshSeedField(); }));
  seedBtns.appendChild(makeButton('RANDOM SEED', () => { current.seed = Math.floor(Math.random() * 0xffffffff) >>> 0; invalidate(); refreshSeedField(); }));
  panel.appendChild(seedBtns);

  addSection('Actions');
  const actionBtns = document.createElement('div');
  actionBtns.className = 'btnrow';
  actionBtns.appendChild(makeButton('RANDOMIZE DESIGN', () => {
    pushHistory();
    current.params = randomizeParams(Math.floor(Math.random() * 0xffffffff));
    invalidate();
    buildPanel();
  }));
  actionBtns.appendChild(makeButton('UNDO MUTATION', () => {
    const prev = history.pop();
    if (prev) { current.params = prev; invalidate(); buildPanel(); }
  }));
  panel.appendChild(actionBtns);

  const mutRow = document.createElement('div');
  mutRow.className = 'row';
  mutRow.innerHTML = `<label>Mutation Strength</label>`;
  const mutSlider = document.createElement('input');
  mutSlider.type = 'range'; mutSlider.min = '0'; mutSlider.max = '1'; mutSlider.step = '0.01'; mutSlider.value = '0.2';
  const mutVal = document.createElement('span'); mutVal.className = 'val'; mutVal.textContent = '0.20';
  mutSlider.addEventListener('input', () => { mutVal.textContent = Number(mutSlider.value).toFixed(2); });
  mutRow.appendChild(mutSlider); mutRow.appendChild(mutVal);
  panel.appendChild(mutRow);
  const mutBtnRow = document.createElement('div');
  mutBtnRow.appendChild(makeButton('MUTATE', () => {
    pushHistory();
    const strength = Number(mutSlider.value);
    current.params = mutateParams(current.params, strength, Math.floor(Math.random() * 0xffffffff));
    invalidate();
    buildPanel();
  }));
  panel.appendChild(mutBtnRow);

  addSection('Design I/O');
  const io = document.createElement('div');
  io.className = 'btnrow';
  io.appendChild(makeButton('COPY DESIGN', () => {
    const json = JSON.stringify(current, null, 2);
    ioBox.value = json;
    navigator.clipboard?.writeText(json).catch(() => {});
  }));
  io.appendChild(makeButton('LOAD DESIGN', () => {
    try {
      const parsed = JSON.parse(ioBox.value);
      if (parsed && parsed.params) {
        pushHistory();
        current = { seed: parsed.seed >>> 0, params: { ...DEFAULT_PARAMS, ...parsed.params } };
        invalidate();
        buildPanel();
      }
    } catch (e) { alert('Invalid JSON: ' + e); }
  }));
  panel.appendChild(io);
  const ioBox = document.createElement('textarea');
  ioBox.placeholder = 'Paste {seed, params} JSON here to load, or COPY DESIGN to fill this in.';
  panel.appendChild(ioBox);

  const presetIo = document.createElement('div');
  presetIo.className = 'row';
  const presetName = document.createElement('input');
  presetName.type = 'text'; presetName.placeholder = 'preset name';
  presetIo.appendChild(presetName);
  presetIo.appendChild(makeButton('SAVE PRESET', () => savePreset(presetName.value || 'preset')));
  panel.appendChild(presetIo);

  addSection('Presets');
  const presetList = document.createElement('div');
  presetList.id = 'presetList';
  for (const preset of SHIP_PRESETS) {
    presetList.appendChild(makePresetRow(preset.name, preset.def));
  }
  for (const saved of loadSavedPresets()) {
    presetList.appendChild(makePresetRow('★ ' + saved.name, saved.def));
  }
  panel.appendChild(presetList);

  addSection('Debug Overlays');
  panel.appendChild(makeToggle('Show hull samples', 'showHullSamples'));
  panel.appendChild(makeToggle('Show center spine', 'showSpine'));
  panel.appendChild(makeToggle('Show control points', 'showControlPoints'));
  panel.appendChild(makeToggle('Show bounding box', 'showBoundingBox'));
  panel.appendChild(makeToggle('Show symmetry axis', 'showSymmetryAxis'));

  addSection('Params');
  for (const key of PARAM_ORDER) {
    panel.appendChild(makeSlider(key));
  }
}

function refreshSeedField(): void {
  const input = panel.querySelector('input[type=text]') as HTMLInputElement | null;
  if (input) input.value = String(current.seed);
}

function pushHistory(): void {
  history.push({ ...current.params });
  if (history.length > 20) history.shift();
}

function addSection(title: string): void {
  const h = document.createElement('h2');
  h.textContent = title;
  panel.appendChild(h);
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function makeToggle(label: string, key: keyof ShipDebugOverlay): HTMLElement {
  const row = document.createElement('div');
  row.className = 'toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!debug[key];
  cb.addEventListener('change', () => { debug[key] = cb.checked; });
  const lbl = document.createElement('label');
  lbl.textContent = label;
  row.appendChild(cb);
  row.appendChild(lbl);
  return row;
}

function makeSlider(key: keyof ProceduralShipParams): HTMLElement {
  const [lo, hi] = PARAM_RANGES[key];
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = key;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(lo);
  input.max = String(hi);
  input.step = String(step(key));
  input.value = String(current.params[key]);
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = current.params[key].toFixed(3);
  input.addEventListener('input', () => {
    current.params = { ...current.params, [key]: Number(input.value) };
    val.textContent = Number(input.value).toFixed(3);
    invalidate();
  });
  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(val);
  return row;
}

function makePresetRow(name: string, def: ProceduralShipDefinition): HTMLElement {
  const row = document.createElement('div');
  row.textContent = name;
  row.addEventListener('click', () => {
    pushHistory();
    current = { seed: def.seed, params: { ...def.params } };
    invalidate();
    buildPanel();
  });
  return row;
}

// ---------------------------------------------------------------------------
// LocalStorage presets
// ---------------------------------------------------------------------------

const PRESET_STORAGE_KEY = 'sign99_shiplab_presets';

function loadSavedPresets(): { name: string; def: ProceduralShipDefinition }[] {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePreset(name: string): void {
  const saved = loadSavedPresets();
  saved.push({ name, def: { seed: current.seed, params: { ...current.params } } });
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(saved.slice(-30)));
  } catch { /* storage unavailable — ignore */ }
  buildPanel();
}

resizeCanvas();
buildPanel();
render();
