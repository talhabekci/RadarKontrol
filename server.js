const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = 'https://www.icisleri.gov.tr/ISAYWebPart/PolGenControlPointV2';

const PROXY_HEADERS = {
  'Referer': 'https://www.icisleri.gov.tr/iller-arasi-radar-ve-kontrol-noktasi-uygulama-sayilari',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.icisleri.gov.tr',
};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/GetCities
app.get('/api/GetCities', async (req, res) => {
  try {
    const response = await fetch(`${BASE_URL}/GetCities`, {
      headers: PROXY_HEADERS,
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('GetCities error:', err.message);
    res.status(500).json({ error: 'API isteği başarısız oldu.' });
  }
});

// GET /api/GetDistricts?cityId=X
app.get('/api/GetDistricts', async (req, res) => {
  const { cityId } = req.query;
  if (!cityId) return res.status(400).json({ error: 'cityId gerekli.' });
  try {
    const response = await fetch(`${BASE_URL}/GetDistricts?cityId=${cityId}`, {
      headers: PROXY_HEADERS,
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('GetDistricts error:', err.message);
    res.status(500).json({ error: 'API isteği başarısız oldu.' });
  }
});

// POST /api/CreateRoute
app.post('/api/CreateRoute', async (req, res) => {
  const { fromLatitude, fromLongitude, toLatitude, toLongitude, fromDistrictId, toDistrictId } = req.body;

  if (!fromDistrictId || !toDistrictId) {
    return res.status(400).json({ error: 'fromDistrictId ve toDistrictId gerekli.' });
  }

  const formData = new URLSearchParams({
    fromLatitude,
    fromLongitude,
    toLatitude,
    toLongitude,
    fromDistrictId,
    toDistrictId,
  });

  try {
    const response = await fetch(`${BASE_URL}/CreateRoute`, {
      method: 'POST',
      headers: {
        ...PROXY_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('CreateRoute error:', err.message);
    res.status(500).json({ error: 'Rota oluşturma başarısız oldu.' });
  }
});

// SPA fallback
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 RadarKontrol çalışıyor → http://localhost:${PORT}\n`);
});
