// Takıl Dev Server — Lokal HTML + Canlı VPS API proxy
// Kullanım: node dev-server.js
// URL: http://localhost:8765
//
// - /api/worldly/* → Overpass'ten gerçek mekan (her ortamda lokal işlenir)
// - /api/* istekleri → https://178-105-90-130.nip.io/api/* (sadece DISABLE_API_PROXY set değilse)
// - Diğer her şey → lokaldeki dosyalardan servis
// - WebSocket / PeerJS direkt connect olabilir
//
// ⚙️ Ortam değişkenleri:
//   PORT               — dinlenen port (default 8765)
//   HOST               — bind adresi (default 0.0.0.0; PROD'da 127.0.0.1 ver → dışarı kapalı)
//   DISABLE_API_PROXY  — '1' ise non-worldly /api/* proxy KAPANIR.
//                        PROD'da ZORUNLU: UPSTREAM_HOST = Caddy'nin kendisi olduğundan
//                        proxy açık kalırsa /api/* sonsuz döngüye girer (self-loop).
//                        Caddy zaten /api/* → Express'e (3211) yönlendirir, proxy gereksiz.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8765;
// HOST: lokal dev'de tüm arayüzler (0.0.0.0), prod'da systemd 127.0.0.1 verir.
const HOST = process.env.HOST || '0.0.0.0';
// DISABLE_API_PROXY=1 → catch-all /api/* proxy kapalı (prod self-loop koruması).
const DISABLE_API_PROXY = process.env.DISABLE_API_PROXY === '1';
const ROOT = __dirname;
const UPSTREAM_HOST = '178-105-90-130.nip.io';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function proxyToUpstream(req, res) {
  const buffers = [];
  req.on('data', c => buffers.push(c));
  req.on('end', () => {
    const body = Buffer.concat(buffers);
    const headers = { ...req.headers };
    headers.host = UPSTREAM_HOST;
    delete headers['accept-encoding']; // gzip karışıklığı olmasın
    
    const options = {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
      // Self-signed kabul et (nip.io üzerinde valid ama yine de)
      rejectUnauthorized: false,
    };
    
    const upstream = https.request(options, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    
    upstream.on('error', err => {
      console.error('[PROXY ERROR]', req.url, err.message);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Proxy error: ' + err.message);
    });
    
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 Not Found: ' + filePath);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

// Cloudflare tunnel URL'ini okur
function getTunnelUrl() {
  try {
    const logPath = '/tmp/cf-tunnel-app.log';
    if (!fs.existsSync(logPath)) return null;
    const log = fs.readFileSync(logPath, 'utf8');
    // En son trycloudflare.com URL'ini bul
    const matches = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (matches && matches.length) return matches[matches.length - 1];
  } catch(e) {}
  return null;
}

// =====================================================================
// WORLDLY — Gerçek mekan keşfi (OpenStreetMap Overpass API)
// /api/worldly/discover endpoint'i upstream proxy'sine GİTMEZ,
// Overpass'ten gerçek mekan çeker ve normalize eder.
// =====================================================================

// cityId → Türkçe/anlık şehir adı (Overpass area[name=...] araması için)
// Bilinmeyen cityId gelirse capitalize edilerek direkt kullanılır.
const WORLDLY_CITIES_MAP = {
  // Türkiye (popüler 25+)
  istanbul: 'İstanbul',
  ankara: 'Ankara',
  izmir: 'İzmir',
  antalya: 'Antalya',
  bursa: 'Bursa',
  eskisehir: 'Eskişehir',
  konya: 'Konya',
  gaziantep: 'Gaziantep',
  adana: 'Adana',
  mersin: 'Mersin',
  trabzon: 'Trabzon',
  mugla: 'Muğla',
  samsun: 'Samsun',
  kayseri: 'Kayseri',
  denizli: 'Denizli',
  sanliurfa: 'Şanlıurfa',
  urfa: 'Şanlıurfa',
  kocaeli: 'Kocaeli',
  izmit: 'İzmit',
  sakarya: 'Sakarya',
  edirne: 'Edirne',
  canakkale: 'Çanakkale',
  nevsehir: 'Nevşehir',
  bodrum: 'Bodrum',
  marmaris: 'Marmaris',
  fethiye: 'Fethiye',
  alaacati: 'Alaçatı',
  // Uluslararası (worldlyParse default'ları için)
  tokyo: 'Tokyo',
  paris: 'Paris',
  lisbon: 'Lisbon',
  lizbon: 'Lisbon',
  lisboa: 'Lisboa',
  bali: 'Bali',
  ubud: 'Ubud',
  canggu: 'Canggu',
};

// categoryId → OSM tag setleri (Overpass union sorgusu için)
const WORLDLY_CATEGORY_TAGS = {
  coffee:    [['amenity', 'cafe'], ['shop', 'coffee']],
  food:      [['amenity', 'restaurant']],
  nightlife: [['amenity', 'bar'], ['amenity', 'nightclub'], ['amenity', 'pub']],
  culture:   [['tourism', 'museum'], ['tourism', 'gallery'], ['tourism', 'artwork']],
  beach:     [['natural', 'beach'], ['leisure', 'beach_resort']],
  perfume:   [['shop', 'perfumery'], ['shop', 'cosmetics']],
};

// Kategori meta bilgisi (frontend WORLDLY_CATEGORIES/WORLDLY_IMAGES ile uyumlu)
const U = 'https://images.unsplash.com/photo-';
const Q = '?w=800&q=80';
const WORLDLY_CATEGORY_INFO = {
  coffee: {
    trLabel: 'kafe', signature: 'Özel demleme kahve', fallbackArea: 'Şehir merkezi',
    vibes: ['cozy', 'artisanal', 'quiet', 'warm', 'minimal', 'third-wave'],
    images: [
      U + '1495474472287-4d71bcdd2085' + Q, U + '1453614512568-c4024d13c247' + Q,
      U + '1559925393-8be0ec4767c8' + Q, U + '1442975631115-c4f7b05b8a2c' + Q,
      U + '1554118811-1e0d58224f24' + Q, U + '1501339847302-ac426a4a7cbb' + Q,
      U + '1521017432531-fbd92d768814' + Q, U + '1511920170033-f8396924c348' + Q,
    ],
  },
  food: {
    trLabel: 'restoran', signature: 'Mevsimsel menü', fallbackArea: 'Şehir merkezi',
    vibes: ['authentic', 'intimate', 'seasonal', 'farm-to-table', 'romantic', 'iconic'],
    images: [
      U + '1517248135467-4c7edcad34c4' + Q, U + '1414235077428-338989a2e8c0' + Q,
      U + '1555396273-367ea4eb4db5' + Q, U + '1559339352-11d035aa65de' + Q,
      U + '1466978913421-dad2ebd01d17' + Q, U + '1552566626-52f8b828add9' + Q,
      U + '1551218808-94e220e084d2' + Q, U + '1424847651672-bf20a4b0982b' + Q,
    ],
  },
  nightlife: {
    trLabel: 'bar', signature: 'İmza kokteyl', fallbackArea: 'Eğlence bölgesi',
    vibes: ['speakeasy', 'electric', 'underground', 'rooftop', 'live music', 'dive'],
    images: [
      U + '1514933651103-005eec06c04b' + Q, U + '1572116469696-31de0f17cc34' + Q,
      U + '1566417713940-fe7c737a9ef2' + Q, U + '1493612276216-ee3925520721' + Q,
      U + '1470337458703-46ad1756a187' + Q, U + '1551024709-8f23befc6f87' + Q,
      U + '1530035415911-c93e8d4b3fa3' + Q, U + '1543007630-9710e4a00a20' + Q,
    ],
  },
  culture: {
    trLabel: 'kültür mekânı', signature: 'Kalıcı sergi', fallbackArea: 'Kültür bölgesi',
    vibes: ['inspiring', 'historic', 'avant-garde', 'immersive', 'contemplative'],
    images: [
      U + '1515169067868-5387ec356754' + Q, U + '1554907984-15263bfd63bd' + Q,
      U + '1577083552431-6e5fd01988ec' + Q, U + '1503095396549-807759245b35' + Q,
      U + '1564399579883-451a5d44ec08' + Q, U + '1525373698358-041e3a460346' + Q,
      U + '1581094289810-adf5d25690e3' + Q, U + '1499781350541-7783f6c6a0c8' + Q,
    ],
  },
  beach: {
    trLabel: 'plaj', signature: 'Gün batımı manzarası', fallbackArea: 'Sahil',
    vibes: ['secluded', 'paradise', 'untouched', 'crystal', 'turquoise', 'wild'],
    images: [
      U + '1507525428034-b723cf961d3e' + Q, U + '1519046904884-53103b34b206' + Q,
      U + '1473116763249-2faaef81ccda' + Q, U + '1468413253725-0d5181091126' + Q,
      U + '1455587734955-081b22074882' + Q, U + '1559136555-9303baea8ebd' + Q,
      U + '1500382017468-9049fed747ef' + Q, U + '1483683804023-6ccdb62f86ef' + Q,
    ],
  },
  perfume: {
    trLabel: 'parfümeri', signature: 'Niş koku', fallbackArea: 'Alışveriş bölgesi',
    vibes: ['niche', 'luxurious', 'mysterious', 'botanical', 'rare'],
    images: [
      U + '1541643600914-78b084683601' + Q, U + '1592945403244-b3fbafd7f539' + Q,
      U + '1523293182086-7651a899d37f' + Q, U + '1610461888750-10bfc601b874' + Q,
      U + '1588405748880-12d1d2a59d75' + Q, U + '1547887537-6158d64c35b3' + Q,
      U + '1615634260167-c8cdede054de' + Q, U + '1612869538502-bb1e1c4a4f73' + Q,
    ],
  },
};

// In-memory cache (Overpass rate-limit koruması, 10dk TTL)
const WORLDLY_CACHE = new Map();
const WORLDLY_CACHE_TTL = 10 * 60 * 1000;
const WORLDLY_CACHE_MAX = 256; // memory blow-up koruması (farklı cityId saldırısı)

function worldlyCacheGet(key) {
  const entry = WORLDLY_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { WORLDLY_CACHE.delete(key); return null; }
  return entry.value;
}
function worldlyCacheSet(key, value) {
  // Cap'i koru: eşiği aşınca en eski (insertion-order) girdiyi at.
  // TTL lazy-evict zaten var; bu ekstra olarak saldırı anında boyutu sınırlar.
  while (WORLDLY_CACHE.size >= WORLDLY_CACHE_MAX) {
    const oldest = WORLDLY_CACHE.keys().next().value;
    if (oldest === undefined) break;
    WORLDLY_CACHE.delete(oldest);
  }
  WORLDLY_CACHE.set(key, { value, exp: Date.now() + WORLDLY_CACHE_TTL });
}

// Deterministik hash (frontend worldlySeed ile aynı algoritma — Mulberry32)
// OSM'de rating/priceLevel yok; bunları name'den DETERMİNİSTİK üretiyoruz
// ki aynı mekan her zaman aynı rating'i göstersin.
function worldlyHash(seed) {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  return () => {
    h |= 0; h = h + 0x6D2B79F5 | 0;
    let t = Math.imul(h ^ h >>> 15, 1 | h);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function worldlyCapitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Overpass opening_hours değerini okunabilir hale getir (basit temizlik)
function worldlyParseHours(oh) {
  if (!oh) return null;
  let s = String(oh).trim();
  if (!s || s === '24/7') return s === '24/7' ? '7/24 açık' : null;
  if (s.length > 64) s = s.slice(0, 61) + '...';
  return s;
}

// Overpass QL sorgusu üret: area[name="<şehir>"] içinde kategori tag'leri
function worldlyBuildQuery(cityName, tagSets) {
  const safe = cityName.replace(/["\\]/g, '');
  const filters = [];
  for (const [k, v] of tagSets) {
    filters.push(`  node["${k}"="${v}"](area.searchArea);`);
    filters.push(`  way["${k}"="${v}"](area.searchArea);`);
  }
  return `[out:json][timeout:25];
area[name="${safe}"]->.searchArea;
(
${filters.join('\n')}
);
out center 40;`;
}

// Overpass API'ye POST at (https.request + Promise, timeout 30sn)
function worldlyOverpassRequest(query) {
  return new Promise((resolve, reject) => {
    const body = 'data=' + encodeURIComponent(query);
    const options = {
      hostname: 'overpass-api.de',
      port: 443,
      path: '/api/interpreter',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Takil-DevServer/1.0 (worldly discovery; local dev)',
        'Accept': 'application/json',
      },
    };
    const upReq = https.request(options, upRes => {
      const chunks = [];
      upRes.on('data', c => chunks.push(c));
      upRes.on('end', () => {
        const status = upRes.statusCode || 0;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (status === 429) return reject(new Error('rate_limited'));
        if (status === 504) return reject(new Error('gateway_timeout'));
        if (status >= 500) return reject(new Error('overpass_' + status));
        if (status !== 200) return reject(new Error('overpass_http_' + status));
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('overpass_parse'));
        }
      });
    });
    upReq.on('error', err => reject(err));
    // 30sn hard timeout (sorgu timeout 25sn + marj)
    upReq.setTimeout(30000, () => {
      upReq.destroy(new Error('overpass_timeout'));
    });
    upReq.write(body);
    upReq.end();
  });
}

// Overpass element'lerini frontend formatına normalize et
function worldlyNormalize(elements, cityId, cat) {
  const info = WORLDLY_CATEGORY_INFO[cat];
  const seen = new Set();
  const places = [];
  let idx = 0;
  for (const el of elements) {
    const tags = el.tags || {};
    const name = (tags.name || '').toString().trim();
    if (!name) continue; // isimsiz OSM node'ları atla
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // aynı isimde duplicate (node+way) temizle
    seen.add(key);

    // Koordinat: node → lat/lon, way/relation → center.lat/lon
    const lat = (el.lat != null) ? el.lat : (el.center && el.center.lat);
    const lon = (el.lon != null) ? el.lon : (el.center && el.center.lon);

    // Deterministik rating/priceLevel/vibes (name + cityId seed)
    const rand = worldlyHash(cityId + '|' + cat + '|' + name);
    const rating = (4.0 + rand() * 0.9).toFixed(1);
    const priceLevel = 1 + Math.floor(rand() * 4);

    // 2-3 vibe deterministik seç (tekrarsız)
    const pool = info.vibes.slice();
    const vibes = [];
    while (vibes.length < 3 && pool.length) {
      const i = Math.floor(rand() * pool.length);
      const v = pool.splice(i, 1)[0];
      vibes.push(v);
    }

    const neighborhood = tags['addr:suburb'] || tags['addr:neighbourhood']
      || tags['addr:district'] || tags['addr:quarter'] || tags['addr:city']
      || info.fallbackArea;
    const signature = tags.cuisine || tags.speciality
      || (tags['amenity'] === 'cafe' ? 'Kahve & atıştırmalık' : info.signature);
    const openHours = worldlyParseHours(tags.opening_hours) || 'Bilinmiyor';
    const aiSummary = `${name}, ${neighborhood} bölgesinde bulunan gerçek bir ${info.trLabel}. `
      + (signature ? `Öne çıkan: ${signature}. ` : '')
      + `OpenStreetMap verisiyle keşfedildi.`;

    places.push({
      id: `${cityId}-${cat}-${idx + 1}`,
      name,
      cityId,
      categoryId: cat,
      neighborhood,
      image: info.images[idx % info.images.length],
      rating,
      priceLevel,
      vibes,
      signature,
      isHidden: idx < 2,
      aiSummary,
      openHours,
      lat: (lat != null) ? Number(Number(lat).toFixed(6)) : null,
      lon: (lon != null) ? Number(Number(lon).toFixed(6)) : null,
      osmId: (el.id != null) ? String(el.id) : null,
      osmType: el.type || null,
      // Internal: görsel waterfall için (response'tan temizlenir)
      _wikidataId: (tags.wikidata && /^Q\d+$/i.test(String(tags.wikidata).trim()))
        ? String(tags.wikidata).trim() : null,
    });
    idx++;
    if (places.length >= 40) break;
  }
  return places;
}

// =====================================================================
// WORLDLY — Görsel waterfall resolver (3 katman)
// Her mekan için GERÇEK fotoğraf çözer:
//   Katman 1: Wikidata P18 → Commons (müzeler/anıtlar, EN güvenilir)
//   Katman 2: Commons isim search (sadece .jpg/.png + anlamsal uyum filtresi)
//   Katman 3: Kategori placeholder (Unsplash, garantili fallback)
// Kurallar: 5sn timeout/istek, max 5 eşzamanlı Wikimedia isteği (sempfor),
// 1 saat cache, her hata sessizce sonraki katmana düşer. SSRF: sadece 2 host.
// =====================================================================

const WORLDLY_IMG_UA = 'TakilGame/1.0 (https://github.com/kubilayayhan44-dev/takil-firewater; contact@takil.app)';
const WORLDLY_IMG_TIMEOUT = 5000;            // her dış istek 5sn hard timeout
const WORLDLY_IMG_CONCURRENCY = 5;            // Wikimedia'ya eşzamanlı istek limiti (nazik davran)
const WORLDLY_IMG_CACHE_TTL = 60 * 60 * 1000; // 1 saat TTL
const WORLDLY_IMG_CACHE_MAX = 512;            // memory cap (saldırı koruması)
// Sadece bu iki Wikimedia host'una istek atılır (SSRF — user content buraya gitmez)
const WORLDLY_IMG_ALLOWED_HOSTS = new Set(['www.wikidata.org', 'commons.wikimedia.org']);

// Görsel çözümleme cache'i: wikidata_id veya mekan adı → {url, source}
const WORLDLY_IMG_CACHE = new Map();

function worldlyImgCacheGet(key) {
  const e = WORLDLY_IMG_CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { WORLDLY_IMG_CACHE.delete(key); return null; }
  return e.value;
}
function worldlyImgCacheSet(key, value) {
  while (WORLDLY_IMG_CACHE.size >= WORLDLY_IMG_CACHE_MAX) {
    const oldest = WORLDLY_IMG_CACHE.keys().next().value;
    if (oldest === undefined) break;
    WORLDLY_IMG_CACHE.delete(oldest);
  }
  WORLDLY_IMG_CACHE.set(key, { value, exp: Date.now() + WORLDLY_IMG_CACHE_TTL });
}

// Basit sempfor: tüm Wikimedia HTTP isteklerini max N eşzamanlı tutar.
// (chunk'lı batch yerine sempfor — kapasiteyi daha sıkı paketler, daha hızlı.)
const _imgSem = { active: 0, waiters: [] };
function worldlyImgAcquire() {
  return new Promise(resolve => {
    const run = () => { _imgSem.active++; resolve(); };
    if (_imgSem.active < WORLDLY_IMG_CONCURRENCY) run();
    else _imgSem.waiters.push(run);
  });
}
function worldlyImgRelease() {
  _imgSem.active--;
  const next = _imgSem.waiters.shift();
  if (next) next();
}

// Genel JSON fetch: sempfor + 5sn timeout + zorunlu User-Agent + SSRF host kontrolü.
// Her çıkış yolunda (başarı/http hatası/parse/timeout/network) sempfor serbest bırakılır.
function worldlyImgFetchJson(url) {
  return worldlyImgAcquire().then(() => {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (e) { return reject(new Error('bad_url')); }
      if (!WORLDLY_IMG_ALLOWED_HOSTS.has(u.hostname)) {
        return reject(new Error('ssrf_blocked'));
      }
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': WORLDLY_IMG_UA, 'Accept': 'application/json' },
      }, resp => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const status = resp.statusCode || 0;
          if (status !== 200) return reject(new Error('http_' + status));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error('parse'));
          }
        });
      });
      req.on('error', err => reject(err));
      req.setTimeout(WORLDLY_IMG_TIMEOUT, () => req.destroy(new Error('timeout')));
      req.end();
    });
  }).finally(worldlyImgRelease);
}

