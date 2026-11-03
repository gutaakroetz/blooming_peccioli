/* ── Blooming Peccioli — app.js ─────────────────────────────────────────── */

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const SCENARIOS_PATH = 'data/scenarios/';

const TRAIL_LENGTH   = 10;   // numero di posizioni nella scia
const TRAIL_INTERVAL = 30;   // secondi tra i punti della scia
const DOT_RADIUS     = 7;    // px raggio dot veicolo
const TRAIL_WIDTH    = 3;    // px spessore scia

// ── Stato globale ────────────────────────────────────────────────────────────
let map;
let scenario     = null;   // dati JSON caricati
let simTime      = 0;      // secondi da mezzanotte (0–86400)
let playing      = false;
let speedMult    = 1;
let lastRafTime  = null;
let scrubbing    = false;

// Per ogni veicolo: buffer delle ultime posizioni per la scia
// { vehicleId: [{lat, lng, t}, ...] }
const trailBuffers = {};

// ── Elementi DOM ─────────────────────────────────────────────────────────────
const playBtn     = document.getElementById('play-btn');
const iconPlay    = document.getElementById('icon-play');
const iconPause   = document.getElementById('icon-pause');
const timeDisplay = document.getElementById('time-display');
const scrubber    = document.getElementById('scrubber');
const loadingEl   = document.getElementById('loading');

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
    loadScenario('weekday');
  });
}

