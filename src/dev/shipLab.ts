import { ShipHullDamage, type HullImpact } from '../shipHullDamage.js';
import { fleetDesign, fleetFamilyName, type FleetRole } from '../shipFamilies.js';
import { shipDesignRadius } from '../proceduralShips.js';
/** Ship Lab — standalone dev tool for designing procedural ships. Not part of gameplay. */

import { Vec2 } from '../math.js';
import { Camera } from '../camera.js';
import {
  DEFAULT_PARAMS, PARAM_RANGES, drawProceduralShip, invalidateShipGeometryCache,
  mutateParams, randomizeParams, hashStringToSeed, getShipGeometry, lastFillCalls, MAX_POLYGONS,
  DEV_SHIP_DESIGN_KEY, DAMAGE_STAGES, damageStageForHealth,
} from '../proceduralShips.js';
import type { ProceduralShipDefinition, ProceduralShipParams, ShipDebugOverlay } from '../proceduralShips.js';
import { SHIP_PRESETS } from '../proceduralShipPresets.js';
import { ShipDebrisSystem } from '../shipDebris.js';
import { Team } from '../entities.js';
import { teamColor, teamLabel } from '../teamutils.js';
import type { Color } from '../colors.js';

const canvas = document.getElementById('ship-lab-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const panel = document.getElementById('panel')!;
const camera = new Camera();

let current: ProceduralShipDefinition = { seed: SHIP_PRESETS[0].def.seed, params: { ...SHIP_PRESETS[0].def.params } };
const history: ProceduralShipParams[] = [];
const debug: ShipDebugOverlay = {};

const TEAMS: Team[] = [Team.Player1, Team.Player2, Team.Player3, Team.Player4, Team.Player5, Team.Player6, Team.Player7, Team.Player8, Team.Neutral];
let teamIndex = 0;
let fleetRole: FleetRole = 'hero';
let overview = false;
let impactKind: HullImpact['kind'] = 'bullet';
let impactDamage = 8;
const previewHull = new ShipHullDamage(() => current, 1);
let customColor: Color | null = null;
let previewZoom = 2.5;
let showRtsScale = true;
/** Dev preview only: scrub the shed sequence without a real match. */
let previewHealth = 1;
const debris = new ShipDebrisSystem();
let lastFrameTime = performance.now();

function activeColor(): Color {
  return customColor ?? teamColor(TEAMS[teamIndex]);
}

const PARAM_ORDER: (keyof ProceduralShipParams)[] = [
  'length', 'spanToLength', 'tipSweep', 'tailNotch',
  'structureDepth', 'gasketBias',
  'budCount', 'budScale', 'budFalloff', 'budTwist', 'budDepth', 'budEmbed',
  'wingPairs', 'wingElements', 'wingStation', 'wingGroupGap', 'wingSweep', 'wingChord',
  'wingSpan', 'wingRake', 'wingDetail', 'wingBuds', 'wingSerration',
  'finCount', 'finLength', 'finSpread',
  'shadeBands', 'shadeDepthMix', 'hueSpread', 'accentHueShift', 'accentAmount', 'coreSize',
  'asymmetry', 'lineThickness', 'glowAmount',
];

const INTEGER_KEYS = new Set<keyof ProceduralShipParams>([
  'structureDepth', 'budCount', 'budDepth', 'wingPairs', 'wingElements', 'wingDetail',
  'wingBuds', 'finCount', 'shadeBands',
]);


/** Plain-language slider labels. The serialized param names never change, so designs
 *  saved before these labels existed still load. */
const PARAM_LABELS: Partial<Record<keyof ProceduralShipParams, string>> = {
  spanToLength: 'hull  Long \u2194 Wide',
  length: 'hull length',
  tipSweep: 'wingtip station',
  tailNotch: 'tail notch',
  structureDepth: 'gasket depth',
  gasketBias: 'gasket bias',
  budCount: 'bulbs per edge',
  budScale: 'bulb size',
  budFalloff: 'bulb falloff',
  budTwist: 'bulb spiral twist',
  budDepth: 'bulbs on bulbs',
  budEmbed: 'bulb embed',
  wingPairs: 'wing pairs (separate)',
  wingElements: 'elements per pair (merged)',
  wingStation: 'wing position',
  wingGroupGap: 'gap between pairs',
  wingSweep: 'wing sweep-back',
  wingChord: 'wing width (fore-aft)',
  wingSpan: 'wing span (outward)',
  wingRake: 'wing reach  aft \u2194 forward',
  wingDetail: 'wing gasket depth',
  wingBuds: 'wing edge bulbs',
  wingSerration: 'wing serrated edge',
  finCount: 'fins',
  finLength: 'fin length',
  finSpread: 'fin spread',
  shadeBands: 'shade bands',
  shadeDepthMix: 'shade  space \u2194 depth',
  hueSpread: 'hue drift',
  accentHueShift: 'accent hue',
  accentAmount: 'accent amount',
  coreSize: 'core size',
  asymmetry: 'asymmetry',
  lineThickness: 'rim line',
  glowAmount: 'rim glow',
};

function step(key: keyof ProceduralShipParams): number {
  if (INTEGER_KEYS.has(key)) return 1;
  const [lo, hi] = PARAM_RANGES[key];
  return (hi - lo) / 400;
}

function invalidate(): void {
  invalidateShipGeometryCache();
  previewHull.reset();
  previewHealth = 1;
}

function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
  camera.setScreenSize(canvas.width, canvas.height);
}
window.addEventListener('resize', resizeCanvas);