// Katman 1a: Wikidata entity (Qxxxxx) → P18 claim değeri (Commons dosya adı)
async function worldlyWikidataP18(qid) {
  const url = 'https://www.wikidata.org/w/api.php?action=wbgetclaims&entity='
    + encodeURIComponent(qid) + '&property=P18&format=json';
  const data = await worldlyImgFetchJson(url);
  const claims = data && data.claims && data.claims.P18;
  if (!Array.isArray(claims) || !claims.length) return null;
  const snak = claims[0] && claims[0].mainsnak;
  const val = snak && snak.datavalue && snak.datavalue.value;
  return val ? String(val) : null;
}

// Katman 1b/2 ortak: Commons dosya adı → 800px thumburl
async function worldlyCommonsThumburl(filename) {
  const fileTitle = 'File:' + filename;
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&titles='
    + encodeURIComponent(fileTitle) + '&prop=imageinfo&iiprop=url&iiurlwidth=800&format=json';
  const data = await worldlyImgFetchJson(url);
  const pages = data && data.query && data.query.pages;
  if (!pages) return null;
  for (const k of Object.keys(pages)) {
    const ii = pages[k] && pages[k].imageinfo;
    if (Array.isArray(ii) && ii.length && ii[0].thumburl) {
      return String(ii[0].thumburl);
    }
  }
  return null;
}