// ── Carica scenario JSON ──────────────────────────────────────────────────────
async function loadScenario(name) {
  showLoading(true);
  pauseAnimation();
  simTime = 0;
  scrubber.value = 0;
  updateTimeDisplay(0);

  try {
    const res = await fetch(`${SCENARIOS_PATH}${name}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    scenario = await res.json();
  } catch (e) {
    console.error('Errore caricamento scenario:', e);
    showLoading(false);
    return;
  }

  // Rimuovi layer/sources precedenti
  removeVehicleLayers();

  // Resetta trail buffer
  Object.keys(trailBuffers).forEach(k => delete trailBuffers[k]);

  // Crea layer per ogni veicolo
  scenario.vehicles.forEach(v => {
    trailBuffers[v.id] = [];
    addVehicleLayers(v);
  });

  showLoading(false);
  playAnimation();
}

// ── Source/Layer per un veicolo ───────────────────────────────────────────────
function addVehicleLayers(vehicle) {
  const dotSourceId   = `src-dot-${vehicle.id}`;
  const trailSourceId = `src-trail-${vehicle.id}`;
  const dotLayerId    = `lyr-dot-${vehicle.id}`;
  const trailLayerId  = `lyr-trail-${vehicle.id}`;

  // Source dot (Point)
  map.addSource(dotSourceId, {
    type: 'geojson',
    data: emptyPoint(),
  });

  // Source trail (LineString)
  map.addSource(trailSourceId, {
    type: 'geojson',
    data: emptyLine(),
  });

  // Layer scia — sotto il dot
  map.addLayer({
    id: trailLayerId,
    type: 'line',
    source: trailSourceId,
    paint: {
      'line-color': vehicle.color,
      'line-width': TRAIL_WIDTH,
      'line-opacity': 0.45,
      'line-blur': 1,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  });

  // Layer dot
  map.addLayer({
    id: dotLayerId,
    type: 'circle',
    source: dotSourceId,
    paint: {
      'circle-radius': DOT_RADIUS,
      'circle-color': vehicle.color,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 1,
    },
  });
}

// ── Rimuovi tutti i layer veicoli ────────────────────────────────────────────
function removeVehicleLayers() {
  if (!scenario) return;
  scenario.vehicles.forEach(v => {
    [`lyr-dot-${v.id}`, `lyr-trail-${v.id}`].forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    [`src-dot-${v.id}`, `src-trail-${v.id}`].forEach(id => {
      if (map.getSource(id)) map.removeSource(id);
    });
  });
}

// ── Interpolazione posizione ──────────────────────────────────────────────────
function interpolatePosition(waypoints, t) {
  if (!waypoints || waypoints.length === 0) return null;

  const first = waypoints[0];
  const last  = waypoints[waypoints.length - 1];

  // Prima o dopo la finestra temporale del veicolo
  if (t < first.t || t > last.t) return null;

  // Trova i due waypoint che racchiudono t
  let lo = 0, hi = waypoints.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (waypoints[mid].t <= t) lo = mid; else hi = mid;
  }

  const a = waypoints[lo];
  const b = waypoints[hi];
  if (a.t === b.t) return { lat: a.lat, lng: a.lng };

  const frac = (t - a.t) / (b.t - a.t);
  return {
    lat: a.lat + (b.lat - a.lat) * frac,
    lng: a.lng + (b.lng - a.lng) * frac,
  };
}

// ── Aggiorna tutte le posizioni ───────────────────────────────────────────────
function updateVehicles(t) {
  if (!scenario || !map.isStyleLoaded()) return;

  scenario.vehicles.forEach(v => {
    const pos = interpolatePosition(v.waypoints, t);
    const dotSrc   = map.getSource(`src-dot-${v.id}`);
    const trailSrc = map.getSource(`src-trail-${v.id}`);
    if (!dotSrc || !trailSrc) return;

    if (!pos) {
      // Veicolo non attivo: nascondi
      dotSrc.setData(emptyPoint());
      trailSrc.setData(emptyLine());
      return;
    }

    // Aggiorna dot
    dotSrc.setData({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
    });

    // Aggiorna scia
    const buf = trailBuffers[v.id];
    const lastPt = buf[buf.length - 1];
    if (!lastPt || Math.abs(t - lastPt.t) >= TRAIL_INTERVAL) {
      buf.push({ lat: pos.lat, lng: pos.lng, t });
      if (buf.length > TRAIL_LENGTH) buf.shift();
    }

    if (buf.length >= 2) {
      trailSrc.setData({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: buf.map(p => [p.lng, p.lat]),
        },
      });
    } else {
      trailSrc.setData(emptyLine());
    }
  });
}

// ── Loop animazione ───────────────────────────────────────────────────────────
function animationLoop(rafTime) {
  if (!playing) return;

  if (lastRafTime !== null) {
    const dtMs  = rafTime - lastRafTime;
    const dtSim = (dtMs / 1000) * speedMult;   // secondi simulati
    simTime = Math.min(simTime + dtSim, 86400);
  }
  lastRafTime = rafTime;

  updateVehicles(simTime);
  updateTimeDisplay(simTime);
  scrubber.value = Math.round(simTime);

  if (simTime >= 86400) {
    simTime = 0;
    clearTrails();
  }

  requestAnimationFrame(animationLoop);
}

// ── Controlli ─────────────────────────────────────────────────────────────────
function playAnimation() {
  if (playing) return;
  playing = true;
  lastRafTime = null;
  iconPlay.style.display  = 'none';
  iconPause.style.display = '';
  requestAnimationFrame(animationLoop);
}

function pauseAnimation() {
  playing = false;
  lastRafTime = null;
  iconPlay.style.display  = '';
  iconPause.style.display = 'none';
}

function togglePlay() {
  playing ? pauseAnimation() : playAnimation();
}

function clearTrails() {
  if (!scenario) return;
  scenario.vehicles.forEach(v => { trailBuffers[v.id] = []; });
}

// ── Time display ──────────────────────────────────────────────────────────────
function updateTimeDisplay(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  timeDisplay.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ── Helpers GeoJSON vuoti ─────────────────────────────────────────────────────
function emptyPoint() {
  return { type: 'FeatureCollection', features: [] };
}
function emptyLine() {
  return { type: 'FeatureCollection', features: [] };
}

// ── Loading overlay ───────────────────────────────────────────────────────────
function showLoading(show) {
  loadingEl.classList.toggle('hidden', !show);
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Play/pausa
playBtn.addEventListener('click', togglePlay);

// Scrubber — trascina manualmente
scrubber.addEventListener('mousedown', () => {
  scrubbing = true;
  pauseAnimation();
});
scrubber.addEventListener('touchstart', () => {
  scrubbing = true;
  pauseAnimation();
});
scrubber.addEventListener('input', () => {
  simTime = Number(scrubber.value);
  updateTimeDisplay(simTime);
  clearTrails();
  updateVehicles(simTime);
});
scrubber.addEventListener('mouseup', () => {
  scrubbing = false;
  playAnimation();
});
scrubber.addEventListener('touchend', () => {
  scrubbing = false;
  playAnimation();
});

// Velocità
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    speedMult = Number(btn.dataset.speed);
  });
});

// Scenario
document.querySelectorAll('.scenario-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.scenario-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadScenario(btn.dataset.scenario);
  });
});

// ── Avvio ─────────────────────────────────────────────────────────────────────
initMap();
