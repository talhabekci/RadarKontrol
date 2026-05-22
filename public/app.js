/**
 * RadarKontrol — app.js
 * Vanilla JS, Leaflet.js
 * API proxy: /api/* → icisleri.gov.tr
 */

/* =====================================================
   STATE
   ===================================================== */
const State = {
  cities: [],                  // [{Id, Name}]
  fromDistricts: [],           // [{Id, Name, Latitude, Longitude}]
  toDistricts: [],
  fromDistrict: null,          // selected district object
  toDistrict: null,
  routeData: null,             // last API response data
  lastFetchTime: null,
  updateTimer: null,
  pendingUpdate: null,         // new routeData awaiting user confirm
  isLoading: false,
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
  fromCity:       $('from-city'),
  fromDistrict:   $('from-district'),
  toCity:         $('to-city'),
  toDistrict:     $('to-district'),
  routeBtn:       $('route-btn'),
  btnLabel:       document.querySelector('.btn-label'),
  btnSpinner:     document.querySelector('.btn-spinner'),
  statsPanel:     $('stats-panel'),
  statsRouteName: $('stats-route-name'),
  statRadars:     $('stat-radars'),
  statCheckpoints:$('stat-checkpoints'),
  statCorridors:  $('stat-corridors'),
  cityList:       $('city-list'),
  lastUpdated:    $('last-updated'),
  mapLoading:     $('map-loading'),
  updateBanner:   $('update-banner'),
  updateText:     $('update-text'),
  updateRefresh:  $('update-refresh-btn'),
  updateDismiss:  $('update-dismiss-btn'),
  sidebar:        $('sidebar'),
  sidebarToggle:  $('sidebar-toggle'),
  mobilePanelBtn: $('mobile-panel-btn'),
};

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

/* =====================================================
   CORRIDOR MARKER CSS (injected)
   ===================================================== */
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

  try {
    const result = await API.createRoute(State.fromDistrict, State.toDistrict);
    if (!result.success) throw new Error(result.message || 'Bilinmeyen hata');

    State.routeData = result.data;
    State.lastFetchTime = new Date();
    State.pendingUpdate = null;

    renderMap(result.data);
    renderStats(result.data);

    // Auto-update
    startAutoUpdate();

    // On mobile, hide sidebar after route
    if (window.innerWidth <= 768) {
      els.sidebar.classList.add('mobile-hidden');
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
  els.sidebar.classList.toggle('mobile-hidden');
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

/* =====================================================
   START
   ===================================================== */
init();