const statsEl = document.getElementById('stats')!;

function render(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const color = activeColor();

  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  debris.update(dt);

  const stage = damageStageForHealth(previewHealth);
  if (overview) { renderFleetOverview(); requestAnimationFrame(render); return; }
  camera.zoom = previewZoom;
  camera.position = new Vec2(0, 0);
  drawProceduralShip(ctx, camera, current, {
    position: new Vec2(0, 0), rotation: -Math.PI / 2, color, damageMesh: previewHull.renderMesh(),
  }, debug);
  const mainFills = lastFillCalls;
  debris.draw(ctx, camera);

  let rtsFills = 0;
  if (showRtsScale) {
    // Typical gameplay footprint: a ~120-unit ship drawn ~26 px across.
    const rtsZoom = 26 / Math.max(1, current.params.length);
    camera.zoom = rtsZoom;
    const cw = canvas.width, chh = canvas.height;
    const corner = camera.screenToWorld(new Vec2(cw - 150 * devicePixelRatio, chh - 90 * devicePixelRatio));
    for (let i = 0; i < 4; i++) {
      drawProceduralShip(ctx, camera, current, {
        position: new Vec2(corner.x + i * 44 / rtsZoom, corner.y), rotation: -Math.PI / 2, color, damageMesh: previewHull.renderMesh(),
      });
      rtsFills = lastFillCalls;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#5c7182';
    ctx.font = `${11 * devicePixelRatio}px monospace`;
    ctx.fillText('RTS scale', cw - 150 * devicePixelRatio, chh - 110 * devicePixelRatio);
  }

  const geo = getShipGeometry(current);
  statsEl.textContent =
    `polys ${geo.polyCount}/${MAX_POLYGONS}   buckets ${geo.bucketCount}   fills@preview ${mainFills}` +
    (showRtsScale ? `   fills@RTS ${rtsFills}` : '') +
    `   zoom ${previewZoom.toFixed(2)}   ${teamLabel(TEAMS[teamIndex])}` +
    `   hp ${Math.round(previewHealth * 100)}%  stage ${stage}/${DAMAGE_STAGES - 1}  debris ${debris.activeCount}`;

  requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------
// Panel building
// ---------------------------------------------------------------------------

function buildPanel(): void {
  panel.innerHTML = '';

  addSection('Player fleet');
  const fleetButtons = document.createElement('div'); fleetButtons.className = 'btnrow';
  for (const role of ['hero', 'fighter', 'bomber'] as FleetRole[]) {
    fleetButtons.appendChild(makeButton(role.toUpperCase(), () => { fleetRole = role; loadFleet(); }));
  }
  fleetButtons.appendChild(makeButton(overview ? 'SINGLE SHIP' : 'ALL PLAYER FLEETS', () => { overview = !overview; buildPanel(); }));
  panel.appendChild(fleetButtons);
  const fleetLabel = document.createElement('p');
  fleetLabel.textContent = `${teamLabel(TEAMS[teamIndex])} - ${fleetFamilyName(TEAMS[teamIndex])} - ${fleetRole}`;
  panel.appendChild(fleetLabel);
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

  addSection('View');
  const zoomRow = document.createElement('div');
  zoomRow.className = 'row';
  const zoomLabel = document.createElement('label');
  zoomLabel.textContent = 'preview zoom';
  const zoomSlider = document.createElement('input');
  zoomSlider.type = 'range'; zoomSlider.min = '0.08'; zoomSlider.max = '14'; zoomSlider.step = '0.01';
  zoomSlider.value = String(previewZoom);
  const zoomVal = document.createElement('span');
  zoomVal.className = 'val'; zoomVal.textContent = previewZoom.toFixed(2);
  zoomSlider.addEventListener('input', () => {
    previewZoom = Number(zoomSlider.value);
    zoomVal.textContent = previewZoom.toFixed(2);
  });
  zoomRow.appendChild(zoomLabel); zoomRow.appendChild(zoomSlider); zoomRow.appendChild(zoomVal);
  panel.appendChild(zoomRow);

  const viewBtns = document.createElement('div');
  viewBtns.className = 'btnrow';
  viewBtns.appendChild(makeButton('TOGGLE RTS SCALE', () => { showRtsScale = !showRtsScale; }));
  viewBtns.appendChild(makeButton('FIT', () => { previewZoom = 2.5; zoomSlider.value = '2.5'; zoomVal.textContent = '2.50'; }));
  panel.appendChild(viewBtns);

  addSection('Battle Damage (preview)');
  const dmgRow = document.createElement('div');
  dmgRow.className = 'row';
  const dmgLabel = document.createElement('label');
  dmgLabel.textContent = 'hull integrity';
  const dmgSlider = document.createElement('input');
  dmgSlider.type = 'range'; dmgSlider.min = '0'; dmgSlider.max = '1'; dmgSlider.step = '0.01';
  dmgSlider.value = String(previewHealth);
  const dmgVal = document.createElement('span');
  dmgVal.className = 'val';
  dmgVal.textContent = `${Math.round(previewHealth * 100)}%`;
  dmgSlider.addEventListener('input', () => {
    const next = Number(dmgSlider.value);
    const b = previewBody();
    if (next < previewHealth) {
      previewHull.hit(b, (previewHealth - next) * 100);
    } else {
      previewHull.repair(b, (next - previewHealth) * 100);
    }
    previewHealth = b.health / 100;
    dmgSlider.value = previewHealth.toString();
    dmgVal.textContent = `${Math.round(previewHealth * 100)}%`;
  });
  dmgRow.appendChild(dmgLabel); dmgRow.appendChild(dmgSlider); dmgRow.appendChild(dmgVal);
  panel.appendChild(dmgRow);

  const dmgBtns = document.createElement('div');
  dmgBtns.className = 'btnrow';
  dmgBtns.appendChild(makeButton('DAMAGE STEP', () => { applyPreviewHit(-1, 0); buildPanel(); }));
  dmgBtns.appendChild(makeButton('DEBRIS BURST', () => { applyPreviewHit(-1, 0, 30); buildPanel(); }));
  dmgBtns.appendChild(makeButton('REPAIR', () => { previewHealth = 1; previewHull.reset(); debris.clear(); buildPanel(); }));
  panel.appendChild(dmgBtns);

  addSection('Impact test');
  const kinds = document.createElement('div'); kinds.className = 'btnrow';
  for (const kind of ['bullet', 'laser', 'explosion'] as const) {
    kinds.appendChild(makeButton(`${impactKind === kind ? '* ' : ''}${kind.toUpperCase()}`, () => { impactKind = kind; buildPanel(); }));
  }
  panel.appendChild(kinds);
  const damageLabel = document.createElement('label'); damageLabel.textContent = 'Damage per hit (%)';
  const damageInput = document.createElement('input'); damageInput.type = 'number';
  damageInput.min = '1'; damageInput.max = '100'; damageInput.value = String(impactDamage);
  damageInput.setAttribute('aria-label', 'Damage per hit (%)');
  damageInput.addEventListener('change', () => { impactDamage = Math.max(1, Math.min(100, Number(damageInput.value) || 8)); });
  panel.append(damageLabel, damageInput);
  const directions = document.createElement('div'); directions.className = 'btnrow';
  for (const [label, x, y] of [['HIT LEFT', -1, 0], ['HIT RIGHT', 1, 0], ['HIT NOSE', 0, -1], ['HIT TAIL', 0, 1]] as const) {
    directions.appendChild(makeButton(label, () => { applyPreviewHit(x, y); buildPanel(); }));
  }
  panel.appendChild(directions);
  const hint = document.createElement('p'); hint.textContent = 'Click around the ship to aim a hit from that point. Lasers remove entry and exit pieces.';
  panel.appendChild(hint);
  addSection('Player Colour');
  const teamRow = document.createElement('div');
  teamRow.className = 'btnrow';
  for (const t of TEAMS) {
    const swatch = document.createElement('button');
    const c = teamColor(t);
    swatch.textContent = teamLabel(t) === 'Neutral' ? 'N' : teamLabel(t);
    swatch.style.background = `rgb(${Math.min(255, c.r * c.intensity) | 0},${Math.min(255, c.g * c.intensity) | 0},${Math.min(255, c.b * c.intensity) | 0})`;
    swatch.style.color = '#000';
    swatch.addEventListener('click', () => { teamIndex = TEAMS.indexOf(t); customColor = null; loadFleet(); });
    teamRow.appendChild(swatch);
  }
  panel.appendChild(teamRow);
  const pickRow = document.createElement('div');
  pickRow.className = 'row';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = '#3fa9ff';
  picker.addEventListener('input', () => {
    const v = picker.value;
    customColor = { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), intensity: 1 };
  });
  const pickLabel = document.createElement('label');
  pickLabel.textContent = 'custom colour';
  pickRow.appendChild(pickLabel); pickRow.appendChild(picker);
  panel.appendChild(pickRow);

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
    current.params = mutateParams(current.params, Number(mutSlider.value), Math.floor(Math.random() * 0xffffffff));
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

  const gameRow = document.createElement('div');
  gameRow.className = 'btnrow';
  const gameStatus = document.createElement('div');
  gameStatus.style.cssText = 'font-size:10.5px;color:#8fd;margin:2px 0;';
  const refreshGameStatus = () => {
    let set = false;
    try { set = !!localStorage.getItem(DEV_SHIP_DESIGN_KEY); } catch { /* unavailable */ }
    gameStatus.textContent = set
      ? 'In-game override ACTIVE — all ships use this design.'
      : 'Default player fleets active.';
  };
  gameRow.appendChild(makeButton('USE IN GAME', () => {
    try {
      localStorage.setItem(DEV_SHIP_DESIGN_KEY, JSON.stringify({ seed: current.seed, params: current.params }));
    } catch { /* storage unavailable — ignore */ }
    refreshGameStatus();
  }));
  gameRow.appendChild(makeButton('CLEAR', () => {
    try { localStorage.removeItem(DEV_SHIP_DESIGN_KEY); } catch { /* unavailable */ }
    refreshGameStatus();
  }));
  panel.appendChild(gameRow);
  refreshGameStatus();
  panel.appendChild(gameStatus);

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
  for (const preset of SHIP_PRESETS) presetList.appendChild(makePresetRow(preset.name, preset.def));
  for (const saved of loadSavedPresets()) presetList.appendChild(makePresetRow('★ ' + saved.name, saved.def));
  panel.appendChild(presetList);

  addSection('Debug Overlays');
  panel.appendChild(makeToggle('Gasket wireframe', 'showGasketWireframe'));
  panel.appendChild(makeToggle('Bud anchors', 'showBudAnchors'));
  panel.appendChild(makeToggle('Bucket outlines', 'showBucketBands'));
  panel.appendChild(makeToggle('Bounding box', 'showBoundingBox'));
  panel.appendChild(makeToggle('Symmetry axis', 'showSymmetryAxis'));

  addSection('Params');
  for (const key of PARAM_ORDER) panel.appendChild(makeSlider(key));
}

function previewBody() {
  return { position: new Vec2(0, 0), angle: -Math.PI / 2, radius: shipDesignRadius(current),
    health: previewHealth * 100, maxHealth: 100, alive: previewHealth > 0 };
}
function applyPreviewHit(x: number, y: number, damage = impactDamage): void {
  if (previewHealth <= 0) return;
  overview = false;
  previewHealth = Math.max(0, previewHealth - damage / 100);
  const radius = shipDesignRadius(current) * 2;
  previewHull.hit(previewBody(), damage, { kind: impactKind, x: x * radius, y: y * radius, dx: -x, dy: -y });
  previewHull.flush(previewBody(), debris, activeColor());
}
function loadFleet(): void {
  const def = fleetDesign(TEAMS[teamIndex], fleetRole);
  current = { seed: def.seed, params: { ...def.params } };
  invalidate(); buildPanel();
}
function renderFleetOverview(): void {
  const w = canvas.width / 4, h = canvas.height / 2;
  camera.zoom = 1; camera.position = new Vec2(0, 0);
  for (let i = 0; i < 8; i++) {
    const x = (i % 4 + 0.5) * w, y = (Math.floor(i / 4) + 0.42) * h;
    const color = teamColor(TEAMS[i]);
    for (const [role, offset, size] of [['hero', 0, 0.32], ['fighter', -0.23, 0.11], ['bomber', 0.23, 0.15]] as const) {
      const def = fleetDesign(TEAMS[i], role);
      drawProceduralShip(ctx, camera, def, { position: camera.screenToWorld(new Vec2(x + w * offset, y + (role === 'hero' ? 0 : h * 0.25))),
        rotation: -Math.PI / 2, color, scale: Math.min(w, h) * size / shipDesignRadius(def) });
    }
    ctx.fillStyle = '#cfe0ee'; ctx.font = `${12 * devicePixelRatio}px monospace`; ctx.textAlign = 'center';
    ctx.fillText(`P${i + 1} - ${fleetFamilyName(i + 1)}`, x, (Math.floor(i / 4) + 0.91) * h);
  }
  ctx.textAlign = 'left';
  statsEl.textContent = 'Eight fixed player families: hero, fighter (left), bomber (right)';
}
canvas.addEventListener('click', event => {
  if (overview) return;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * devicePixelRatio - canvas.width / 2;
  const y = (event.clientY - rect.top) * devicePixelRatio - canvas.height / 2;
  const d = Math.hypot(x, y) || 1;
  applyPreviewHit(x / d, y / d); buildPanel();
});

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
  label.textContent = PARAM_LABELS[key] ?? key;
  label.title = key;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(lo);
  input.max = String(hi);
  input.step = String(step(key));
  input.value = String(current.params[key]);
  const val = document.createElement('span');
  val.className = 'val';
  const fmt = (n: number) => (INTEGER_KEYS.has(key) ? String(Math.round(n)) : n.toFixed(3));
  val.textContent = fmt(current.params[key]);
  input.addEventListener('input', () => {
    current.params = { ...current.params, [key]: Number(input.value) };
    val.textContent = fmt(Number(input.value));
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

// Test hooks for headless screenshot automation.
(window as unknown as Record<string, unknown>).shipLab = {
  load(def: ProceduralShipDefinition) { current = { seed: def.seed, params: { ...def.params } }; invalidate(); buildPanel(); },
  loadPreset(name: string) {
    const preset = SHIP_PRESETS.find((s) => s.name === name);
    if (preset) { current = { seed: preset.def.seed, params: { ...preset.def.params } }; invalidate(); buildPanel(); }
  },
  setZoom(z: number) { previewZoom = z; },
  setParams(ov: Partial<ProceduralShipParams>) { current.params = { ...current.params, ...ov }; invalidate(); buildPanel(); },
  setTeam(i: number) { teamIndex = i; customColor = null; },
  setRts(v: boolean) { showRtsScale = v; },
  setHealth(h: number) { 
    const b = previewBody();
    const next = Math.max(0, Math.min(1, h));
    if (next < previewHealth) previewHull.hit(b, (previewHealth - next) * 100);
    else previewHull.repair(b, (next - previewHealth) * 100);
    previewHealth = b.health / 100;
    buildPanel(); 
  },
  burst() { applyPreviewHit(-1, 0, 30); },
  clearDebris() { debris.clear(); },
  debrisCount() { return debris.activeCount; },
  setDebug(k: keyof ShipDebugOverlay, v: boolean) { debug[k] = v; },
  stats() { const g = getShipGeometry(current); return { polys: g.polyCount, buckets: g.bucketCount, fills: lastFillCalls }; },
};

resizeCanvas();
loadFleet();
render();