// Türkçe karakterleri ASCII'ye indir (anlamsal eşleşme için)
function worldlyAsciiNorm(s) {
  return String(s).toLowerCase()
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9 ]/g, ' ').trim();
}

// Gürültü filtresi: dosya adında mekan adının önemli (>2 harf) kelimelerinden
// en az 1'i geçmeli (Hamdi→PDF, Peyote→gerçek foto ayrımı için)
function worldlyNameMatch(filename, placeName) {
  if (!placeName) return false;
  const fn = worldlyAsciiNorm(filename);
  const words = worldlyAsciiNorm(placeName).split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return false;
  return words.some(w => fn.includes(w));
}

// Katman 2: Mekan adıyla Commons search — sadece .jpg/.png + anlamsal uyum filtreli
async function worldlyCommonsSearch(name, cityName) {
  const search = name + ' ' + cityName;
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch='
    + encodeURIComponent(search) + '&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url&iiurlwidth=800&format=json';
  const data = await worldlyImgFetchJson(url);
  const pages = data && data.query && data.query.pages;
  if (!pages) return null;
  const candidates = Object.values(pages).filter(p => p && p.title);
  // Commons relevance sırasını koru (index alanı varsa)
  candidates.sort((a, b) => (a.index || 999) - (b.index || 999));
  const allowedExt = /\.(jpe?g|png)$/i; // PDF/.tif/.gif/.svg/.ogv DIŞLA
  for (const p of candidates) {
    const title = String(p.title);
    if (!allowedExt.test(title)) continue;
    if (!worldlyNameMatch(title, name)) continue;
    const ii = p.imageinfo;
    if (Array.isArray(ii) && ii.length && ii[0].thumburl) {
      return String(ii[0].thumburl);
    }
  }
  return null;
}

