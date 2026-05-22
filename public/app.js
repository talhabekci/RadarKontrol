/**
 * RadarKontrol — app.js
 * Vanilla JS, Leaflet.js
 * API proxy: /api/* → icisleri.gov.tr
 */

/* =====================================================
   STATE
   ===================================================== */
const State = {
  cities: [],
  fromDistricts: [],
  toDistricts: [],
  fromDistrict: null,
  toDistrict: null,
  routeData: null,
  lastFetchTime: null,
  updateTimer: null,
  pendingUpdate: null,
  isLoading: false,
  // --- Location tracking ---
  watchId: null,
  userPosition: null,
  userMarker: null,
  alertCooldowns: new Map(),
  activeCorridors: new Set(),
  // --- Corridor progress (average speed tracking) ---
  corridorProgress: new Map(), // corridorId → {entryTime, distanceKm, lastLat, lastLon}
};

/* =====================================================
   MAP
   ===================================================== */
const map = L.map('map', {
  center: [39.1, 35.0],
  zoom: 6,
  zoomControl: true,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// Map layer groups
const layers = {
  route: L.layerGroup().addTo(map),
  corridors: L.layerGroup().addTo(map),
  markers: L.layerGroup().addTo(map),
  user: L.layerGroup().addTo(map),  // user location (always on top)
};

// Radar marker icon
const radarIcon = L.icon({
  iconUrl: '/icons/radar.png',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -18],
});

/* =====================================================
   API
   ===================================================== */
const API = {
  async getCities() {
    const res = await fetch('/api/GetCities');
    if (!res.ok) throw new Error('Şehirler alınamadı.');
    return res.json();
  },

  async getDistricts(cityId) {
    const res = await fetch(`/api/GetDistricts?cityId=${cityId}`);
    if (!res.ok) throw new Error('İlçeler alınamadı.');
    return res.json();
  },

  async createRoute(from, to) {
    const body = new URLSearchParams({
      fromLatitude: from.Latitude,
      fromLongitude: from.Longitude,
      toLatitude: to.Latitude,
      toLongitude: to.Longitude,
      fromDistrictId: from.Id,
      toDistrictId: to.Id,
    });
    const res = await fetch('/api/CreateRoute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('Rota oluşturulamadı.');
    return res.json();
  },
};

/* =====================================================
   DOM REFS
   ===================================================== */
const $ = (id) => document.getElementById(id);

const els = {
  fromCity:        $('from-city'),
  fromDistrict:    $('from-district'),
  toCity:          $('to-city'),
  toDistrict:      $('to-district'),
  routeBtn:        $('route-btn'),
  btnLabel:        document.querySelector('.btn-label'),
  btnSpinner:      document.querySelector('.btn-spinner'),
  statsPanel:      $('stats-panel'),
  statsRouteName:  $('stats-route-name'),
  statRadars:      $('stat-radars'),
  statCheckpoints: $('stat-checkpoints'),
  statCorridors:   $('stat-corridors'),
  cityList:        $('city-list'),
  lastUpdated:     $('last-updated'),
  mapLoading:      $('map-loading'),
  updateBanner:    $('update-banner'),
  updateText:      $('update-text'),
  updateRefresh:   $('update-refresh-btn'),
  updateDismiss:   $('update-dismiss-btn'),
  sidebar:         $('sidebar'),
  sidebarToggle:   $('sidebar-toggle'),
  mobilePanelBtn:  $('mobile-panel-btn'),
  backdrop:        $('mobile-backdrop'),
  // --- Location tracking ---
  locationToggle:  $('location-toggle'),
  trackingStatus:  $('tracking-status'),
  statusDot:       $('status-dot'),
  statusText:      $('status-text'),
  proximityAlerts: $('proximity-alerts'),
  notifBadge:      $('notif-badge'),
  notifBadgeIcon:  $('notif-badge-icon'),
  // --- Speed HUD ---
  speedHud:        $('speed-hud'),
  speedValue:      $('speed-value'),
  speedCorridor:   $('speed-corridor'),
  reqValue:        $('req-value'),
  corridorProgBar: $('corridor-progress-bar'),
  corridorHudName: $('corridor-hud-name'),
};

/* =====================================================
   SESSION PERSISTENCE
   Survive background kills by writing state to sessionStorage.
   ===================================================== */
const STORAGE_KEY    = 'rk_state_v1';
const STORAGE_MAX_MS = 2 * 60 * 60 * 1000; // 2 saat — daha eski kaydı yok say

function persistState() {
  if (!State.routeData) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      ts:               Date.now(),
      routeData:        State.routeData,
      fromDistrict:     State.fromDistrict,
      toDistrict:       State.toDistrict,
      corridorProgress: Array.from(State.corridorProgress.entries()),
      activeCorridors:  Array.from(State.activeCorridors),
      trackingWasOn:    els.locationToggle.checked,
    }));
  } catch (_) { /* storage full or unavailable */ }
}

