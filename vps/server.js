const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const WebTorrent = require('webtorrent');
const { XMLParser } = require('fast-xml-parser');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'alkare2000';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';

// Ensure dirs
const HLS_DIR = path.join(DATA_DIR, 'hls');
const TORRENT_DIR = path.join(DATA_DIR, 'torrents');
const MAGNETS_DIR = path.join(DATA_DIR, 'magnets');
const TX_CACHE_DIR = path.join(DATA_DIR, 'translate-cache');
for (const d of [DATA_DIR, HLS_DIR, TORRENT_DIR, MAGNETS_DIR, TX_CACHE_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Active downloads
const downloads = new Map();
const wt = new WebTorrent();

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function json(res, data, status = 200) {
  return res.status(status).json(data);
}
function jsonErr(res, msg, status = 500) {
  return res.status(status).json({ ok: false, error: String(msg) });
}
function auth(req) {
  return req.headers['x-admin-token'] === ADMIN_TOKEN;
}

// ── Static pages ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── MAGNETS API (file-based KV) ────────────────────────────────────────────────
app.get('/magnets', (req, res) => {
  const malId = req.query.mal_id || req.query.malId;
  if (!malId) return json(res, { ok: true, mal_id: '', episodes: {} });
  const filePath = path.join(MAGNETS_DIR, `${malId}.json`);
  let data = { keyword: '', episodes: {} };
  try {
    if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  json(res, { ok: true, mal_id: malId, episodes: data.episodes || {}, keyword: data.keyword || '' });
});

app.post('/magnets', (req, res) => {
  const { mal_id, ep, result, keyword } = req.body;
  if (!mal_id) return jsonErr(res, 'Missing mal_id', 400);
  const filePath = path.join(MAGNETS_DIR, `${mal_id}.json`);
  let data = { keyword: '', episodes: {} };
  try {
    if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  if (keyword !== undefined && !ep && !result) {
    data.keyword = String(keyword);
    try { fs.writeFileSync(filePath, JSON.stringify(data)); } catch (e) { return jsonErr(res, e.message); }
    return json(res, { ok: true, saved: true, mal_id, keyword: data.keyword });
  }
  if (!ep || !result) return jsonErr(res, 'Missing ep / result', 400);
  data.episodes[ep] = { ...result, savedAt: new Date().toISOString() };
  try { fs.writeFileSync(filePath, JSON.stringify(data)); } catch (e) { return jsonErr(res, e.message); }
  json(res, { ok: true, saved: true, mal_id, ep });
});

app.delete('/magnets', (req, res) => {
  if (!auth(req)) return jsonErr(res, 'Unauthorized', 401);
  const malId = req.query.mal_id;
  const ep = req.query.ep;
  if (!malId || !ep) return jsonErr(res, 'Missing mal_id or ep', 400);
  const filePath = path.join(MAGNETS_DIR, `${malId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      delete data.episodes[ep];
      fs.writeFileSync(filePath, JSON.stringify(data));
    }
    json(res, { ok: true, deleted: true, mal_id: malId, ep });
  } catch (e) { jsonErr(res, e.message); }
});

// ── NYAA.SI RSS (replaces AnimeTosho) ──────────────────────────────────────────
app.get('/tosho', async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 50);
  if (!q) return jsonErr(res, 'Missing q parameter', 400);

  const rssUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!r.ok) return jsonErr(res, `Nyaa RSS HTTP ${r.status}`, 502);
    const xml = await r.text();
    if (!xml.includes('<item>')) return json(res, { query: q, total: 0, items: [] });

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (tagName) => tagName === 'item',
    });
    const parsed = parser.parse(xml);
    let rawItems = [];
    try {
      const channel = parsed.rss.channel;
      if (channel.item) {
        if (Array.isArray(channel.item)) rawItems = channel.item;
        else rawItems = [channel.item];
      }
    } catch { return json(res, { query: q, total: 0, items: [] }); }

    const items = rawItems.slice(0, limit).map(item => {
      const title = item.title || '';
      let magnet = '';
      if (item.link && item.link.startsWith('magnet:')) magnet = item.link;
      if (!magnet && item['nyaa:infoHash']) {
        const hash = item['nyaa:infoHash'];
        magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}` +
          `&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce` +
          `&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce` +
          `&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`;
      }
      const size = parseInt(item['nyaa:size'] || '0', 10);
      const seeders = parseInt(item['nyaa:seeders'] || '0', 10);
      const leechers = parseInt(item['nyaa:leechers'] || '0', 10);
      let episode = null;
      for (const pat of [/- (\d{1,4})(?:\s|v\d|$)/i, /\bE(\d{1,4})\b/i, /\[(\d{1,4})\]/, /EP\.?(\d{1,4})\b/i, / (\d{2,4})(?:v\d)?\s*[\[\(]/]) {
        const m = title.match(pat);
        if (m) { episode = parseInt(m[1], 10); break; }
      }
      const resMatch = title.match(/(\d{3,4}p)/i);
      const resolution = resMatch ? resMatch[1].toLowerCase() : '';
      const isArabic = /\[\s*ara\s*,?\s*(?:ASS\s*)?\]/i.test(title) || /\bara\b/i.test(title) || /[\u0600-\u06FF]/.test(title);
      return { title, magnet, size, seeders, leechers, episode, resolution, isArabic };
    });

    json(res, { query: q, total: items.length, source: 'nyaa', items });
  } catch (e) {
    jsonErr(res, 'Nyaa RSS failed: ' + e.message, 502);
  }
});

// ── JIKAN PROXY ────────────────────────────────────────────────────────────────
const JIKAN_MIRRORS = [
  'https://api.jikan.moe/v4',
  'https://jikan.moe/v4',
  'https://jikan-api.up.railway.app/v4',
  'https://api.jikan.pw/v4',
];
const JIKAN_HEADERS = {
  'User-Agent': 'AnimeNow/1.0 (https://github.com/anime-now)',
  'Accept': 'application/json',
};

app.get('/jikan', async (req, res) => {
  const urlPath = req.query.path || '/seasons/now';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'path') params.set(k, v);
  }
  const qs = params.toString();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const errors = [];
  for (const mirror of JIKAN_MIRRORS) {
    const target = `${mirror}${urlPath}${qs ? '?' + qs : ''}`;
    for (let i = 0; i < 2; i++) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 10000);
        const r = await fetch(target, { headers: JIKAN_HEADERS, signal: ac.signal });
        clearTimeout(t);
        if (r.ok) {
          const data = await r.json();
          if (data && data.data) {
            res.set('Cache-Control', 'public, max-age=300');
            return json(data);
          }
          errors.push(`${mirror}: empty data`);
          break;
        }
        if (r.status === 429) { await sleep(2500 + i * 1000); continue; }
        if (r.status >= 500) { await sleep(1500 + i * 1000); continue; }
        errors.push(`${mirror}: HTTP ${r.status}`);
        break;
      } catch (e) {
        if (e.name === 'AbortError') errors.push(`${mirror}: timeout`);
        else errors.push(`${mirror}: ${e.message}`);
        if (i < 1) await sleep(1000);
      }
    }
  }
  jsonErr(res, 'All Jikan mirrors failed: ' + errors.join(' | '), 504);
});