// Tek mekan için 3 katmanlı waterfall. Hata olursa sessizce placeholder'a düşer.
async function worldlyResolveOneImage(place, cityName) {
  const placeholder = { url: place.image, source: 'placeholder' };
  const name = place.name || '';
  const cacheKey = (place._wikidataId ? ('wd:' + place._wikidataId) : ('nm:' + name)) + '|c:' + cityName;
  const cached = worldlyImgCacheGet(cacheKey);
  if (cached) return cached;

  // Katman 1: Wikidata → Commons (en güvenilir, müzeler/anıtlar)
  if (place._wikidataId) {
    try {
      const filename = await worldlyWikidataP18(place._wikidataId);
      if (filename) {
        const thumb = await worldlyCommonsThumburl(filename);
        if (thumb) {
          const out = { url: thumb, source: 'wikidata' };
          worldlyImgCacheSet(cacheKey, out);
          return out;
        }
      }
    } catch (e) { /* sessiz geç */ }
  }

  // Katman 2: Commons isim search (filtreli)
  if (name) {
    try {
      const thumb = await worldlyCommonsSearch(name, cityName);
      if (thumb) {
        const out = { url: thumb, source: 'commons' };
        worldlyImgCacheSet(cacheKey, out);
        return out;
      }
    } catch (e) { /* sessiz geç */ }
  }

  // Katman 3: placeholder (garantili)
  worldlyImgCacheSet(cacheKey, placeholder);
  return placeholder;
}

