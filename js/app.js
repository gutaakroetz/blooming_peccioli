/* ── Blooming Peccioli — app.js ─────────────────────────────────────────── */

const MAP_STYLE      = 'https://tiles.openfreemap.org/styles/positron';
const SCENARIOS_PATH = 'data/scenarios/';
const BLOOMING_PATH  = 'data/blooming.geojson';

const BACINO_COLORS = {
  peccioli:  '#FFC000',
  forcoli:   '#41CE69',
  fabbrica:  '#BC7CFF',
  belvedere: '#0875F9',
  rosa:      '#FD6BC9',
  ghizzano:  '#FF9900',
};
const BACINO_ORDER = ['peccioli','forcoli','fabbrica','belvedere','rosa','ghizzano'];

const TRAIL_LENGTH   = 10;    // posizioni nella scia
const TRAIL_INTERVAL = 30;    // secondi tra i punti della scia
const DOT_RADIUS     = 7;     // px raggio dot veicolo
const TRAIL_WIDTH    = 3;     // px spessore scia
const HIT_RADIUS_KM  = 0.15;  // 150 m — raggio per rilevare passaggio su fermata
const HIT_COOLDOWN_S = 300;   // 5 min cooldown per veicolo/fermata
const KM_BAR_MAX     = 300;   // km massimi per scalare la barra

// ── Stato globale ────────────────────────────────────────────────────────────
let map;
let scenario     = null;
let simTime      = 25200;   // secondi — default 07h 00
let prevSimTime  = 25200;
let playing      = false;
let speedMult    = 300;
let lastRafTime  = null;
let scrubbing    = false;

const trailBuffers = {};
let jollyMarker    = null;

// Fixed stop markers (HTML Marker) e mappa stopId → DOM element
let fixedStopMarkers = [];
let fixedStopDotMap  = {};   // stopId → .stop-dot-wrap

// Pre-computed data per statistiche
let stopHitsData  = [];   // [{t, stopId, vehicleId}] sorted by t
let precomputedKm = {};   // {vehicleId: {tArr, kmArr}}

// ── Elementi DOM ─────────────────────────────────────────────────────────────
const playBtn     = document.getElementById('play-btn');
const iconPlay    = document.getElementById('icon-play');
const iconPause   = document.getElementById('icon-pause');
const timeDisplay = document.getElementById('time-display');
const scrubber    = document.getElementById('scrubber');
const loadingEl   = document.getElementById('loading');

scrubber.value = 25200;
updateTimeDisplay(25200);