// ── TRANSLATE (DeepL) ──────────────────────────────────────────────────────────
app.post('/translate', async (req, res) => {
  if (!DEEPL_API_KEY) return jsonErr(res, 'DEEPL_API_KEY not set', 500);
  const { genres, synopsis, targetLang } = req.body;
  const genresArr = Array.isArray(genres) ? genres.filter(Boolean) : [];
  const synStr = typeof synopsis === 'string' ? synopsis.trim() : '';
  const tLang = targetLang === 'en' ? 'en' : 'ar';
  if (!genresArr.length && !synStr) return jsonErr(res, 'Provide genres or synopsis', 400);

  const items = [...genresArr, ...(synStr ? [synStr] : [])];
  const results = new Array(items.length).fill(null);
  const toFetch = [];
  const kvKey = text => `deepl:${tLang}:${text.trim().slice(0, 120)}`;

  for (let i = 0; i < items.length; i++) {
    if (!items[i]) { results[i] = ''; continue; }
    const cacheFile = path.join(TX_CACHE_DIR, kvKey(items[i]).replace(/[^a-zA-Z0-9:_.-]/g, '_'));
    try {
      if (fs.existsSync(cacheFile)) {
        results[i] = fs.readFileSync(cacheFile, 'utf8');
        continue;
      }
    } catch {}
    toFetch.push({ i, text: items[i] });
  }

  if (toFetch.length > 0) {
    const dlLang = tLang === 'ar' ? 'AR' : 'EN-US';
    const langMap = { ar: 'AR', en: 'EN-US' };
    const deeplLang = langMap[tLang] || 'AR';
    const endpoint = DEEPL_API_KEY.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
    const params = new URLSearchParams();
    params.append('target_lang', deeplLang);
    params.append('split_sentences', '0');
    for (const t of toFetch.map(f => f.text)) params.append('text', t);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const data = await r.json();
      if (!r.ok) return jsonErr(res, data?.message || `DeepL HTTP ${r.status}`, 502);
      const translated = data.translations.map(t => t.text);
      for (let j = 0; j < toFetch.length; j++) {
        const t = translated[j] || toFetch[j].text;
        results[toFetch[j].i] = t;
        const cacheFile = path.join(TX_CACHE_DIR, kvKey(toFetch[j].text).replace(/[^a-zA-Z0-9:_.-]/g, '_'));
        try { fs.writeFileSync(cacheFile, t); } catch {}
      }
    } catch (e) {
      return jsonErr(res, 'DeepL error: ' + e.message, 502);
    }
  }

  const outGenres = results.slice(0, genresArr.length);
  const outSynopsis = synStr ? (results[genresArr.length] || '') : '';
  json(res, { ok: true, genres: outGenres, synopsis: outSynopsis, targetLang: tLang });
});