// Tüm mekanların görselini paralel çözümler (HTTP eşzamanlılığı sempforla 5'e limitli).
// Her mekanın image alanını günceller, imageSource ekler, internal _wikidataId'yi temizler.
async function worldlyResolveImages(places, cityName) {
  if (!places.length) return;
  await Promise.all(places.map(async p => {
    try {
      const resolved = await worldlyResolveOneImage(p, cityName);
      p.image = resolved.url;
      p.imageSource = resolved.source;
    } catch (e) {
      // Garanti: unexpected hata durumunda placeholder korunur
      p.imageSource = 'placeholder';
    }
    delete p._wikidataId; // internal alanı response'tan temizle
  }));
}

// GET /api/worldly/discover handler
async function worldlyHandleDiscover(res, params) {
  const cityId = (params.get('city') || '').toLowerCase().trim();
  const cat = (params.get('cat') || '').toLowerCase().trim();
  const json = (status, obj) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(obj));
  };

  if (!cityId || !cat) return json(400, { ok: false, error: 'missing_params' });
  const tagSets = WORLDLY_CATEGORY_TAGS[cat];
  if (!tagSets) return json(400, { ok: false, error: 'unknown_category' });

  const cityName = WORLDLY_CITIES_MAP[cityId] || worldlyCapitalize(cityId);
  const cacheKey = cityId + ':' + cat;

  const cached = worldlyCacheGet(cacheKey);
  if (cached) {
    console.log(`[WORLDLY CACHE] hit ${cacheKey} (${cached.count} yer)`);
    return json(200, cached);
  }

  const query = worldlyBuildQuery(cityName, tagSets);
  console.log(`[WORLDLY] Overpass sorgu: city=${cityName} cat=${cat}`);

  let data;
  try {
    data = await worldlyOverpassRequest(query);
  } catch (e) {
    console.error('[WORLDLY] Overpass hatası:', e.message);
    return json(502, { ok: false, error: 'overpass_unavailable', detail: e.message });
  }

  const elements = (data && Array.isArray(data.elements)) ? data.elements : [];
  const places = worldlyNormalize(elements, cityId, cat);
  // 3 katmanlı görsel waterfall: gerçek foto çözümle (Wikidata→Commons→placeholder)
  await worldlyResolveImages(places, cityName);
  const result = {
    ok: true,
    places,
    source: 'openstreetmap',
    count: places.length,
    city: cityName,
    category: cat,
  };
  worldlyCacheSet(cacheKey, result);
  console.log(`[WORLDLY] ${cityName}/${cat}: ${places.length} gerçek mekan döndü`);
  return json(200, result);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Özel endpoint: tunnel URL
  if (url === '/api/_tunnel-url') {
    const tunnelUrl = getTunnelUrl();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ tunnel: tunnelUrl, host: req.headers.host }));
  }

  // Hafif health endpoint'leri (Overpass'e GİTMEZ; monitoring/systemd liveness için).
  // /api/worldly/ping → discover handler'ından ÖNCE yakalanmalı (yoksa missing_params 400 döner).
  if (url === '/health' || url === '/api/worldly/ping') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'takil-worldly',
      proxyDisabled: DISABLE_API_PROXY,
      ts: Date.now(),
    }));
  }

  // /api/worldly/* → Overpass'ten gerçek mekan (upstream'e GİTMEZ)
  if (url === '/api/worldly/discover' || url.startsWith('/api/worldly/')) {
    const u = new URL(req.url, 'http://localhost');
    const params = u.searchParams;
    console.log(`[WORLDLY] ${req.method} ${url} city=${params.get('city')} cat=${params.get('cat')}`);
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    }
    // Handler async; beklenmedik reject'te process'i çökertmemek için yakala.
    return worldlyHandleDiscover(res, params).catch(err => {
      console.error('[WORLDLY] handler hatası:', err && err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'internal' }));
      }
    });
  }

  // /api/* → canlı VPS'e proxy (worldly DIŞINDAki API'ler).
  // PROD'da DISABLE_API_PROXY=1: UPSTREAM_HOST = Caddy'nin kendisi olduğundan proxy
  // sonsuz döngü yaratır. Caddy zaten /api/* → Express'e yönlendirir, burada 404 döneriz.
  if (url.startsWith('/api/')) {
    if (DISABLE_API_PROXY) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'proxy_disabled' }));
    }
    console.log(`[PROXY] ${req.method} ${url} → https://${UPSTREAM_HOST}${url}`);
    return proxyToUpstream(req, res);
  }
  
  // Statik dosya
  let filePath = url === '/' ? '/index.html' : url;
  filePath = path.join(ROOT, filePath);
  
  // Güvenlik: ROOT dışına çıkmasın
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  
  console.log(`[STATIC] ${req.method} ${url}`);
  serveFile(filePath, res);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🎮 Takıl Dev Server`);
  console.log(`  ─────────────────────────────`);
  console.log(`  🌐 http://${HOST}:${PORT}`);
  console.log(`  📁 Root: ${ROOT}`);
  if (DISABLE_API_PROXY) {
    console.log(`  🔌 API proxy: KAPALI (DISABLE_API_PROXY=1) — sadece /api/worldly/* lokal işlenir`);
  } else {
    console.log(`  🔌 API proxy: https://${UPSTREAM_HOST}/api/*`);
  }
  console.log(`  ✋ Durdur: Ctrl+C\n`);
});