function tryRestoreState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const saved = JSON.parse(raw);
    if (Date.now() - saved.ts > STORAGE_MAX_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }

    // Restore in-memory state
    State.routeData     = saved.routeData;
    State.fromDistrict  = saved.fromDistrict;
    State.toDistrict    = saved.toDistrict;

    // Corridor progress: entryTime is absolute timestamp — math stays correct
    // Set lastLat/lastLon to null so the first GPS update doesn’t cause a jump
    const restoredProgress = (saved.corridorProgress || []).map(([id, prog]) => [
      id, { ...prog, lastLat: null, lastLon: null }
    ]);
    State.corridorProgress = new Map(restoredProgress);
    State.activeCorridors  = new Set(saved.activeCorridors || []);

    // Re-render map + stats without a new API call
    renderMap(State.routeData);
    renderStats(State.routeData);
    startAutoUpdate();

    // Re-enable tracking if it was on before background
    if (saved.trackingWasOn) {
      els.locationToggle.checked = true;
      startTracking();
    }

    showToast('Önceki rota geri yüklendi ✅', 'info');
  } catch (_) { /* corrupt storage — start fresh */ }
}

/* =====================================================
   INIT — Load cities
   ===================================================== */
async function init() {
  try {
    State.cities = await API.getCities();
    populateCitySelect(els.fromCity, State.cities);
    populateCitySelect(els.toCity, State.cities);
    els.fromCity.disabled = false;
    els.toCity.disabled = false;

    // Restore previous session state (if any)
    tryRestoreState();
  } catch (err) {
    showToast('Şehirler yüklenirken hata oluştu: ' + err.message, 'error');
  }
}

/* =====================================================
   UI HELPERS
   ===================================================== */
function populateCitySelect(selectEl, cities) {
  selectEl.innerHTML = '<option value="">İl Seçin</option>';
  cities.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.Id;
    opt.textContent = c.Name;
    selectEl.appendChild(opt);
  });
}

function populateDistrictSelect(selectEl, districts) {
  selectEl.innerHTML = '<option value="">İlçe Seçin</option>';
  districts.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.Id;
    opt.textContent = d.Name;
    selectEl.appendChild(opt);
  });
  selectEl.disabled = false;
}

function setLoading(on) {
  State.isLoading = on;
  els.routeBtn.classList.toggle('loading', on);
  els.btnLabel.classList.toggle('hidden', on);
  els.btnSpinner.classList.toggle('hidden', !on);
  els.mapLoading.classList.toggle('hidden', !on);
}

function updateRouteBtn() {
  els.routeBtn.disabled = !(State.fromDistrict && State.toDistrict);
}