// ── VPS: HLS file serving ─────────────────────────────────────────────────────
app.use('/hls', (req, res) => {
  const filePath = path.join(HLS_DIR, req.path);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'not_found' });
  }
});

// ── VPS: Status check ─────────────────────────────────────────────────────────
app.get('/api/status/:malId/:ep', (req, res) => {
  const key = `${req.params.malId}:${req.params.ep}`;
  const playlist = path.join(HLS_DIR, key, 'playlist.m3u8');
  if (fs.existsSync(playlist)) return json(res, { status: 'ready', progress: 100 });
  const dl = downloads.get(key);
  if (dl) return json(res, { status: dl.status, progress: dl.progress, speed: dl.speed, eta: dl.eta, message: dl.message });
  json(res, { status: 'not_found', progress: 0 });
});

// ── VPS: Download ─────────────────────────────────────────────────────────────
app.post('/api/download', (req, res) => {
  const { malId, ep, magnet } = req.body;
  if (!malId || !ep || !magnet) return jsonErr(res, 'Missing malId, ep, or magnet', 400);
  const key = `${malId}:${ep}`;
  const hlsDir = path.join(HLS_DIR, key);
  const playlist = path.join(hlsDir, 'playlist.m3u8');
  if (fs.existsSync(playlist)) return json(res, { status: 'ready', progress: 100 });
  if (downloads.has(key)) return json(res, { status: downloads.get(key).status });
  startDownload(key, malId, ep, magnet, hlsDir);
  json(res, { status: 'started' });
});

// ── VPS: Delete episode ────────────────────────────────────────────────────────
app.delete('/api/episode/:malId/:ep', (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return jsonErr(res, 'Unauthorized', 401);
  const key = `${req.params.malId}:${req.params.ep}`;
  const hlsDir = path.join(HLS_DIR, key);
  const dl = downloads.get(key);
  if (dl && dl.torrent) { try { dl.torrent.destroy(); } catch {} }
  downloads.delete(key);
  if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
  json(res, { ok: true });
});

// ── VPS: Download Engine ──────────────────────────────────────────────────────
function startDownload(key, malId, ep, magnet, hlsDir) {
  const state = { status: 'downloading', progress: 0, speed: 0, eta: 0, message: 'جارٍ تحميل التورنت...', torrent: null, wsClients: [] };
  downloads.set(key, state);
  broadcast(key, state);

  const trackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce',
    'udp://exodus.desync.com:6969/announce',
    'http://nyaa.tracker.wf:7777/announce',
    'wss://tracker.openwebtorrent.com'
  ];
  const magWithTr = magnet + (magnet.includes('?') ? '&' : '?') + 'tr=' + trackers.map(encodeURIComponent).join('&tr=');

  try {
    const torrent = wt.add(magWithTr, { path: TORRENT_DIR });
    torrent.on('infoHash', () => { state.message = 'جارٍ الاتصال بالأقران...'; broadcast(key, state); });
    torrent.on('download', () => {
      state.progress = torrent.progress * 100;
      if (torrent.progress < 1) {
        state.speed = torrent.downloadSpeed;
        state.eta = torrent.downloadSpeed > 0 ? Math.ceil((1 - torrent.progress) * torrent.length / torrent.downloadSpeed) : 0;
        state.message = `جارٍ التحميل... ${state.progress.toFixed(1)}%`;
      }
      broadcast(key, state);
    });
    torrent.on('done', async () => {
      state.progress = 100; state.speed = 0; state.eta = 0;
      state.message = 'تم التحميل، جارٍ تحويل الصيغة...';
      broadcast(key, state);
      try { await transmuxToHls(key, hlsDir, torrent); }
      catch (e) { state.status = 'error'; state.message = 'خطأ في التحويل: ' + (e.message || e); broadcast(key, state); }
    });
    torrent.on('error', (e) => { state.status = 'error'; state.message = 'خطأ: ' + (e.message || e); broadcast(key, state); });
    state.torrent = torrent;
  } catch (e) { state.status = 'error'; state.message = 'خطأ: ' + e.message; broadcast(key, state); }
}