// ── Init mappa ───────────────────────────────────────────────────────────────
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [10.72, 43.56],
    zoom: 11.5,
    attributionControl: true,
  });

  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  map.on('load', () => {
    map.addSource('network', { type: 'geojson', data: 'data/network.geojson' });
    map.addLayer({
      id: 'network-roads', type: 'line', source: 'network',
      paint: { 'line-color': '#b0aca3', 'line-width': 1.0, 'line-opacity': 0.5 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    startClock();
    loadScenario('weekday');
  });
}

// ── Carica scenario JSON ──────────────────────────────────────────────────────
async function loadScenario(name) {
  showLoading(true);
  pauseAnimation();
  simTime = prevSimTime = 25200;
  scrubber.value = 25200;
  updateTimeDisplay(25200);

  try {
    const res = await fetch(`${SCENARIOS_PATH}${name}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    scenario = await res.json();
  } catch (e) {
    console.error('Errore caricamento scenario:', e);
    showLoading(false);
    return;
  }

  removeVehicleLayers();
  Object.keys(trailBuffers).forEach(k => delete trailBuffers[k]);

  scenario.vehicles.forEach(v => {
    trailBuffers[v.id] = [];
    addVehicleLayers(v);
  });

  // Fermate fisse e dati pre-calcolati
  if (scenario.fixed_stops && scenario.fixed_stops.length) {
    renderFixedStops(scenario.fixed_stops);
    stopHitsData = precomputeStopHits(scenario.vehicles, scenario.fixed_stops);
  } else {
    stopHitsData = [];
  }

  precomputedKm = precomputeKmArrays(scenario.vehicles);
  initStats(scenario.vehicles);
  updateStats(simTime);
  renderHourMarks();

  showLoading(false);
  runIntroAnimation(scenario.fixed_stops || []);
}

// ── Layer veicoli ─────────────────────────────────────────────────────────────
function addVehicleLayers(vehicle) {
  if (vehicle.type === 'jolly') {
    // Scia come layer MapLibre
    map.addSource('src-trail-jolly', { type: 'geojson', data: emptyLine(), lineMetrics: true });
    map.addLayer({
      id: 'lyr-trail-jolly', type: 'line', source: 'src-trail-jolly',
      paint: {
        'line-width': 2,
        'line-opacity': 0.5,
        'line-blur': 1,
        'line-gradient': ['interpolate', ['linear'], ['line-progress'],
          0, 'rgba(200,160,212,0)', 1, 'rgba(200,160,212,1)'],
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    // Marker HTML con rotazione (wrapper neutro per evitare conflitto transform)
    const el   = document.createElement('div');
    el.style.cssText = 'width:13px;height:13px;position:relative;';
    const dot = document.createElement('div');
    dot.className = 'jolly-marker';
    el.appendChild(dot);
    jollyMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([10.72, 43.56])
      .addTo(map);
    el.style.display = 'none';   // nascosto finché non inizia a muoversi
    trailBuffers['jolly'] = [];
    return;
  }

  map.addSource(`src-dot-${vehicle.id}`,   { type: 'geojson', data: emptyPoint() });
  map.addSource(`src-trail-${vehicle.id}`, { type: 'geojson', data: emptyLine()  });

  map.addLayer({
    id: `lyr-trail-${vehicle.id}`, type: 'line', source: `src-trail-${vehicle.id}`,
    paint: { 'line-color': vehicle.color, 'line-width': TRAIL_WIDTH, 'line-opacity': 0.45, 'line-blur': 1 },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.addLayer({
    id: `lyr-dot-${vehicle.id}`, type: 'circle', source: `src-dot-${vehicle.id}`,
    paint: { 'circle-radius': DOT_RADIUS, 'circle-color': vehicle.color,
             'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff', 'circle-opacity': 1 },
  });
}

function removeVehicleLayers() {
  if (!scenario) return;
  scenario.vehicles.forEach(v => {
    if (v.type === 'jolly') return;
    [`lyr-dot-${v.id}`, `lyr-trail-${v.id}`].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    [`src-dot-${v.id}`, `src-trail-${v.id}`].forEach(id => { if (map.getSource(id)) map.removeSource(id); });
  });
  if (jollyMarker) { jollyMarker.remove(); jollyMarker = null; }
  if (map.getLayer('lyr-trail-jolly')) map.removeLayer('lyr-trail-jolly');
  if (map.getSource('src-trail-jolly')) map.removeSource('src-trail-jolly');
  clearFixedStops();
}

// ── Fermate fisse ─────────────────────────────────────────────────────────────
function renderFixedStops(stops) {
  stops.forEach(stop => {
    const wrap = document.createElement('div');
    wrap.className = 'stop-marker-el';
    wrap.innerHTML = `<span class="stop-label">${stop.label}</span><div class="stop-dot-wrap"><div class="stop-dot"></div></div>`;
    const m = new maplibregl.Marker({ element: wrap, anchor: 'right' })
      .setLngLat([stop.lng, stop.lat])
      .addTo(map);
    fixedStopMarkers.push(m);
    fixedStopDotMap[stop.id] = wrap.querySelector('.stop-dot-wrap');
  });
}

function clearFixedStops() {
  fixedStopMarkers.forEach(m => m.remove());
  fixedStopMarkers = [];
  fixedStopDotMap  = {};
}

function triggerRipple(stopId) {
  const el = fixedStopDotMap[stopId];
  if (!el) return;
  for (let i = 0; i < 3; i++) {
    const r = document.createElement('div');
    r.className = 'stop-ripple';
    r.style.animationDelay = `${i * 0.35}s`;
    el.appendChild(r);
    r.addEventListener('animationend', () => r.remove(), { once: true });
  }
}

// ── Statistiche ───────────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function precomputeKmArrays(vehicles) {
  const result = {};
  vehicles.forEach(v => {
    const wps   = v.waypoints || [];
    const tArr  = wps.map(w => w.t);
    const kmArr = [0];
    for (let i = 1; i < wps.length; i++) {
      kmArr.push(kmArr[i - 1] + haversineKm(wps[i-1].lat, wps[i-1].lng, wps[i].lat, wps[i].lng));
    }
    result[v.id] = { tArr, kmArr };
  });
  return result;
}

function getKmAtT(vehicleId, t) {
  const { tArr, kmArr } = precomputedKm[vehicleId] || { tArr: [], kmArr: [] };
  if (!tArr.length) return 0;
  if (t <= tArr[0]) return 0;
  if (t >= tArr[tArr.length - 1]) return kmArr[kmArr.length - 1];
  let lo = 0, hi = tArr.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (tArr[mid] <= t) lo = mid; else hi = mid; }
  const frac = (t - tArr[lo]) / (tArr[hi] - tArr[lo]);
  return kmArr[lo] + (kmArr[hi] - kmArr[lo]) * frac;
}

function precomputeStopHits(vehicles, fixedStops) {
  const hits = [];
  vehicles.forEach(v => {
    const lastHitT = {};
    (v.waypoints || []).forEach(wp => {
      fixedStops.forEach(stop => {
        if (haversineKm(wp.lat, wp.lng, stop.lat, stop.lng) < HIT_RADIUS_KM) {
          const lt = lastHitT[stop.id] ?? -Infinity;
          if (wp.t - lt > HIT_COOLDOWN_S) {
            hits.push({ t: wp.t, stopId: stop.id, vehicleId: v.id });
            lastHitT[stop.id] = wp.t;
          }
        }
      });
    });
  });
  return hits.sort((a, b) => a.t - b.t);
}

function initStats(vehicles) {
  const kmBars = document.getElementById('km-bars');
  if (!kmBars) return;
  kmBars.innerHTML = '';
  vehicles.forEach(v => {
    const isJolly  = v.type === 'jolly';
    const fillStyle = isJolly
      ? 'background:conic-gradient(#e8b4d8,#b4c8e8,#b4e8d0,#e8e8b4,#e8c4b4,#e8b4d8)'
      : `background:${v.color}`;
    const labelColor = isJolly ? '#888' : v.color;
    const row = document.createElement('div');
    row.className = 'km-bar-row';
    row.innerHTML = `
      <span class="km-bar-label" style="color:${labelColor}">${v.label}</span>
      <div class="km-bar-track"><div class="km-bar-fill" id="km-bar-${v.id}" style="${fillStyle}"></div></div>
      <span class="km-bar-val" id="km-val-${v.id}">0</span>`;
    kmBars.appendChild(row);
  });
}

function updateStats(t) {
  if (!scenario) return;
  scenario.vehicles.forEach(v => {
    const km  = getKmAtT(v.id, t);
    const bar = document.getElementById(`km-bar-${v.id}`);
    const val = document.getElementById(`km-val-${v.id}`);
    if (bar) bar.style.width = `${Math.min((km / KM_BAR_MAX) * 100, 100)}%`;
    if (val) val.textContent  = km.toFixed(1);
  });

  const hits     = stopHitsData.filter(h => h.t <= t).length;
  const users    = hits * 18;
  const maxUsers = stopHitsData.length * 18 || 1;
  const usersBar = document.getElementById('users-bar');
  const usersVal = document.getElementById('users-val');
  if (usersBar) usersBar.style.width = `${Math.min((users / maxUsers) * 100, 100)}%`;
  if (usersVal) usersVal.textContent  = users;
}

// ── Ore sulla timeline ────────────────────────────────────────────────────────
function renderHourMarks() {
  const container = document.getElementById('timeline-hours');
  if (!container) return;
  container.innerHTML = '';
  for (let h = 0; h <= 24; h += 2) {
    const t   = h * 3600;
    const pct = (t / 86400) * 100;
    const tick = document.createElement('div');
    tick.className = 'hour-tick';
    tick.style.left = `${pct}%`;
    tick.title = `Vai alle ${String(h).padStart(2,'0')}:00`;
    tick.innerHTML = `<div class="hour-tick-dot"></div><span class="hour-tick-label">${String(h).padStart(2,'0')}</span>`;
    tick.addEventListener('click', () => {
      simTime = prevSimTime = t;
      scrubber.value = t;
      updateTimeDisplay(t);
      clearTrails();
      updateVehicles(t);
      updateStats(t);
    });
    container.appendChild(tick);
  }
}

// ── Interpolazione posizione ──────────────────────────────────────────────────
function interpolatePosition(waypoints, t) {
  if (!waypoints || waypoints.length === 0) return null;
  const first = waypoints[0], last = waypoints[waypoints.length - 1];
  if (t < first.t || t > last.t) return null;
  let lo = 0, hi = waypoints.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (waypoints[mid].t <= t) lo = mid; else hi = mid; }
  const a = waypoints[lo], b = waypoints[hi];
  if (a.t === b.t) return { lat: a.lat, lng: a.lng };
  const frac = (t - a.t) / (b.t - a.t);
  return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac };
}

// ── Aggiorna posizioni ────────────────────────────────────────────────────────
function updateVehicles(t) {
  if (!scenario || !map.isStyleLoaded()) return;

  scenario.vehicles.forEach(v => {
    if (v.type === 'jolly') {
      if (!jollyMarker) return;
      const pos = interpolatePosition(v.waypoints, t);
      const trailSrc = map.getSource('src-trail-jolly');
      if (pos) {
        jollyMarker.setLngLat([pos.lng, pos.lat]);
        jollyMarker.getElement().style.display = 'block';
        // Scia jolly
        if (trailSrc) {
          const buf = trailBuffers['jolly'] || [];
          const lastPt = buf[buf.length - 1];
          if (!lastPt || Math.abs(t - lastPt.t) >= TRAIL_INTERVAL) {
            buf.push({ lat: pos.lat, lng: pos.lng, t });
            if (buf.length > TRAIL_LENGTH) buf.shift();
            trailBuffers['jolly'] = buf;
          }
          if (buf.length >= 2) {
            trailSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: buf.map(p => [p.lng, p.lat]) } });
          }
        }
      } else {
        jollyMarker.getElement().style.display = 'none';
        if (trailSrc) trailSrc.setData(emptyLine());
        trailBuffers['jolly'] = [];
      }
      return;
    }

    const pos      = interpolatePosition(v.waypoints, t);
    const dotSrc   = map.getSource(`src-dot-${v.id}`);
    const trailSrc = map.getSource(`src-trail-${v.id}`);
    if (!dotSrc || !trailSrc) return;

    if (!pos) {
      dotSrc.setData(emptyPoint());
      trailSrc.setData(emptyLine());
      return;
    }

    dotSrc.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] } });

    const buf    = trailBuffers[v.id];
    const lastPt = buf[buf.length - 1];
    if (!lastPt || Math.abs(t - lastPt.t) >= TRAIL_INTERVAL) {
      buf.push({ lat: pos.lat, lng: pos.lng, t });
      if (buf.length > TRAIL_LENGTH) buf.shift();
    }
    if (buf.length >= 2) {
      trailSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: buf.map(p => [p.lng, p.lat]) } });
    } else {
      trailSrc.setData(emptyLine());
    }
  });
}

// ── Loop animazione ───────────────────────────────────────────────────────────
function animationLoop(rafTime) {
  if (!playing) return;

  const tBefore = simTime;

  if (lastRafTime !== null) {
    simTime = Math.min(simTime + ((rafTime - lastRafTime) / 1000) * speedMult, 86400);
  }
  lastRafTime = rafTime;

  // Ripple sui passaggi alle fermate fisse
  if (simTime > tBefore) {
    for (const hit of stopHitsData) {
      if (hit.t > simTime) break;
      if (hit.t > tBefore && hit.t <= simTime) triggerRipple(hit.stopId);
    }
  }

  updateVehicles(simTime);
  updateStats(simTime);
  updateTimeDisplay(simTime);
  scrubber.value = Math.round(simTime);
  prevSimTime    = simTime;

  if (simTime >= 86400) {
    simTime = prevSimTime = 25200;
    clearTrails();
  }

  requestAnimationFrame(animationLoop);
}

// ── Controlli ─────────────────────────────────────────────────────────────────
function playAnimation() {
  if (playing) return;
  playing = true; lastRafTime = null;
  iconPlay.style.display = 'none'; iconPause.style.display = '';
  requestAnimationFrame(animationLoop);
}
function pauseAnimation() {
  playing = false; lastRafTime = null;
  iconPlay.style.display = ''; iconPause.style.display = 'none';
}
function togglePlay() { playing ? pauseAnimation() : playAnimation(); }

function clearTrails() {
  if (!scenario) return;
  scenario.vehicles.forEach(v => { trailBuffers[v.id] = []; });
  trailBuffers['jolly'] = [];
  const trailSrc = map.getSource('src-trail-jolly');
  if (trailSrc) trailSrc.setData(emptyLine());
}

function updateTimeDisplay(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  timeDisplay.textContent = `${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}`;
}

function emptyPoint() { return { type: 'FeatureCollection', features: [] }; }
function emptyLine()  { return { type: 'FeatureCollection', features: [] }; }
function showLoading(show) { loadingEl.classList.toggle('hidden', !show); }

// ── Event listeners ───────────────────────────────────────────────────────────
playBtn.addEventListener('click', togglePlay);

scrubber.addEventListener('mousedown', () => { scrubbing = true; pauseAnimation(); });
scrubber.addEventListener('touchstart', () => { scrubbing = true; pauseAnimation(); });
scrubber.addEventListener('input', () => {
  simTime = prevSimTime = Number(scrubber.value);
  updateTimeDisplay(simTime);
  clearTrails();
  updateVehicles(simTime);
  updateStats(simTime);
});
scrubber.addEventListener('mouseup',  () => { scrubbing = false; playAnimation(); });
scrubber.addEventListener('touchend', () => { scrubbing = false; playAnimation(); });

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    speedMult = Number(btn.dataset.speed);
  });
});

document.querySelectorAll('.scenario-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.scenario-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadScenario(btn.dataset.scenario);
  });
});

// ── Bloom intro animation ─────────────────────────────────────────────────────
function springEase(t) {
  // Overshoots slightly then settles — bouncy feel
  return 1 - Math.exp(-5.5 * t) * Math.cos(10 * t);
}
function easeInOut(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

function removeBloomLayers() {
  [...BACINO_ORDER, 'spine'].forEach(name => {
    const fill   = `bloom-fill-${name}`;
    const stroke = `bloom-stroke-${name}`;
    const line   = `bloom-spine-line`;
    if (map.getLayer(fill))   map.removeLayer(fill);
    if (map.getLayer(stroke)) map.removeLayer(stroke);
    if (map.getLayer(line))   map.removeLayer(line);
    if (map.getSource(`bloom-${name}`)) map.removeSource(`bloom-${name}`);
    if (map.getSource('bloom-spine'))   map.removeSource('bloom-spine');
  });
}

async function runIntroAnimation(fixedStops) {
  removeBloomLayers();

  let geojson;
  try {
    const res = await fetch(BLOOMING_PATH);
    if (!res.ok) throw new Error();
    geojson = await res.json();
  } catch {
    playAnimation();
    return;
  }

  // Group by Layer property (lowercase)
  const byLayer = {};
  geojson.features.forEach(f => {
    const l = (f.properties.Layer || f.properties.layer || '').toLowerCase();
    (byLayer[l] = byLayer[l] || []).push(f);
  });

  // Add fill + stroke sources for each bacino
  BACINO_ORDER.forEach(bacino => {
    const feats = byLayer[bacino] || [];
    if (!feats.length) return;
    map.addSource(`bloom-${bacino}`, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: feats },
    });
    // Insert below network-roads so vehicles appear on top
    map.addLayer({
      id: `bloom-fill-${bacino}`, type: 'fill', source: `bloom-${bacino}`,
      paint: { 'fill-color': BACINO_COLORS[bacino], 'fill-opacity': 0, 'fill-translate': [0, 20] },
    }, 'network-roads');
    map.addLayer({
      id: `bloom-stroke-${bacino}`, type: 'line', source: `bloom-${bacino}`,
      paint: { 'line-color': '#fff', 'line-width': 0.8, 'line-opacity': 0 },
    }, 'network-roads');
  });

  // Spine source (starts empty, filled progressively)
  const spineFeats = byLayer['spine'] || [];
  if (spineFeats.length) {
    map.addSource('bloom-spine', { type: 'geojson', lineMetrics: true,
      data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'bloom-spine-line', type: 'line', source: 'bloom-spine',
      paint: {
        'line-width': 2.5, 'line-opacity': 0,
        'line-gradient': ['interpolate',['linear'],['line-progress'],
          0,'rgba(100,100,120,0)', 1,'rgba(100,100,140,0.85)'],
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
  }

  // ── Animate petals in sequence ──────────────────────────────────────────────
  const PETAL_DUR = 600;    // ms per petal animation
  const PETAL_GAP = 130;    // ms between petals
  const TARGET_FILL_OP = 0.32;

  function animatePetal(bacino, startAt) {
    return new Promise(resolve => {
      setTimeout(() => {
        const t0 = performance.now();
        function frame(now) {
          const t = Math.min((now - t0) / PETAL_DUR, 1);
          const e = springEase(t);
          const op = Math.min(e * TARGET_FILL_OP, 1);
          const ty = (1 - Math.min(e, 1)) * 20;
          if (map.getLayer(`bloom-fill-${bacino}`)) {
            map.setPaintProperty(`bloom-fill-${bacino}`, 'fill-opacity', op);
            map.setPaintProperty(`bloom-fill-${bacino}`, 'fill-translate', [0, ty]);
          }
          if (map.getLayer(`bloom-stroke-${bacino}`)) {
            map.setPaintProperty(`bloom-stroke-${bacino}`, 'line-opacity', Math.min(op * 2, 0.5));
          }
          if (t < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      }, startAt);
    });
  }

  // Fire all petals with staggered starts, don't await each
  BACINO_ORDER.forEach((bacino, i) => {
    if (byLayer[bacino]?.length) animatePetal(bacino, i * PETAL_GAP);
  });

  const afterPetals = BACINO_ORDER.length * PETAL_GAP + PETAL_DUR + 300;

  // ── Animate spine bottom→top ────────────────────────────────────────────────
  setTimeout(() => {
    if (!spineFeats.length) return;
    const feat = spineFeats[0];
    let coords = feat.geometry.type === 'LineString'
      ? [...feat.geometry.coordinates]
      : [...(feat.geometry.coordinates[0] || [])];
    // Ensure bottom-to-top (ascending latitude)
    if (coords.length >= 2 && coords[0][1] > coords[coords.length - 1][1]) coords.reverse();

    if (map.getLayer('bloom-spine-line'))
      map.setPaintProperty('bloom-spine-line', 'line-opacity', 0.75);

    const SPINE_DUR = 1400;
    const t0 = performance.now();
    function frame(now) {
      const t = Math.min((now - t0) / SPINE_DUR, 1);
      const count = Math.max(2, Math.round(easeInOut(t) * coords.length));
      const src = map.getSource('bloom-spine');
      if (src) src.setData({ type: 'FeatureCollection', features: [{
        type: 'Feature', geometry: { type: 'LineString', coordinates: coords.slice(0, count) },
        properties: feat.properties,
      }]});
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, afterPetals);

  // ── Fade out spine ──────────────────────────────────────────────────────────
  const spineEnd = afterPetals + 1400 + 2800;
  setTimeout(() => {
    if (!map.getLayer('bloom-spine-line')) return;
    const t0 = performance.now();
    function frame(now) {
      const t = Math.min((now - t0) / 700, 1);
      map.setPaintProperty('bloom-spine-line', 'line-opacity', (1 - t) * 0.75);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, spineEnd);

  // ── Start vehicles after full intro ────────────────────────────────────────
  setTimeout(playAnimation, spineEnd + 700 + 200);
}

// ── Real-time clock ───────────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('realtime-clock');
  if (!el) return;
  function tick() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2,'0');
    const m = String(now.getMinutes()).padStart(2,'0');
    const s = String(now.getSeconds()).padStart(2,'0');
    el.textContent = `${h}:${m}:${s}`;
  }
  tick();
  setInterval(tick, 1000);
}

// ── Avvio ─────────────────────────────────────────────────────────────────────
initMap();