function formatTime(date) {
  return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function showUpdateBanner(message) {
  els.updateText.textContent = message;
  els.updateBanner.classList.remove('hidden');
}

function hideUpdateBanner() {
  els.updateBanner.classList.add('hidden');
}

/* =====================================================
   STATS PANEL
   ===================================================== */
function renderStats(data) {
  els.statsRouteName.textContent = `${data.FromDistrict} → ${data.ToDistrict}`;
  els.statRadars.textContent = data.RadarCount;
  els.statCheckpoints.textContent = data.ControlPointCount;
  els.statCorridors.textContent = data.CorridorCount;
  els.lastUpdated.textContent = `Son güncelleme: ${formatTime(new Date())}`;

  // City breakdown
  els.cityList.innerHTML = '';
  data.Cities.forEach((city) => {
    const row = document.createElement('div');
    row.className = 'city-row';
    const hasRadar = city.Radarli > 0;
    const hasControl = city.Radarsiz > 0;
    row.innerHTML = `
      <span class="city-name">${city.City}</span>
      <div class="city-badges">
        ${hasRadar   ? `<span class="badge badge-radar">📷 ${city.Radarli}</span>` : ''}
        ${hasControl ? `<span class="badge badge-control">🚔 ${city.Radarsiz}</span>` : ''}
        ${!hasRadar && !hasControl ? '<span class="badge badge-none">Temiz</span>' : ''}
      </div>`;
    els.cityList.appendChild(row);
  });

  els.statsPanel.classList.remove('hidden');
}

/* =====================================================
   MAP RENDERING
   ===================================================== */
function clearMap() {
  layers.route.clearLayers();
  layers.corridors.clearLayers();
  layers.markers.clearLayers();
}

function renderMap(data) {
  clearMap();

  // ---- 1. Main route polyline (blue) ----
  if (data.Coordinates && data.Coordinates.length > 0) {
    const routeLatLngs = data.Coordinates.map((p) => [p.y, p.x]);
    L.polyline(routeLatLngs, {
      color: '#3b82f6',
      weight: 5,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(layers.route);
  }

  // ---- 2. Speed corridor polylines (red) ----
  if (data.SpeedTunnels && data.SpeedTunnels.length > 0) {
    data.SpeedTunnels.forEach((tunnel) => {
      if (!tunnel.coordinates || tunnel.coordinates.length === 0) return;

      const corridorLatLngs = tunnel.coordinates.map((p) => [p.y, p.x]);
      const polyline = L.polyline(corridorLatLngs, {
        color: '#ef4444',
        weight: 6,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(layers.corridors);

      // Midpoint marker for corridor
      const midIdx = Math.floor(corridorLatLngs.length / 2);
      const midPoint = corridorLatLngs[midIdx];

      const corridorIcon = L.divIcon({
        html: `<div class="corridor-marker">
                 <span class="corridor-speed">${tunnel.speedLimit}</span>
                 <span class="corridor-unit">km/h</span>
               </div>`,
        className: '',
        iconSize: [54, 36],
        iconAnchor: [27, 18],
        popupAnchor: [0, -20],
      });

      L.marker(midPoint, { icon: corridorIcon })
        .bindPopup(buildCorridorPopup(tunnel))
        .addTo(layers.corridors);
    });
  }

  // ---- 3. Radar markers ----
  if (data.Radars && data.Radars.length > 0) {
    data.Radars.forEach((radar) => {
      L.marker([radar.Latitude, radar.Longitude], { icon: radarIcon })
        .bindPopup(buildRadarPopup(radar))
        .addTo(layers.markers);
    });
  }

  // ---- 4. Fit bounds ----
  const allPoints = [];
  if (data.Coordinates?.length) {
    data.Coordinates.forEach((p) => allPoints.push([p.y, p.x]));
  }
  if (allPoints.length > 1) {
    map.fitBounds(L.latLngBounds(allPoints).pad(0.08));
  }
}

function buildCorridorPopup(tunnel) {
  const name = (tunnel.name || '').trim();
  const direction = tunnel.direction ? `<div class="popup-row"><span>Yön</span><span>${tunnel.direction}</span></div>` : '';
  return `
    <div class="popup-header">
      <span class="popup-icon">⚡</span>
      <span class="popup-title">Hız Koridoru</span>
    </div>
    <div class="popup-body">
      <div class="popup-row"><span>Ad</span><span>${name || '—'}</span></div>
      <div class="popup-row"><span>İl</span><span>${tunnel.provinceName || '—'}</span></div>
      <div class="popup-row"><span>Uzunluk</span><span>${tunnel.length} km</span></div>
      ${direction}
      <div class="popup-row" style="margin-top:8px">
        <span>Hız Limiti</span>
        <span class="popup-badge-speed">${tunnel.speedLimit} km/h</span>
      </div>
    </div>`;
}

function buildRadarPopup(radar) {
  return `
    <div class="popup-header">
      <span class="popup-icon">📷</span>
      <span class="popup-title">Radar</span>
    </div>
    <div class="popup-body">
      <div class="popup-row"><span>Konum</span><span>${radar.ProvinceName || '—'}, ${radar.DistrictName || '—'}</span></div>
      ${radar.SpeedLimit ? `<div class="popup-row"><span>Hız Limiti</span><span class="popup-badge-speed">${radar.SpeedLimit} km/h</span></div>` : ''}
      ${radar.Direction ? `<div class="popup-row"><span>Yön</span><span>${radar.Direction}</span></div>` : ''}
    </div>`;
}

const corridorStyle = document.createElement('style');
corridorStyle.textContent = `
  .corridor-marker {
    background: #ef4444;
    border: 2px solid rgba(255,255,255,0.3);
    border-radius: 8px;
    padding: 4px 8px;
    display: flex; flex-direction: column; align-items: center;
    box-shadow: 0 2px 8px rgba(239,68,68,.5);
    cursor: pointer;
  }
  .corridor-speed {
    font-family: 'Outfit', sans-serif;
    font-size: 14px; font-weight: 700;
    color: #fff; line-height: 1;
  }
  .corridor-unit {
    font-family: 'Outfit', sans-serif;
    font-size: 9px; color: rgba(255,255,255,.7);
    line-height: 1;
  }
`;
document.head.appendChild(corridorStyle);

/* =====================================================
   DISTANCE MATH
   ===================================================== */

/**
 * Haversine formula — returns distance in metres between two lat/lon points.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Minimum distance (metres) from a point to a line segment (A→B).
 * All inputs are lat/lon.
 */
function pointToSegmentDist(pLat, pLon, aLat, aLon, bLat, bLon) {
  const dx = bLon - aLon;
  const dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return haversineDistance(pLat, pLon, aLat, aLon);
  const t = Math.max(0, Math.min(1, ((pLon - aLon) * dx + (pLat - aLat) * dy) / lenSq));
  return haversineDistance(pLat, pLon, aLat + t * dy, aLon + t * dx);
}

/**
 * Minimum distance (metres) from user position to an entire corridor polyline.
 * Uses a bounding-box pre-filter for performance.
 */
function distanceToCorridor(userLat, userLon, corridor) {
  const coords = corridor.coordinates;
  if (!coords || coords.length === 0) return Infinity;

  // Bounding box pre-filter (~10 km margin)
  const MARGIN = 0.09;
  const lats = coords.map((c) => c.y);
  const lons = coords.map((c) => c.x);
  const minLat = Math.min(...lats) - MARGIN;
  const maxLat = Math.max(...lats) + MARGIN;
  const minLon = Math.min(...lons) - MARGIN;
  const maxLon = Math.max(...lons) + MARGIN;

  if (userLat < minLat || userLat > maxLat || userLon < minLon || userLon > maxLon) {
    return Infinity;
  }

  let minDist = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(
      userLat, userLon,
      coords[i].y, coords[i].x,
      coords[i + 1].y, coords[i + 1].x
    );
    if (d < minDist) minDist = d;
    // Early exit if already very close
    if (minDist < 20) break;
  }
  return minDist;
}

/* =====================================================
   NOTIFICATION MODULE
   ===================================================== */
const NOTIF_SUPPORTED   = 'Notification' in window;
const COOLDOWN_MS       = 5 * 60 * 1000;  // 5 dakika — aynı uyarı tekrar etmez
const RADAR_WARN_M      = 500;             // metre — radara bu kadar yaklaşınca uyar
const CORRIDOR_ENTER_M  = 80;              // metre — koridora bu kadar yakınınca uyar
const CORRIDOR_EXIT_M   = 200;             // koridordan bu kadar uzaklaşınca çıktı say


function updateNotifBadge() {
  if (!NOTIF_SUPPORTED) {
    // Bildirim desteklenmiyor (iOS Safari vs.) — badge gizle
    els.notifBadge.classList.add('hidden');
    return;
  }
  const perm = Notification.permission;
  els.notifBadge.className = 'notif-badge ' + perm;
  if (perm === 'granted') {
    els.notifBadgeIcon.textContent = '\uD83D\uDD14';
    els.notifBadge.title = 'Bildirimler açık';
  } else if (perm === 'denied') {
    els.notifBadgeIcon.textContent = '\uD83D\uDD15';
    els.notifBadge.title = 'Bildirimler kapalı — ekran uyarısı kullanılıyor';
  } else {
    els.notifBadgeIcon.textContent = '\uD83D\uDD14';
    els.notifBadge.title = 'Bildirim izni bekleniyor';
  }
}

async function requestNotificationPermission() {
  if (!NOTIF_SUPPORTED) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  updateNotifBadge();
}

/**
 * Fire a browser notification or show an in-app alert banner.
 * tag: unique string — prevents duplicate notifications.
 * cooldown: ms to wait before re-alerting with same tag.
 */
function fireAlert({ tag, title, body, type = 'radar', cooldown = COOLDOWN_MS }) {
  const now = Date.now();
  const lastTime = State.alertCooldowns.get(tag) || 0;
  if (now - lastTime < cooldown) return;
  State.alertCooldowns.set(tag, now);

  if (NOTIF_SUPPORTED && Notification.permission === 'granted') {
    const n = new Notification(title, {
      body,
      icon: '/icons/radar.png',
      tag,
      vibrate: [200, 100, 200],
      requireInteraction: false,
    });
    setTimeout(() => n.close(), 8000);
  } else {
    showInAppAlert(title, body, type);
  }
}

let _inAppAlertTimer = null;
function showInAppAlert(title, body, type = 'radar') {
  // Remove existing alert if present
  document.querySelector('.inapp-alert')?.remove();
  if (_inAppAlertTimer) clearTimeout(_inAppAlertTimer);

  const el = document.createElement('div');
  el.className = `inapp-alert ${type === 'corridor' ? 'corridor-alert' : 'radar-alert'}`;
  el.innerHTML = `
    <div class="alert-icon">${type === 'corridor' ? '⚡' : '📷'}</div>
    <div class="alert-body">
      <div class="alert-title">${title}</div>
      <div class="alert-sub">${body}</div>
    </div>
  `;
  document.body.appendChild(el);
  _inAppAlertTimer = setTimeout(() => el.remove(), 6000);
}

/* =====================================================
   USER LOCATION MARKER
   ===================================================== */
const userLocationIcon = L.divIcon({
  html: `<div class="user-location-marker">
           <div class="user-location-ring"></div>
           <div class="user-location-dot"></div>
         </div>`,
  className: '',
  iconSize: [40, 40],
  iconAnchor: [20, 20],
});

function updateUserMarker(lat, lon) {
  if (State.userMarker) {
    State.userMarker.setLatLng([lat, lon]);
  } else {
    State.userMarker = L.marker([lat, lon], {
      icon: userLocationIcon,
      zIndexOffset: 1000,
    }).addTo(layers.user);
  }
}

/* =====================================================
   PROXIMITY ALERTS PANEL (sidebar chips)
   ===================================================== */
function updateProximityPanel(nearbyItems) {
  els.proximityAlerts.innerHTML = '';
  if (nearbyItems.length === 0) return;

  nearbyItems.forEach(({ icon, text, dist, type, active }) => {
    const chip = document.createElement('div');
    chip.className = `proximity-chip ${type}-chip${active ? ' active-corridor' : ''}`;
    const distStr = dist < 1000
      ? `${Math.round(dist)} m`
      : `${(dist / 1000).toFixed(1)} km`;
    chip.innerHTML = `
      <span class="chip-icon">${icon}</span>
      <span class="chip-text">${text}</span>
      <span class="chip-dist">${active ? 'İÇİNDE' : distStr}</span>
    `;
    els.proximityAlerts.appendChild(chip);
  });
}

/* =====================================================
   PROXIMITY CHECKER — called on every GPS update
   Returns a Set of corridor IDs we're currently inside.
   ===================================================== */
function checkProximityWithIds(lat, lon) {
  const activeIds = new Set();
  if (!State.routeData) return activeIds;

  const { SpeedTunnels = [], Radars = [] } = State.routeData;
  const nearbyItems = [];

  // ---- 1. Speed corridors ----
  SpeedTunnels.forEach((tunnel) => {
    const dist = distanceToCorridor(lat, lon, tunnel);
    const tag  = `corridor-${tunnel.id}`;
    const name = (tunnel.name || '').trim();
    const wasInside = State.activeCorridors.has(tunnel.id);

    if (dist <= CORRIDOR_ENTER_M) {
      activeIds.add(tunnel.id);
      nearbyItems.push({ icon: '⚡', text: `${name} · ${tunnel.speedLimit} km/h`, dist, type: 'corridor', active: true });

      if (!wasInside) {
        State.activeCorridors.add(tunnel.id);
        fireAlert({ tag, title: '⚡ Hız Koridoruna Girdiniz!', body: `${name} — Limit: ${tunnel.speedLimit} km/h`, type: 'corridor', cooldown: COOLDOWN_MS });
      }
    } else if (dist <= RADAR_WARN_M) {
      nearbyItems.push({ icon: '⚡', text: `${name} · ${tunnel.speedLimit} km/h`, dist, type: 'corridor', active: false });

      if (!wasInside) {
        fireAlert({ tag: `${tag}-approach`, title: '⚠️ Hız Koridoru Yaklaşıyor', body: `${Math.round(dist)} m uzakta · ${name} · ${tunnel.speedLimit} km/h`, type: 'corridor', cooldown: COOLDOWN_MS });
      }
    } else if (wasInside && dist > CORRIDOR_EXIT_M) {
      State.activeCorridors.delete(tunnel.id);
    }
  });

  // ---- 2. Radars ----
  Radars.forEach((radar) => {
    if (!radar.Latitude || !radar.Longitude) return;
    const dist = haversineDistance(lat, lon, radar.Latitude, radar.Longitude);
    const tag  = `radar-${radar.Id || radar.id}`;

    if (dist <= RADAR_WARN_M) {
      nearbyItems.push({ icon: '📷', text: `Radar · ${radar.ProvinceName || ''} ${radar.DistrictName || ''}`.trim(), dist, type: 'radar', active: dist <= 100 });
      fireAlert({ tag, title: '📷 Radar Var!', body: `${Math.round(dist)} m uzakta${radar.SpeedLimit ? ' · Limit: ' + radar.SpeedLimit + ' km/h' : ''}`, type: 'radar', cooldown: COOLDOWN_MS });
    }
  });

  nearbyItems.sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : a.dist - b.dist));
  updateProximityPanel(nearbyItems);

  return activeIds;
}

// Alias for the auto-update path (no return value needed)
function checkProximity(lat, lon) { checkProximityWithIds(lat, lon); }

/**
 * From the active corridor IDs, find the one where the driver
 * needs the highest speed to stay legal — most critical first.
 */
function getMostCriticalCorridor(activeIds) {
  if (!State.routeData || activeIds.size === 0) return null;
  const { SpeedTunnels = [] } = State.routeData;

  let worst = null;
  let worstReqSpeed = -Infinity;

  activeIds.forEach((id) => {
    const tunnel = SpeedTunnels.find((t) => t.id === id);
    if (!tunnel) return;

    const prog = State.corridorProgress.get(id);
    if (!prog) { worst = worst || tunnel; return; }

    const corridorLenKm   = tunnel.length;
    const distTraveledKm  = Math.min(prog.distanceKm, corridorLenKm);
    const remainingKm     = Math.max(0, corridorLenKm - distTraveledKm);
    const totalTimeHr     = corridorLenKm / tunnel.speedLimit;
    const elapsedTimeHr   = (Date.now() - prog.entryTime) / 3_600_000;
    const remainingTimeHr = totalTimeHr - elapsedTimeHr;
    const reqSpeed        = remainingTimeHr > 0 ? remainingKm / remainingTimeHr : Infinity;

    if (reqSpeed > worstReqSpeed) {
      worstReqSpeed = reqSpeed;
      worst = tunnel;
    }
  });

  return worst;
}



/* =====================================================
   SPEED HUD
   ===================================================== */

/**
 * Update the speed HUD with current GPS speed.
 * speedMs: m/s from GPS (can be null).
 * activeTunnel: the most critical corridor we’re inside (or null).
 */
function updateSpeedHUD(speedMs, activeTunnel) {
  const speedKmh = (speedMs != null && speedMs >= 0)
    ? Math.round(speedMs * 3.6)
    : null;

  // Show/hide HUD
  els.speedHud.classList.toggle('hidden', speedKmh === null);
  if (speedKmh === null) return;

  // Current speed display
  els.speedValue.textContent = speedKmh;

  // Color based on active corridor limit
  els.speedValue.className = 'speed-value';
  if (activeTunnel) {
    const limit = activeTunnel.speedLimit;
    if (speedKmh <= limit)            els.speedValue.classList.add('speed-ok');
    else if (speedKmh <= limit * 1.1) els.speedValue.classList.add('speed-warn');
    else                               els.speedValue.classList.add('speed-danger');
  }

  // Corridor required speed panel
  if (!activeTunnel) {
    els.speedCorridor.classList.add('hidden');
    return;
  }

  els.speedCorridor.classList.remove('hidden');

  const prog = State.corridorProgress.get(activeTunnel.id);
  if (!prog) return;

  const corridorLenKm   = activeTunnel.length;              // total length (km)
  const distTraveledKm  = Math.min(prog.distanceKm, corridorLenKm);
  const remainingKm     = Math.max(0, corridorLenKm - distTraveledKm);
  const totalTimeHr     = corridorLenKm / activeTunnel.speedLimit;  // min time to pass legally
  const elapsedTimeHr   = (Date.now() - prog.entryTime) / 3_600_000;
  const remainingTimeHr = totalTimeHr - elapsedTimeHr;

  // Progress bar
  const pct = Math.min(100, (distTraveledKm / corridorLenKm) * 100);
  els.corridorProgBar.style.width = pct + '%';

  // Corridor name
  const name = (activeTunnel.name || '').trim();
  els.corridorHudName.textContent = name || '';

  // Required speed
  els.reqValue.className = 'req-value';
  if (remainingTimeHr <= 0 || remainingKm <= 0) {
    // Already through or overtime
    els.reqValue.textContent = '✔';
    els.reqValue.classList.add('req-ok');
    return;
  }

  const reqSpeed = Math.round(remainingKm / remainingTimeHr);

  if (reqSpeed <= 0 || !isFinite(reqSpeed)) {
    els.reqValue.textContent = '--';
    return;
  }

  els.reqValue.textContent = reqSpeed;

  if      (reqSpeed <= activeTunnel.speedLimit * 0.9)  els.reqValue.classList.add('req-ok');
  else if (reqSpeed <= activeTunnel.speedLimit)         els.reqValue.classList.add('req-caution');
  else if (reqSpeed <= activeTunnel.speedLimit * 1.15)  els.reqValue.classList.add('req-danger');
  else {
    // Impossible to compensate — already over average
    els.reqValue.textContent = '⚠ Limit aşıldı';
    els.reqValue.classList.add('req-over');
  }
}

/**
 * Track distance traveled inside each active corridor.
 * Called on every GPS update.
 */
function updateCorridorProgress(lat, lon, activeCorridorIds) {
  activeCorridorIds.forEach((id) => {
    if (!State.corridorProgress.has(id)) {
      // First time we see this corridor — initialise tracker
      State.corridorProgress.set(id, {
        entryTime:  Date.now(),
        distanceKm: 0,
        lastLat:    lat,
        lastLon:    lon,
      });
    } else {
      const prog = State.corridorProgress.get(id);

      // lastLat is null when restored from background — just sync position, no distance added
      if (prog.lastLat === null || prog.lastLon === null) {
        prog.lastLat = lat;
        prog.lastLon = lon;
        return;
      }

      const segKm = haversineDistance(lat, lon, prog.lastLat, prog.lastLon) / 1000;
      // Sanity check: ignore jumps > 1 km (GPS glitch or large background gap)
      if (segKm < 1) prog.distanceKm += segKm;
      prog.lastLat = lat;
      prog.lastLon = lon;
    }
  });

  // Clean up corridors we've left
  for (const id of State.corridorProgress.keys()) {
    if (!activeCorridorIds.has(id) && !State.activeCorridors.has(id)) {
      State.corridorProgress.delete(id);
    }
  }
}


/* =====================================================
   GEOLOCATION MODULE
   ===================================================== */
function startTracking() {
  if (!navigator.geolocation) {
    showToast('Tarayıcınız konum özelliğini desteklemiyor.', 'error');
    els.locationToggle.checked = false;
    return;
  }

  els.trackingStatus.classList.remove('hidden');
  els.statusDot.className = 'status-dot';
  els.statusText.textContent = 'Konum alınıyor…';

  State.watchId = navigator.geolocation.watchPosition(
    // Success
    (pos) => {
      const { latitude: lat, longitude: lon, speed } = pos.coords;
      State.userPosition = { lat, lon };

      // Update marker
      updateUserMarker(lat, lon);

      // Update status
      els.statusDot.className = 'status-dot active';
      els.statusText.textContent =
        `Takip aktif · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;

      // Check proximity — returns active corridor IDs
      const activeIds = checkProximityWithIds(lat, lon);

      // Update corridor progress tracking
      updateCorridorProgress(lat, lon, activeIds);

      // Find most critical active corridor for HUD
      const activeTunnel = getMostCriticalCorridor(activeIds);

      // Update speed HUD
      updateSpeedHUD(speed, activeTunnel);
    },
    // Error
    (err) => {
      els.statusDot.className = 'status-dot error';
      const msgs = {
        1: 'Konum izni reddedildi.',
        2: 'Konum alınamadı.',
        3: 'Konum zaman aşımı.',
      };
      els.statusText.textContent = msgs[err.code] || 'Konum hatası.';
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    }
  );
}

function stopTracking() {
  if (State.watchId !== null) {
    navigator.geolocation.clearWatch(State.watchId);
    State.watchId = null;
  }
  State.userPosition = null;
  State.activeCorridors.clear();
  State.alertCooldowns.clear();
  State.corridorProgress.clear();

  layers.user.clearLayers();
  State.userMarker = null;

  els.trackingStatus.classList.add('hidden');
  els.proximityAlerts.innerHTML = '';
  els.statusDot.className = 'status-dot';
  els.statusText.textContent = 'Konum alınıyor…';
  els.speedHud.classList.add('hidden');

  // Update stored state so tracking doesn’t auto-restart on next load
  persistState();
}

/* =====================================================
   AUTO-UPDATE (30 min)
   ===================================================== */
function startAutoUpdate() {
  if (State.updateTimer) clearInterval(State.updateTimer);
  // 30 dakika = 1800000 ms
  State.updateTimer = setInterval(async () => {
    if (!State.fromDistrict || !State.toDistrict) return;
    try {
      const result = await API.createRoute(State.fromDistrict, State.toDistrict);
      if (result.success) {
        State.pendingUpdate = result.data;
        showUpdateBanner('🔄 Yeni radar verisi mevcut! Yenile');
      }
    } catch (_) {
      // Silent fail — will retry next cycle
    }
  }, 30 * 60 * 1000);
}

function stopAutoUpdate() {
  if (State.updateTimer) {
    clearInterval(State.updateTimer);
    State.updateTimer = null;
  }
}

/* =====================================================
   CREATE ROUTE
   ===================================================== */
async function createRoute() {
  if (!State.fromDistrict || !State.toDistrict) return;
  if (State.isLoading) return;

  setLoading(true);
  hideUpdateBanner();

  // Request notification permission on first route creation
  await requestNotificationPermission();

  try {
    const result = await API.createRoute(State.fromDistrict, State.toDistrict);
    if (!result.success) throw new Error(result.message || 'Bilinmeyen hata');

    State.routeData = result.data;
    State.lastFetchTime = new Date();
    State.pendingUpdate = null;
    // Reset corridor tracking on new route
    State.activeCorridors.clear();
    State.alertCooldowns.clear();
    State.corridorProgress.clear();


    renderMap(result.data);
    renderStats(result.data);

    // Re-check proximity immediately with new route data
    if (State.userPosition) {
      checkProximity(State.userPosition.lat, State.userPosition.lon);
    }

    // Auto-update
    startAutoUpdate();

    // On mobile, hide sidebar after route
    if (window.innerWidth <= 768) {
      els.sidebar.classList.add('mobile-hidden');
      els.backdrop.classList.add('hidden');
    }

  } catch (err) {
    showToast('Rota oluşturulurken hata: ' + err.message, 'error');
  } finally {
    setLoading(false);
  }
}

/* =====================================================
   TOAST (simple)
   ===================================================== */
function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  const color = type === 'error' ? '#ef4444' : '#3b82f6';
  toast.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #1a2235; border: 1px solid ${color};
    color: #f1f5f9; padding: 12px 20px; border-radius: 12px;
    font-family: 'Outfit', sans-serif; font-size: 14px;
    box-shadow: 0 4px 24px rgba(0,0,0,.5); z-index: 9999;
    animation: fadeIn 0.3s ease; max-width: calc(100vw - 48px);
    text-align: center;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

/* =====================================================
   EVENT LISTENERS
   ===================================================== */

// From city change
els.fromCity.addEventListener('change', async () => {
  const cityId = els.fromCity.value;
  State.fromDistrict = null;
  els.fromDistrict.innerHTML = '<option value="">Yükleniyor…</option>';
  els.fromDistrict.disabled = true;
  updateRouteBtn();

  if (!cityId) {
    els.fromDistrict.innerHTML = '<option value="">İlçe Seçin</option>';
    return;
  }
  try {
    State.fromDistricts = await API.getDistricts(cityId);
    populateDistrictSelect(els.fromDistrict, State.fromDistricts);
  } catch (err) {
    showToast('İlçeler yüklenemedi.', 'error');
  }
});

// From district change
els.fromDistrict.addEventListener('change', () => {
  const id = parseInt(els.fromDistrict.value);
  State.fromDistrict = State.fromDistricts.find((d) => d.Id === id) || null;
  updateRouteBtn();
});

// To city change
els.toCity.addEventListener('change', async () => {
  const cityId = els.toCity.value;
  State.toDistrict = null;
  els.toDistrict.innerHTML = '<option value="">Yükleniyor…</option>';
  els.toDistrict.disabled = true;
  updateRouteBtn();

  if (!cityId) {
    els.toDistrict.innerHTML = '<option value="">İlçe Seçin</option>';
    return;
  }
  try {
    State.toDistricts = await API.getDistricts(cityId);
    populateDistrictSelect(els.toDistrict, State.toDistricts);
  } catch (err) {
    showToast('İlçeler yüklenemedi.', 'error');
  }
});

// To district change
els.toDistrict.addEventListener('change', () => {
  const id = parseInt(els.toDistrict.value);
  State.toDistrict = State.toDistricts.find((d) => d.Id === id) || null;
  updateRouteBtn();
});

// Route button
els.routeBtn.addEventListener('click', createRoute);

// Swap button
$('swap-btn').addEventListener('click', () => {
  // Swap city selects
  const fromCityVal = els.fromCity.value;
  const toCityVal   = els.toCity.value;

  // Swap districts state
  const tmpDistricts   = State.fromDistricts;
  State.fromDistricts  = State.toDistricts;
  State.toDistricts    = tmpDistricts;

  const tmpDistrict    = State.fromDistrict;
  State.fromDistrict   = State.toDistrict;
  State.toDistrict     = tmpDistrict;

  // Repopulate
  els.fromCity.value = toCityVal;
  els.toCity.value   = fromCityVal;

  populateDistrictSelect(els.fromDistrict, State.fromDistricts);
  populateDistrictSelect(els.toDistrict, State.toDistricts);

  if (State.fromDistrict) {
    els.fromDistrict.value = State.fromDistrict.Id;
  }
  if (State.toDistrict) {
    els.toDistrict.value = State.toDistrict.Id;
  }

  // Enable/disable dropdowns
  if (!toCityVal)   { els.fromDistrict.disabled = true; els.fromDistrict.innerHTML = '<option value="">İlçe Seçin</option>'; }
  if (!fromCityVal) { els.toDistrict.disabled = true;   els.toDistrict.innerHTML = '<option value="">İlçe Seçin</option>'; }

  updateRouteBtn();
});

// Sidebar toggle (desktop)
els.sidebarToggle.addEventListener('click', () => {
  els.sidebar.classList.toggle('collapsed');
});

// Mobile panel button
els.mobilePanelBtn.addEventListener('click', () => {
  const isHidden = els.sidebar.classList.toggle('mobile-hidden');
  // Show/hide backdrop
  if (window.innerWidth <= 768) {
    els.backdrop.classList.toggle('hidden', isHidden);
  }
});

// Backdrop click — close sidebar
els.backdrop.addEventListener('click', () => {
  els.sidebar.classList.add('mobile-hidden');
  els.backdrop.classList.add('hidden');
});

// Update banner — refresh
els.updateRefresh.addEventListener('click', () => {
  if (State.pendingUpdate) {
    State.routeData = State.pendingUpdate;
    State.pendingUpdate = null;
    renderMap(State.routeData);
    renderStats(State.routeData);
  } else {
    // Re-fetch
    createRoute();
  }
  hideUpdateBanner();
});

// Update banner — dismiss
els.updateDismiss.addEventListener('click', hideUpdateBanner);

// Location tracking toggle
els.locationToggle.addEventListener('change', () => {
  if (els.locationToggle.checked) {
    startTracking();
  } else {
    stopTracking();
  }
});

/* =====================================================
   START
   ===================================================== */
updateNotifBadge();
init();

// Persist state every 15 seconds
setInterval(persistState, 15_000);

// Persist when going to background; reset GPS positions when coming back
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    persistState();
  } else {
    // Coming back from background: null out lastLat/lastLon
    // so the next GPS fix doesn’t create a phantom distance jump
    State.corridorProgress.forEach((prog) => {
      prog.lastLat = null;
      prog.lastLon = null;
    });
  }
});