async function transmuxToHls(key, hlsDir, torrent) {
  const videoFile = torrent.files.find(f => /\.(mkv|mp4|webm|avi)$/i.test(f.name));
  if (!videoFile) {
    const s = downloads.get(key);
    if (s) { s.status = 'error'; s.message = 'لم يتم العثور على ملف فيديو'; broadcast(key, s); }
    return;
  }
  if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });
  const inputPath = path.join(TORRENT_DIR, videoFile.path);
  const subsAssPath = path.join(hlsDir, 'subs.ass');
  const subsSrtPath = path.join(hlsDir, 'subs.srt');
  try { await runFfmpeg(['-i', inputPath, '-map', '0:s:0', '-y', subsAssPath]); } catch {}
  await runFfmpeg(['-i', inputPath, '-c', 'copy', '-f', 'hls', '-hls_time', '10', '-hls_list_size', '0', '-hls_segment_filename', path.join(hlsDir, 'seg_%03d.ts'), '-y', path.join(hlsDir, 'playlist.m3u8')]);
  try { if (fs.existsSync(subsAssPath)) await runFfmpeg(['-i', subsAssPath, '-y', subsSrtPath]); } catch {}
  try { if (fs.existsSync(inputPath)) fs.rmSync(inputPath, { force: true }); } catch {}
  const s = downloads.get(key);
  if (s) { s.status = 'ready'; s.progress = 100; s.message = 'جاهز للتشغيل'; s.torrent = null; broadcast(key, s); }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = require('child_process').spawn('ffmpeg', args);
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
    proc.on('error', reject);
  });
}

function broadcast(key, data) {
  const dl = downloads.get(key);
  if (dl) for (const ws of dl.wsClients) { try { ws.send(JSON.stringify(data)); } catch {} }
}

// ── Auto-cleanup (24h) ────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  let deleted = 0;
  try {
    for (const key of fs.readdirSync(HLS_DIR)) {
      const dirPath = path.join(HLS_DIR, key);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      if (!fs.existsSync(path.join(dirPath, 'playlist.m3u8'))) continue;
      if (now - fs.statSync(dirPath).mtimeMs > oneDay) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        downloads.delete(key);
        deleted++;
      }
    }
  } catch {}
  if (deleted) console.log(`[cleanup] deleted ${deleted} expired episodes`);
}, 60 * 60 * 1000);

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && msg.key) {
        ws.episodeKey = msg.key;
        const state = downloads.get(msg.key);
        if (state) ws.send(JSON.stringify(state));
        else {
          const playlist = path.join(HLS_DIR, msg.key, 'playlist.m3u8');
          ws.send(JSON.stringify(fs.existsSync(playlist) ? { status: 'ready', progress: 100 } : { status: 'not_found', progress: 0 }));
        }
        const dl = downloads.get(msg.key);
        if (dl) {
          dl.wsClients.push(ws);
          ws._cleanup = () => { const i = dl.wsClients.indexOf(ws); if (i !== -1) dl.wsClients.splice(i, 1); };
        }
      }
    } catch {}
  });
  ws.on('close', () => { if (ws._cleanup) ws._cleanup(); });
});

server.listen(PORT, () => {
  console.log(`AnimeNow server on port ${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
  console.log(`Admin token: ${ADMIN_TOKEN}`);
  console.log(`DeepL key: ${DEEPL_API_KEY ? 'set' : 'not set'}`);
});
