const { app, BrowserWindow, ipcMain, Menu, net, session, screen } = require('electron');
const path = require('path'), fs = require('fs');
const RPC = require('discord-rpc');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { fork } = require('child_process');
const fetch = (u, o) => net.fetch(u, o);   // сетевой стек Chromium: учитывает системный прокси и VPN
let baked = ''; try { baked = String(require('./config.json').clientId || ''); } catch (e) {}

let win, rpc = null, client = null, last = null, timer = null, retry = null, fails = 0, noType = false;
let status = { ok: false, text: 'Подключаюсь к Discord…' };
const pad = s => String(s || '—').slice(0, 128).padEnd(2, '.');
const cfgFile = () => path.join(app.getPath('userData'), 'discord.json');
const validId = s => /^\d{15,25}$/.test(String(s || ''));
// Какой Application ID использовать. По умолчанию — тот, что вшит в сборку (config.json): вводить ничего не нужно.
// Свой ID из окна «Discord» действует, только пока вшитый ID не менялся (иначе старый сохранённый ID
// перебивал бы новый и приходилось заново «подтверждать» его вручную).
function getId() {
  let saved = null; try { saved = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (e) {}
  if (saved && validId(saved.clientId) && (!validId(baked) || saved.base === baked)) return String(saved.clientId);
  return validId(baked) ? baked : null;
}
function setStatus(ok, text) { status = { ok, text }; if (win && !win.isDestroyed()) win.webContents.send('discord-status', status); }

function connect() {
  clearTimeout(retry);
  const id = getId();
  if (client) { const old = client; client = null; try { Promise.resolve(old.destroy()).catch(() => {}); } catch (e) {} }
  rpc = null;
  if (!id) return setStatus(false, 'Не указан Application ID. Вставьте его ниже.');
  const tag = ' (ID …' + id.slice(-4) + ')';
  setStatus(false, 'Подключаюсь к Discord…' + tag);
  const c = new RPC.Client({ transport: 'ipc' }); client = c;
  const again = e => {
    if (client !== c) return;
    client = null; rpc = null;
    setStatus(false, 'Нет связи с Discord: ' + ((e && e.message) || 'неизвестная ошибка') + '. Discord должен быть запущен как программа (не в браузере) и без прав администратора. Пробую снова…' + tag);
    retry = setTimeout(connect, Math.min(3000 + fails++ * 2000, 15000));
  };
  c.on('ready', () => { if (client !== c) return; fails = 0; rpc = c; setStatus(true, 'Подключено к Discord' + tag + '. Включите трек — статус появится в Discord.'); if (last) push(last); });
  c.on('disconnected', () => again(new Error('соединение закрыто')));
  c.on('error', e => again(e));
  c.login({ clientId: id }).catch(again);
}

function push(s) {
  if (!rpc) return;
  if (!s) return void rpc.clearActivity().catch(() => {});
  const send = typed => {
    const activity = {
      details: pad(s.title), state: pad(s.paused ? 'На паузе · ' + s.artist : s.artist),
      assets: { large_image: 'razy_logo', large_text: 'Razy' }, instance: false
    };
    if (typed) activity.type = 2;   // «Слушает»
    if (!s.paused && s.duration > 0) {
      const now = Date.now();
      activity.timestamps = { start: Math.round(now - s.position * 1000), end: Math.round(now + (s.duration - s.position) * 1000) };
    }
    return rpc.request('SET_ACTIVITY', { pid: process.pid, activity });
  };
  const ok = () => setStatus(true, 'Подключено. Статус отправлен: ' + s.title + (noType ? ' (как «Играет в Razy»)' : ''));
  const bad = e => setStatus(true, 'Discord не принял статус: ' + ((e && e.message) || e));
  // если Discord не принимает тип «Слушает», автоматически отправляем обычный статус
  send(!noType).then(ok).catch(e => { if (noType) return bad(e); noType = true; send(false).then(ok).catch(bad); });
}

ipcMain.on('presence', (_e, s) => { last = s; clearTimeout(timer); timer = setTimeout(() => push(last), 800); });
ipcMain.handle('discord:status', () => status);
ipcMain.handle('discord:retry', () => { fails = 0; noType = false; connect(); return true; });
ipcMain.handle('discord:setId', (_e, id) => { fs.writeFileSync(cfgFile(), JSON.stringify({ clientId: String(id), base: baked })); fails = 0; connect(); return true; });


// Свой прокси (необязательно): http://host:port, https://..., socks5://host:port
const proxyFile = () => path.join(app.getPath('userData'), 'proxy.json');
const getProxy = () => { try { return String(JSON.parse(fs.readFileSync(proxyFile(), 'utf8')).rules || ''); } catch (e) { return ''; } };
const applyProxy = () => { const r = getProxy(); return session.defaultSession.setProxy(r ? { proxyRules: r } : { mode: 'system' }).catch(() => {}); };
ipcMain.handle('proxy:get', () => getProxy());
ipcMain.handle('proxy:set', async (_e, rules) => { fs.writeFileSync(proxyFile(), JSON.stringify({ rules: String(rules || '').trim() })); await applyProxy(); hostsP = null; return true; });

// ---- Поиск музыки: Audius (полные треки) + iTunes (30-секундные превью, можно отключить в настройках)
const nrm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
let hosts = ['https://api.audius.co'], hostsP = null, hostsAt = 0;
function audiusHosts() {
  if (hostsP && Date.now() - hostsAt < 600000) return hostsP;   // один общий запрос, без гонок
  hostsAt = Date.now();
  return hostsP = (async () => {
    try {
      const r = await fetch('https://api.audius.co', { signal: AbortSignal.timeout(5000) });
      const l = ((await r.json()).data || []).filter(h => /^https:\/\//.test(h)).map(h => h.replace(/\/$/, ''));
      if (l.length) hosts = ['https://api.audius.co', ...l.slice(0, 4)];
    } catch (e) {}
    return hosts;
  })();
}
// запрос к Audius с переключением на запасные серверы
async function afetch(path) {
  let err;
  for (const h of await audiusHosts()) {
    try {
      const r = await fetch(`${h}/v1${path}${path.includes('?') ? '&' : '?'}app_name=Razy`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return { j: await r.json(), h };
      err = new Error('http ' + r.status);
    } catch (e) { err = e; }
  }
  hostsP = null; throw err || new Error('audius');
}
const aMap = h => t => ({
  title: t.title, artist: (t.user && t.user.name) || 'Audius', dur: t.duration,
  art: t.artwork && (t.artwork['150x150'] || t.artwork['480x480']), url: `${h}/v1/tracks/${t.id}/stream?app_name=Razy`
});
const aOk = t => t.is_streamable !== false && !t.is_delete && !t.is_unlisted;
async function audius(q, limit = 30) {
  const { j, h } = await afetch(`/tracks/search?query=${encodeURIComponent(q)}&limit=${limit}`);
  return (j.data || []).filter(aOk).map(aMap(h));
}
// треки найденного исполнителя (ищет «Springless» как артиста, а не только по названию)
async function audiusArtist(q) {
  const { j } = await afetch(`/users/search?query=${encodeURIComponent(q)}&limit=5`);
  const n = nrm(q), u = (j.data || []).find(x => { const a = nrm(x.name); return a && (a === n || a.includes(n) || n.includes(a)); });
  if (!u) return [];
  const r = await afetch(`/users/${u.id}/tracks?limit=30&sort=plays`);
  return (r.j.data || []).filter(aOk).map(aMap(r.h));
}
async function audiusTrending(time = 'week', genre = '', limit = 25) {
  const { j, h } = await afetch(`/tracks/trending?limit=${limit}&time=${time}${genre ? '&genre=' + encodeURIComponent(genre) : ''}`);
  return (j.data || []).filter(aOk).map(aMap(h));
}
async function itunes(q, country = 'US', limit = 25, attr = '') {
  const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}&country=${country}${attr ? '&attribute=' + attr : ''}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('http ' + r.status);
  return ((await r.json()).results || []).filter(t => t.previewUrl).map(t => ({
    title: t.trackName, artist: t.artistName + ' · превью 30 с', album: t.collectionName || '', dur: 30,
    art: t.artworkUrl100 && t.artworkUrl100.replace('100x100', '300x300'), url: t.previewUrl
  }));
}
const uniq = list => { const seen = new Set(); return list.filter(t => { const k = nrm(t.title) + '|' + nrm(t.artist.split(' · ')[0]); if (seen.has(k)) return false; seen.add(k); return true; }); };
const mix = lists => { const out = []; for (let i = 0; i < Math.max(0, ...lists.map(l => l.length)); i++) lists.forEach(l => l[i] && out.push(l[i])); return uniq(out); };
const okv = rs => rs.map(r => r.status === 'fulfilled' ? r.value : []);
// полные треки идут первыми, превью — после них
const merge = (full, prev) => { const f = uniq(full), seen = new Set(f.map(t => nrm(t.title))); return [...f, ...uniq(prev).filter(t => !seen.has(nrm(t.title)))]; };


// Регион определяется по системе пользователя (а не зашит как RU): витрина iTunes своей страны + US,
// для кириллицы дополнительно RU/UA, чтобы находились русские и украинские треки в любой стране.
const homeCC = () => { try { const c = String(app.getLocaleCountryCode() || '').toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : 'US'; } catch (e) { return 'US'; } };
const storefronts = q => [...new Set([homeCC(), 'US', ...(/[а-яёіїєґ]/i.test(q) ? ['RU', 'UA'] : [])])].slice(0, 4);

// Jamendo: бесплатная музыка с полными треками. Нужен бесплатный client_id (devportal.jamendo.com), его вводят в настройках.
async function jamendo(q, key, limit = 30) {
  const r = await fetch(`https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(key)}&format=json&limit=${limit}&audioformat=mp32&imagesize=200&search=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  if (j.headers && j.headers.status === 'failed') throw new Error(j.headers.error_message || 'jamendo');
  return (j.results || []).filter(t => t.audio).map(t => ({ title: t.name, artist: t.artist_name, dur: t.duration, art: t.image, album: t.album_name || '', url: t.audio }));
}
// популярное на Jamendo (полные треки, нужен бесплатный ключ)
async function jamendoPopular(key, limit = 30) {
  const r = await fetch(`https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(key)}&format=json&limit=${limit}&audioformat=mp32&imagesize=200&order=popularity_week`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  if (j.headers && j.headers.status === 'failed') throw new Error(j.headers.error_message || 'jamendo');
  return (j.results || []).filter(t => t.audio).map(t => ({ title: t.name, artist: t.artist_name, dur: t.duration, art: t.image, album: t.album_name || '', url: t.audio }));
}
async function deezer(q, limit = 25) {
  const r = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json(); if (j.error) throw new Error(j.error.message || 'deezer');
  return (j.data || []).filter(t => t.preview).map(t => ({
    title: t.title, artist: ((t.artist && t.artist.name) || '') + ' · превью 30 с', album: (t.album && t.album.title) || '', dur: 30,
    art: t.album && (t.album.cover_medium || t.album.cover), url: t.preview
  }));
}
// выполняет источники параллельно и запоминает, что ответил каждый (для подсказки, если пусто)
const runAll = async spec => {
  const rs = await Promise.allSettled(spec.map(s => s.fn()));
  return spec.map((s, i) => ({ name: s.name, prev: !!s.prev, list: rs[i].status === 'fulfilled' ? rs[i].value : [], err: rs[i].status === 'rejected' ? ((rs[i].reason && rs[i].reason.message) || 'ошибка') : null }));
};
const finish = out => {
  if (out.every(o => o.err)) throw new Error('offline');
  const g = p => out.filter(o => o.prev === p);
  const list = merge(mix(g(false).map(o => o.list)), mix(g(true).map(o => o.list)));
  const info = out.map(o => o.name + ': ' + (o.err ? 'нет связи (' + String(o.err).replace(/^.*?(net::\w+|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|http \d+).*$/s, '$1').slice(0, 40) + ')' : o.list.length));
  return { list, info };
};

// ---- Режим превью: 'always' (по умолчанию) | 'fallback' (только если полных треков нет) | 'never'
const pmode = o => { const p = o && o.previews; return p === 'never' || p === false ? 'never' : p === 'fallback' ? 'fallback' : 'always'; };
// полные источники идут первыми; 30-секундные превью по режиму
async function gather(full, prev, pm) {
  let out = await runAll(pm === 'always' ? [...full, ...prev] : full);
  if (pm === 'fallback' && out.every(o => o.err || !o.list.length)) out = [...out, ...await runAll(prev)];
  return out;
}
const infoOf = out => out.map(o => o.name + ': ' + (o.err ? 'нет связи (' + String(o.err).replace(/^.*?(net::\w+|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|http \d+).*$/s, '$1').slice(0, 40) + ')' : o.list.length));
const jkey = o => String((o && o.jamendo) || '').trim();
const tsig = () => ({ signal: AbortSignal.timeout(9000) });
const getJ = async u => { const r = await fetch(u, tsig()); if (!r.ok) throw new Error('http ' + r.status); return r.json(); };
const PV = ' · превью 30 с';

// ---- Deezer / Apple: чарты, новинки, похожие исполнители (официальные публичные API, 30-секундные превью)
const dzMap = (t, alb, cover) => ({ title: t.title, artist: ((t.artist && t.artist.name) || '') + PV, album: (t.album && t.album.title) || alb || '', dur: 30, art: (t.album && (t.album.cover_medium || t.album.cover)) || cover, url: t.preview });
async function deezerChart(limit = 40) {
  const j = await getJ(`https://api.deezer.com/chart/0/tracks?limit=${limit}`);
  if (j.error) throw new Error(j.error.message || 'deezer');
  return (j.data || []).filter(t => t.preview).map(t => dzMap(t));
}
async function deezerNew(albums = 10) {
  const j = await getJ(`https://api.deezer.com/editorial/0/releases?limit=${albums}`);
  if (j.error) throw new Error(j.error.message || 'deezer');
  const rs = await Promise.allSettled((j.data || []).slice(0, albums).map(async al => {
    const t = await getJ(`https://api.deezer.com/album/${al.id}/tracks?limit=3`);
    return (t.data || []).filter(x => x.preview).slice(0, 2).map(x => dzMap({ ...x, artist: x.artist || al.artist }, al.title, al.cover_medium));
  }));
  return okv(rs).flat();
}
async function deezerRelatedTop(name) {
  const s = await getJ(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=1`);
  const id = s.data && s.data[0] && s.data[0].id; if (!id) return [];
  const rel = await getJ(`https://api.deezer.com/artist/${id}/related?limit=3`);
  const rs = await Promise.allSettled((rel.data || []).slice(0, 3).map(async r => dzTop(r.id)));
  return okv(rs).flat();
}
async function dzTop(id) { const t = await getJ(`https://api.deezer.com/artist/${id}/top?limit=5`); return (t.data || []).filter(x => x.preview).map(x => dzMap(x)); }
const appleMap = t => ({ title: t.trackName, artist: t.artistName + PV, album: t.collectionName || '', dur: 30, art: t.artworkUrl100 && t.artworkUrl100.replace('100x100', '300x300'), url: t.previewUrl });
async function appleLookup(ids, cc, extra = '') {
  const j = await getJ(`https://itunes.apple.com/lookup?id=${ids.join(',')}&country=${cc}${extra}`);
  return (j.results || []).filter(t => t.previewUrl && (t.kind === 'song' || t.wrapperType === 'track'));
}
async function appleTop(cc, limit = 40) {
  let err;
  for (const c of [cc, 'US']) {
    const lc = c.toLowerCase();
    try {   // 1) актуальный RSS Apple + lookup превью
      const j = await getJ(`https://rss.applemarketingtools.com/api/v2/${lc}/music/most-played/${limit}/songs.json`);
      const ids = ((j.feed && j.feed.results) || []).map(x => x.id);
      if (ids.length) {
        const byId = new Map((await appleLookup(ids, c)).map(t => [String(t.trackId), t]));
        const l = ids.map(id => byId.get(String(id))).filter(Boolean).map(appleMap);
        if (l.length) return l;
      }
    } catch (e) { err = e; }
    try {   // 2) старый RSS (сразу со ссылками на превью)
      const j = await getJ(`https://itunes.apple.com/${lc}/rss/topsongs/limit=${limit}/json`);
      const l = ((j.feed && j.feed.entry) || []).map(e => {
        const pv = (e.link || []).map(x => x.attributes).find(x => x && x['im:assetType'] === 'preview');
        const im = e['im:image'] || [], col = e['im:collection'];
        return pv && { title: e['im:name'].label, artist: e['im:artist'].label + PV, album: (col && col['im:name'] && col['im:name'].label) || '', dur: 30, art: im.length ? im[im.length - 1].label.replace(/\d+x\d+/, '300x300') : undefined, url: pv.href };
      }).filter(Boolean);
      if (l.length) return l;
    } catch (e) { err = e; }
  }
  throw err || new Error('apple');
}
async function appleNew(cc, n = 15) {
  let err;
  for (const c of [cc, 'US']) for (const path of ['apple-music', 'music']) {
    try {
      const j = await getJ(`https://rss.applemarketingtools.com/api/v2/${c.toLowerCase()}/${path}/new-releases/${n}/albums.json`);
      const ids = ((j.feed && j.feed.results) || []).map(x => x.id);
      if (!ids.length) continue;
      const tr = await appleLookup(ids, c, `&entity=song&limit=${ids.length * 4}`), per = new Map(), out = [];
      for (const t of tr) { const k = t.collectionId, c2 = per.get(k) || 0; if (c2 < 2) { per.set(k, c2 + 1); out.push(appleMap(t)); } }
      if (out.length) return out;
    } catch (e) { err = e; }
  }
  throw err || new Error('apple-new');
}
async function jamendoList(key, order, limit = 30) {
  const j = await getJ(`https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(key)}&format=json&limit=${limit}&audioformat=mp32&imagesize=200&order=${order}`);
  if (j.headers && j.headers.status === 'failed') throw new Error(j.headers.error_message || 'jamendo');
  return (j.results || []).filter(t => t.audio).map(t => ({ title: t.name, artist: t.artist_name, album: t.album_name || '', dur: t.duration, art: t.image, url: t.audio }));
}
async function audiusUnderground(limit = 25) {
  const { j, h } = await afetch(`/tracks/trending/underground?limit=${limit}`);
  return (j.data || []).filter(aOk).map(aMap(h));
}

// ---- Поиск (по названию, исполнителю, альбому) с исправлением опечаток
const searchSpecs = (q, opts) => {
  const jk = jkey(opts), full = [{ name: 'Audius', fn: () => audius(q, 40) }, { name: 'Audius (артист)', fn: () => audiusArtist(q) }];
  if (jk) full.push({ name: 'Jamendo', fn: () => jamendo(q, jk) });
  const prev = [...storefronts(q).map((c, i) => ({ name: 'iTunes ' + c, prev: 1, fn: () => itunes(q, c, i ? 25 : 40) })),
    { name: 'iTunes (альбом)', prev: 1, fn: () => itunes(q, homeCC(), 25, 'albumTerm') }, { name: 'Deezer', prev: 1, fn: () => deezer(q, 40) }];
  return { full, prev };
};
const finishOut = out => {
  if (out.every(o => o.err)) throw new Error('offline');
  const g = p => out.filter(o => o.prev === p);
  return { list: merge(mix(g(false).map(o => o.list)), mix(g(true).map(o => o.list))), info: infoOf(out) };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let mbNext = 0;   // MusicBrainz разрешает не чаще 1 запроса в секунду
async function mb(pq) {
  const wait = Math.max(0, mbNext - Date.now()); mbNext = Date.now() + wait + 1100; if (wait) await sleep(wait);
  const r = await fetch('https://musicbrainz.org/ws/2/' + pq, { headers: { 'User-Agent': 'Razy/1.0 (desktop music player)', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}
const lev = (a, b) => { const d = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { let p = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } } return d[b.length]; };
const sim = (a, b) => { a = nrm(a); b = nrm(b); const m = Math.max(a.length, b.length); return m ? 1 - lev(a, b) / m : 0; };
// Исправление опечаток: нечёткий поиск MusicBrainz; берём вариант, который достаточно похож на запрос
async function correct(q) {
  const nq = nrm(q); if (nq.length < 3) return null;
  const fz = nq.split(' ').map(w => w.length > 3 ? w + '~' : w).join(' ');
  const [ar, rc] = await Promise.allSettled([mb(`artist?query=${encodeURIComponent(fz)}&fmt=json&limit=3`), mb(`recording?query=${encodeURIComponent(fz)}&fmt=json&limit=3`)]);
  const cands = [];
  if (ar.status === 'fulfilled') for (const a of ar.value.artists || []) cands.push({ text: a.name, forms: [a.name], score: a.score });
  if (rc.status === 'fulfilled') for (const r of rc.value.recordings || []) {
    const cr = ((r['artist-credit'] || [])[0] || {}).name || '';
    cands.push({ text: (cr + ' ' + r.title).trim(), forms: [r.title, cr + ' ' + r.title, r.title + ' ' + cr], score: r.score });
  }
  let best = null, bs = 0;
  for (const c of cands) {
    if (!c.text || (c.score || 0) < 80) continue;
    const s = Math.max(...c.forms.map(f => sim(q, f)));
    if (s > bs) { bs = s; best = c; }
  }
  return best && bs >= 0.6 && nrm(best.text) !== nq && !best.forms.some(f => nrm(f) === nq) ? best.text : null;
}
ipcMain.handle('search', async (_e, q, opts) => {
  q = String(q || '').trim();
  const pm = pmode(opts), run = async s => { const sp = searchSpecs(s, opts); return finishOut(await gather(sp.full, sp.prev, pm)); };
  const res = await run(q);
  if (!(opts && opts.noCorrect) && res.list.length < 3) {
    try {
      const c = await correct(q);
      if (c) { const r2 = await run(c); if (r2.list.length > res.list.length) return { ...r2, corrected: c, original: q }; }
    } catch (e) {}
  }
  return res;
});

// ---- Подсказки при вводе: Deezer autocomplete + iTunes + Audius (названия исполнителей)
const sugCache = new Map();
ipcMain.handle('suggest', async (_e, q) => {
  q = String(q || '').trim(); if (q.length < 2) return [];
  const ck = nrm(q); if (sugCache.has(ck)) return sugCache.get(ck);
  const cc = homeCC();
  const [dz, it, ia, au] = await Promise.allSettled([
    getJ(`https://api.deezer.com/search/autocomplete?q=${encodeURIComponent(q)}&limit=5`),
    getJ(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=musicArtist&limit=3&country=${cc}`),
    getJ(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=5&country=${cc}`),
    afetch(`/users/search?query=${encodeURIComponent(q)}&limit=3`).then(r => r.j)
  ]);
  const artists = [], tracks = [], albums = [], v = r => r.status === 'fulfilled' ? r.value : {};
  const d = v(dz);
  ((d.artists || {}).data || []).forEach(a => a.name && artists.push({ text: a.name, label: a.name, kind: 'artist' }));
  ((d.tracks || {}).data || []).forEach(t => t.title && tracks.push({ text: ((t.artist || {}).name + ' ' + t.title).trim(), label: t.title + ' — ' + ((t.artist || {}).name || ''), kind: 'track' }));
  ((d.albums || {}).data || []).forEach(a => a.title && albums.push({ text: ((a.artist || {}).name + ' ' + a.title).trim(), label: a.title + ' — ' + ((a.artist || {}).name || ''), kind: 'album' }));
  (v(it).results || []).forEach(a => a.artistName && artists.push({ text: a.artistName, label: a.artistName, kind: 'artist' }));
  (v(au).data || []).forEach(a => a.name && artists.push({ text: a.name, label: a.name + ' · Audius', kind: 'artist' }));
  (v(ia).results || []).forEach(t => t.trackName && tracks.push({ text: (t.artistName + ' ' + t.trackName).trim(), label: t.trackName + ' — ' + t.artistName, kind: 'track' }));
  const seen = new Set(), out = [];
  for (const s of [...artists.slice(0, 4), ...tracks.slice(0, 4), ...albums.slice(0, 3), ...artists.slice(4), ...tracks.slice(4)]) {
    const k = nrm(s.text); if (!k || seen.has(k)) continue; seen.add(k); out.push(s); if (out.length >= 8) break;
  }
  if (sugCache.size > 200) sugCache.clear();
  sugCache.set(ck, out);
  return out;
});

// ---- Разделы: Популярное / Новинки / Рекомендации
const POPULAR = [];
async function section(kind, opts, seeds) {
  const pm = pmode(opts), jk = jkey(opts), cc = homeCC();
  let full = [], prev = [], note = '';
  seeds = (Array.isArray(seeds) ? seeds : []).map(s => String(s).trim()).filter(Boolean).slice(0, 4);
  if (kind === 'recs' && !seeds.length) { kind = 'popular'; note = 'Слушайте музыку и ставьте лайки: рекомендации подстроятся под вас. Пока показано популярное.'; }
  if (kind === 'popular') {
    full = [{ name: 'Audius: неделя', fn: () => audiusTrending('week') }, { name: 'Audius: месяц', fn: () => audiusTrending('month') }, { name: 'Audius: за всё время', fn: () => audiusTrending('allTime') },
      ...['Electronic', 'Hip-Hop/Rap', 'Pop', 'R&B/Soul'].map(g => ({ name: 'Audius ' + g, fn: () => audiusTrending('week', g, 15) }))];
    if (jk) full.push({ name: 'Jamendo: популярное', fn: () => jamendoList(jk, 'popularity_week') });
    prev = [{ name: 'Apple: чарт ' + cc, prev: 1, fn: () => appleTop(cc) }, { name: 'Deezer: чарт', prev: 1, fn: () => deezerChart() }];
  } else if (kind === 'new') {
    full = [{ name: 'Audius: свежее', fn: () => audiusUnderground() }];
    if (jk) full.push({ name: 'Jamendo: новинки', fn: () => jamendoList(jk, 'releasedate_desc') });
    prev = [{ name: 'Apple: новые релизы', prev: 1, fn: () => appleNew(cc) }, { name: 'Deezer: новые релизы', prev: 1, fn: () => deezerNew() }];
  } else {
    full = seeds.map(s => ({ name: 'Audius ' + s, fn: () => audiusArtist(s) }));
    if (jk) full.push(...seeds.map(s => ({ name: 'Jamendo ' + s, fn: () => jamendo(s, jk, 8) })));
    prev = seeds.flatMap(s => [{ name: 'iTunes ' + s, prev: 1, fn: () => itunes(s, cc, 8, 'artistTerm') }, { name: 'Deezer похожие: ' + s, prev: 1, fn: () => deezerRelatedTop(s) }]);
  }
  const out = await gather(full, prev, pm);
  if (out.every(o => o.err)) throw new Error('offline');
  return { list: mix(out.map(o => o.list)).slice(0, 100), info: infoOf(out), note };
}
ipcMain.handle('section', (_e, kind, opts, seeds) => section(kind, opts, seeds));
ipcMain.handle('popular', (_e, opts) => section('popular', opts, []));


// Подбор трека для импорта плейлистов: ищет «исполнитель + название» по включённым источникам
// и берёт только результат, у которого совпали и название, и исполнитель.
const cleanTitle = s => String(s || '').replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/\s+-\s+(remaster(ed)?|radio edit|live|version|feat).*$/i, '').replace(/\s*\b(feat\.?|ft\.?)\s.*$/i, '').trim();
ipcMain.handle('match', async (_e, artist, title, opts) => {
  const t = cleanTitle(title), a = String(artist || '').split(/\s*(?:,|;|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0].trim();
  const nt = nrm(t), na = nrm(a), q = (a + ' ' + t).trim();
  if (!nt) return { track: null };
  const prev = pmode(opts) !== 'never', jk = String((opts && opts.jamendo) || '').trim();
  const spec = [{ name: 'Audius', fn: () => audius(q, 10) }];
  if (jk) spec.push({ name: 'Jamendo', fn: () => jamendo(q, jk, 10) });
  if (prev) spec.push(...storefronts(q).slice(0, 2).map(c => ({ name: 'iTunes ' + c, prev: 1, fn: () => itunes(q, c, 10) })));
  const out = await runAll(spec);
  if (out.every(o => o.err)) return { error: 'offline' };
  let best = null, bs = 0;
  for (const c of out.flatMap(o => o.list)) {
    const ct = nrm(cleanTitle(c.title)), ca = nrm(String(c.artist).split(' · ')[0]);
    const ts = ct === nt ? 3 : (nt.length > 3 && ct.length > 3 && (ct.includes(nt) || nt.includes(ct))) ? 2 : 0;
    const as = !na ? 1 : (ca && (ca.includes(na) || na.includes(ca))) ? 2 : 0;
    if (!ts || !as) continue;
    const s = ts * 10 + as * 3 + (/превью/.test(c.artist) ? 0 : 4);
    if (s > bs) { bs = s; best = c; }
  }
  return { track: best };
});

// ---- Spotify: треки публичного плейлиста по ссылке. Без ключей, без входа и без файлов:
// читаем ту же страницу-плеер, которую Spotify отдаёт для вставки на сайты (/embed/playlist/ID).
function parseSpotifyEmbed(html) {
  const mm = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!mm) return null;
  let data; try { data = JSON.parse(mm[1]); } catch (e) { return null; }
  let ent = null;
  (function walk(o, d) {
    if (ent || !o || typeof o !== 'object' || d > 14) return;
    if (Array.isArray(o.trackList)) { ent = o; return; }
    for (const k in o) walk(o[k], d + 1);
  })(data, 0);
  if (!ent) return null;
  const clean = x => String(x == null ? '' : x).replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
  const entries = ent.trackList.map(t => ({ title: clean(t && t.title), artist: clean(t && (t.subtitle || (t.artists && t.artists.map(a => a.name).join(', ')))) })).filter(t => t.title);
  return { name: clean(ent.name || ent.title), entries };
}
ipcMain.handle('spotify:playlist', async (_e, input) => {
  const m = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/|spotify:playlist:)([A-Za-z0-9]{10,40})/.exec(String(input || ''));
  if (!m) return { error: 'badlink' };
  try {
    const r = await fetch('https://open.spotify.com/embed/playlist/' + m[1], {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15000)
    });
    if (r.status === 404 || r.status === 403) return { error: 'private' };
    if (!r.ok) return { error: 'http ' + r.status };
    const p = parseSpotifyEmbed(await r.text());
    if (!p) return { error: 'format' };
    if (!p.entries.length) return { error: 'empty' };
    return { name: p.name, entries: p.entries, total: p.entries.length };
  } catch (e) { return { error: 'offline' }; }
});

// YouTube: официальный Data API v3 (бесплатный ключ пользователя) + встроенный плеер YouTube (полные треки)
const isoDur = x => { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(x || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
ipcMain.handle('yt:search', async (_e, key, q) => {
  key = String(key || '').trim(); q = String(q || '').trim();
  if (!key) return { error: 'nokey' };
  const api = async (ep, params) => {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/${ep}?${new URLSearchParams({ ...params, key })}`, { signal: AbortSignal.timeout(9000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ('http ' + r.status)); e.code = r.status; throw e; }
    return j;
  };
  const PART = 'snippet,contentDetails,status';
  try {
    let items = [];
    if (q) {
      const find = async cat => {
        const o = { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '25', q };
        if (cat) o.videoCategoryId = '10';
        const sr = await api('search', o);
        const ids = (sr.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
        return ids.length ? (await api('videos', { part: PART, id: ids.join(',') })).items || [] : [];
      };
      items = await find(true);
      if (items.length < 5) items = await find(false);
    } else {
      for (const rc of [homeCC(), 'US']) {
        try { items = (await api('videos', { part: PART, chart: 'mostPopular', videoCategoryId: '10', regionCode: rc, maxResults: '30' })).items || []; } catch (e) { if (e.code === 403 || e.code === 400 && /key/i.test(e.message)) throw e; }
        if (items.length) break;
      }
    }
    const list = items.filter(v => !v.status || v.status.embeddable !== false).map(v => ({
      id: v.id, title: v.snippet.title, channel: (v.snippet.channelTitle || '').replace(/ - Topic$/, ''),
      thumb: v.snippet.thumbnails && ((v.snippet.thumbnails.medium || v.snippet.thumbnails.default) || {}).url,
      dur: isoDur(v.contentDetails && v.contentDetails.duration)
    })).filter(v => !v.dur || v.dur < 1200);   // без часовых миксов и стримов
    return { list };
  } catch (e) {
    return { error: e.code === 400 || e.code === 403 ? 'key' : 'net', message: (e && e.message) || '' };
  }
});

// Тексты песен: LRCLIB (бесплатно, без ключа). Есть синхронные (с таймкодами) и обычные.
const lyrCache = new Map();
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const UNKNOWN = /^(неизвестный исполнитель|unknown artist|audius)$/i;
ipcMain.handle('lyrics', async (_e, artist, title, dur) => {
  // Чистка мусора из названий (особенно из имён скачанных файлов): номера треков, сайты, битрейт, «official video»…
  const WORDS = /(?<![\p{L}\p{N}])(?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video)|lyric\s*video|lyrics?|audio|video\s*clip|клип|премьера\s*клипа|hd|4k|\d{2,3}\s*kbps)(?![\p{L}\p{N}])/giu;
  const clean = s => String(s || '').replace(/_+/g, ' ').replace(/\s*[·•].*$/, '')
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|ru|net|org|me|fm|su|info|biz|ua|by|kz|cc|to|ws|pro)\b\S*/gi, ' ')
    .replace(/^\s*\d{1,3}\s*[.)]\s*/, '').replace(/^\s*\d{1,3}\s*[-–—]\s+/, '')
    .replace(WORDS, ' ')
    .replace(/\s+-\s+(remaster(ed)?|radio edit|live|version).*$/i, '')
    .replace(/\s{2,}/g, ' ').replace(/^[\s\-–—]+|[\s\-–—]+$/g, '').trim();
  const A0 = UNKNOWN.test(String(artist || '').trim()) ? '' : clean(artist), T0 = clean(title);
  if (!T0) return null;
  dur = +dur || 0;
  const key = (A0 + '|' + T0 + '|' + (dur ? Math.round(dur) : '')).toLowerCase();
  if (lyrCache.has(key)) return lyrCache.get(key);

  // варианты «исполнитель / название»: как есть, а если исполнителя нет или он дублируется в названии, то разбор «A - B» в обе стороны
  const attempts = [];
  const push = (a, t) => { a = String(a || '').trim(); t = String(t || '').trim(); if (t && !attempts.some(x => x.a === a && x.t === t)) attempts.push({ a, t }); };
  const sp = T0.split(/\s+[-–—]\s+/);
  if (A0) push(A0, T0);
  if (sp.length > 1) { push(sp[0], sp.slice(1).join(' - ')); push(sp.slice(1).join(' - '), sp[0]); }
  if (!A0 || sp.length === 1) push(A0, T0);
  attempts.length = Math.min(attempts.length, 3);

  const st = { ok: 0, err: 0 };   // чтобы отличать «не найдено» от «нет интернета»
  const H = (ms = 9000) => ({ headers: { 'User-Agent': 'Razy/1.0 (desktop music player)' }, signal: AbortSignal.timeout(ms) });
  const get = async (u, ms) => { try { const r = await fetch(u, H(ms)); st.ok++; return r.ok ? await r.json() : null; } catch (e) { st.err++; return null; } };
  const strip = x => String(x || '').split('\n').map(l => l.replace(/\[[^\]]*\]/g, '').trim()).join('\n');
  const done = (j, d) => {
    const synced = j.syncedLyrics || '', plain = j.plainLyrics || strip(synced);
    return { synced, plain, matched: `${j.artistName} — ${j.trackName}`, mismatch: !!(synced && d > 4) };
  };
  const dOf = j => (dur > 30 && j.duration) ? Math.abs(j.duration - dur) : 0;
  const has = j => j && (j.syncedLyrics || j.plainLyrics);
  const pick = list => list.map(j => ({ j, d: dOf(j) })).sort((x, y) => (x.d > 4) - (y.d > 4) || (!!y.j.syncedLyrics - !!x.j.syncedLyrics) || x.d - y.d)[0];

  let res = null;
  // 1-2) LRCLIB: точное совпадение, затем поиск с проверкой названия, исполнителя и длительности
  for (const { a, t } of attempts) {
    const A1 = a.split(/\s*(?:,|&|(?<![\p{L}\p{N}])(?:feat\.?|ft\.?|x|и)(?![\p{L}\p{N}]))\s*/iu)[0].trim();
    const nt = norm(t), na = norm(A1);
    const titleOk = j => { const x = norm(j.trackName); return x === nt || (nt.length > 3 && x.length > 3 && (x.includes(nt) || nt.includes(x))); };
    const artistOk = j => !na || (() => { const x = norm(j.artistName); return x.includes(na) || na.includes(x); })();
    let r1 = null;
    if (A1) {
      const base = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(A1)}&track_name=${encodeURIComponent(t)}`;
      const j = await get(dur > 30 ? base + '&duration=' + Math.round(dur) : base);
      if (has(j) && titleOk(j)) r1 = done(j, dOf(j));
    }
    if (!r1 || r1.mismatch) {
      const urls = [`https://lrclib.net/api/search?track_name=${encodeURIComponent(t)}${A1 ? '&artist_name=' + encodeURIComponent(A1) : ''}`,
        `https://lrclib.net/api/search?q=${encodeURIComponent((A1 + ' ' + t).trim())}`];
      const cands = (await Promise.all(urls.map(u => get(u)))).flatMap(L => Array.isArray(L) ? L : []).filter(j => has(j) && titleOk(j) && artistOk(j));
      const best = pick(cands);
      if (best && (!r1 || best.d <= 4)) r1 = done(best.j, best.d);
    }
    if (r1 && (!res || !r1.mismatch)) res = r1;
    if (res && !res.mismatch) break;
  }
  // 3) свободный поиск LRCLIB по словам (название и исполнитель в любом порядке, для кривых имён файлов)
  if (!res) {
    const words = norm(A0 + ' ' + T0).split(' ').filter(w => w.length > 1);
    if (words.length >= 2) {
      const L = await get(`https://lrclib.net/api/search?q=${encodeURIComponent(words.join(' '))}`);
      const cands = (Array.isArray(L) ? L : []).filter(j => has(j) && words.every(w => norm(j.artistName + ' ' + j.trackName).includes(w)));
      const best = pick(cands);
      if (best) res = done(best.j, best.d);
    }
  }
  // 4) запасной источник: lyrics.ovh (только обычный текст, без таймкодов)
  if (!res) {
    for (const { a, t } of attempts.filter(x => x.a).slice(0, 2)) {
      const j = await get(`https://api.lyrics.ovh/v1/${encodeURIComponent(a)}/${encodeURIComponent(t)}`, 7000);
      const txt = j && typeof j.lyrics === 'string' ? j.lyrics.replace(/\r/g, '').replace(/^(paroles de la chanson|lyrics for|текст песни)[^\n]*\n+/i, '').trim() : '';
      if (txt.length > 40) { res = { synced: '', plain: txt, matched: `${a} — ${t}`, mismatch: false }; break; }
    }
  }
  if (!res && !st.ok && st.err) return { error: 'offline' };   // сети нет: не запоминаем «не найдено»
  lyrCache.set(key, res);
  return res;
});

// Адрес сервера общих треков (config.json → server); пользователь может поменять его в Профиле
ipcMain.handle('cfg:get', () => { let c = {}; try { c = require('./config.json'); } catch (e) {} return { server: String(c.server || '') }; });

const mailFile = () => path.join(app.getPath('userData'), 'mail.json');
const getMail = () => {
  try { return JSON.parse(fs.readFileSync(mailFile(), 'utf8')); } catch (e) {}
  try { return require('./mail-default.json'); } catch (e) {}
  return null;
};
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const codes = new Map(); // почта -> { hash, exp, tries, sent }
ipcMain.handle('mail:setCfg', (_e, c) => {
  fs.writeFileSync(mailFile(), JSON.stringify({ host: String(c.host), port: +c.port || 465, user: String(c.user), pass: String(c.pass), from: String(c.from || c.user) }));
  return true;
});
ipcMain.handle('mail:send', async (_e, email) => {
  email = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Некорректная почта' };
  const m = getMail();
  if (!m || !m.host || !m.user || !m.pass) return { ok: false, error: 'nocfg' };
  const old = codes.get(email);
  if (old && Date.now() - old.sent < 60000) return { ok: false, error: 'Подождите минуту перед повторной отправкой' };
  const code = String(crypto.randomInt(100000, 1000000));
  try {
    const tr = nodemailer.createTransport({ host: m.host, port: m.port, secure: m.port === 465, auth: { user: m.user, pass: m.pass } });
    await tr.sendMail({
      from: `Razy <${m.from}>`, to: email, subject: 'Код подтверждения Razy',
      text: `Ваш код подтверждения Razy: ${code}\nОн действует 10 минут. Если вы его не запрашивали, просто проигнорируйте письмо.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:28px;background:#100c1c;color:#f5f3ff;border-radius:18px"><h2 style="margin:0 0 12px">Razy</h2><p>Ваш код подтверждения:</p><p style="font-size:34px;letter-spacing:8px;font-weight:800;color:#d946ef;margin:12px 0">${code}</p><p style="color:#9b92b8;font-size:13px">Код действует 10 минут. Если вы его не запрашивали, просто проигнорируйте письмо.</p></div>`
    });
  } catch (e) { return { ok: false, error: 'Не удалось отправить письмо: ' + ((e && e.message) || 'ошибка') }; }
  codes.set(email, { hash: sha(code), exp: Date.now() + 600000, tries: 0, sent: Date.now() });
  return { ok: true };
});
ipcMain.handle('mail:check', (_e, email, code) => {
  email = String(email).trim().toLowerCase();
  const c = codes.get(email);
  if (!c || Date.now() > c.exp) return { ok: false, error: 'Код истёк. Запросите новый.' };
  if (++c.tries > 5) { codes.delete(email); return { ok: false, error: 'Слишком много попыток. Запросите новый код.' }; }
  if (sha(String(code).trim()) !== c.hash) return { ok: false, error: 'Неверный код' };
  codes.delete(email);
  return { ok: true };
});

// ---- встроенный сервер Razy: стартует вместе с приложением на встроенном в Electron Node.js ----
let srv = null;
function startServer() {
  let c = {}; try { c = require('./config.json'); } catch (e) {}
  let u; try { u = new URL(c.server || 'http://localhost:3000'); } catch (e) { return; }
  // если в config.json указан чужой (публичный) сервер, свой запускать не нужно
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return;
  const script = path.join(__dirname, 'server', 'server.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (!fs.existsSync(script)) { console.error('Razy server: нет файла', script); return; }
  const dataDir = path.join(app.getPath('userData'), 'server-data');
  try {
    srv = fork(script, [], {
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', DATA_DIR: dataDir,
        PORT: u.port || (u.protocol === 'https:' ? '443' : '80')
      }),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
    });
    // код ≠ 0 обычно значит «порт занят»: на нём уже работает другой сервер Razy, это нормально
    srv.on('exit', code => { console.log('Razy server остановлен, код', code); srv = null; });
    srv.on('error', e => console.error('Razy server:', e.message));
  } catch (e) { console.error('Razy server:', e.message); }
}
function stopServer() { try { srv && srv.kill(); } catch (e) {} srv = null; }

// Ускорение отрисовки: GPU-растеризация даже на «чёрных списках» старых видеокарт
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');


// ---- Мини-плеер: маленькое окно в углу экрана, пока Razy свёрнут и играет музыка ----
let mini = null, miniDismissed = false, miniPreview = null, miniLast = {};
let miniCfg = { enabled: true, mode: 'playing', viz: true, spin: true, size: 1, corner: 'br', top: true, style: 'card', theme: 'black' };
const MINI_W = 340, MINI_H = 112;
// «Остров»: окно с запасом под раскрытый вид; сама таблетка (свёрнутая / раскрытая) рисуется внутри, по центру сверху
const ISL = { W: 440, H: 200, top: 8, cw: 240, ch: 36, ow: 380, oh: 162 };
let winFocused = true, loadedStyle = 'card', islT = null, islHover = false, islLeaveAt = 0;
const isIsland = () => miniCfg.style === 'island';
const miniAlive = () => !!mini && !mini.isDestroyed();
const miniVisible = () => miniAlive() && mini.isVisible();
function miniPlace() {
  if (!miniAlive()) return;
  const k = Math.max(.6, Math.min(1.6, Number(miniCfg.size) || 1)), isl = loadedStyle === 'island';
  const w = Math.round((isl ? ISL.W : MINI_W) * k), h = Math.round((isl ? ISL.H : MINI_H) * k), mg = 16;
  let d; try { d = screen.getDisplayMatching(win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().bounds); } catch (e) { d = screen.getPrimaryDisplay(); }
  const a = d.workArea, c = String(miniCfg.corner || 'br');
  let x = c[1] === 'l' ? a.x + mg : a.x + a.width - w - mg, y = c[0] === 't' ? a.y + mg : a.y + a.height - h - mg;
  if (isl) { x = a.x + Math.round((a.width - w) / 2); y = a.y; }   // остров: по центру сверху
  mini.setBounds({ x, y, width: w, height: h });
  try { mini.webContents.setZoomFactor(k); } catch (e) {}
  mini.setAlwaysOnTop(!!miniCfg.top, 'screen-saver');
}
// Остров: раз в 50 мс смотрим, где курсор. Над таблеткой окно ловит клики и раскрывается, вокруг неё клики проходят насквозь.
function islStop() { clearInterval(islT); islT = null; islHover = false; islLeaveAt = 0; }
function islSetHover(v) {
  islHover = v; islLeaveAt = 0;
  if (!miniAlive()) return;
  try { mini.setIgnoreMouseEvents(!v, { forward: true }); mini.webContents.send('mini:hover', v); } catch (e) {}
}
function islTick() {
  if (!miniVisible() || loadedStyle !== 'island') return islStop();
  const p = screen.getCursorScreenPoint(), b = mini.getBounds(), k = b.width / ISL.W;
  const pw = (islHover ? ISL.ow : ISL.cw) * k, ph = (islHover ? ISL.oh : ISL.ch) * k, m = (islHover ? 8 : 6) * k;
  const x = b.x + (b.width - pw) / 2, y = b.y + ISL.top * k;
  const inside = p.x >= x - m && p.x <= x + pw + m && p.y >= b.y && p.y <= y + ph + m;
  if (inside) { islLeaveAt = 0; if (!islHover) islSetHover(true); }
  else if (islHover) { if (!islLeaveAt) islLeaveAt = Date.now(); else if (Date.now() - islLeaveAt > 280) islSetHover(false); }
}
function miniDestroy() {
  islStop();
  const w = mini; mini = null;
  try { w && !w.isDestroyed() && w.destroy(); } catch (e) {}
}
function miniEnsure() {
  if (miniAlive()) return mini;
  loadedStyle = isIsland() ? 'island' : 'card';
  const w = mini = new BrowserWindow({
    width: loadedStyle === 'island' ? ISL.W : MINI_W, height: loadedStyle === 'island' ? ISL.H : MINI_H, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, show: false, hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000', title: 'Razy — мини-плеер',
    webPreferences: { preload: path.join(__dirname, 'mini-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  w.setMenuBarVisibility(false);
  if (loadedStyle === 'island') w.setIgnoreMouseEvents(true, { forward: true });
  w.webContents.on('did-finish-load', () => { try { w.webContents.send('mini:cfg', miniCfg); w.webContents.send('mini:state', miniLast); miniPlace(); } catch (e) {} });
  w.on('closed', () => { if (mini === w) { mini = null; sendVisible(false); } });
  w.loadFile(path.join(__dirname, loadedStyle === 'island' ? 'app/island.html' : 'app/mini.html'));
  return w;
}
function sendVisible(v) { try { win && !win.isDestroyed() && win.webContents.send('mini:visible', !!v); } catch (e) {} }
function miniShow() {
  miniEnsure(); miniPlace();
  try { mini.webContents.send('mini:cfg', miniCfg); mini.webContents.send('mini:state', miniLast); } catch (e) {}
  mini.showInactive(); sendVisible(true);
  islStop();
  if (loadedStyle === 'island') { try { mini.setIgnoreMouseEvents(true, { forward: true }); mini.webContents.send('mini:hover', false); } catch (e) {} islT = setInterval(islTick, 50); }
}
function miniHide() { clearTimeout(miniPreview); miniPreview = null; islStop(); if (miniVisible()) mini.hide(); sendVisible(false); }
const miniWanted = () => miniCfg.enabled && !miniDismissed && (miniCfg.mode === 'always' || !!miniLast.playing);
function miniCheck() {
  if (!win || win.isDestroyed()) return;
  // «ушли из Razy»: окно свёрнуто ИЛИ просто потеряло фокус (кликнули на другое окно)
  if (win.isMinimized() || !winFocused) { if (miniWanted()) { if (!miniVisible()) miniShow(); } }
  else if (miniVisible() && !miniPreview) miniHide();
}
ipcMain.on('mini:state', (_e, s) => {
  if (!s || typeof s !== 'object') return;
  miniLast = Object.assign(miniLast, s);
  if (miniVisible()) mini.webContents.send('mini:state', s);
  miniCheck();
});
ipcMain.on('mini:viz', (_e, a) => { if (miniVisible()) mini.webContents.send('mini:viz', a); });
ipcMain.on('mini:cfg', (_e, c) => {
  if (!c || typeof c !== 'object') return;
  const n = {};
  if ('enabled' in c) n.enabled = !!c.enabled;
  if (c.mode === 'playing' || c.mode === 'always') n.mode = c.mode;
  if ('viz' in c) n.viz = !!c.viz;
  if ('spin' in c) n.spin = !!c.spin;
  if ('top' in c) n.top = !!c.top;
  if (typeof c.size === 'number' && isFinite(c.size)) n.size = Math.max(.6, Math.min(1.6, c.size));
  if (/^[tb][lr]$/.test(c.corner)) n.corner = c.corner;
  if (c.style === 'card' || c.style === 'island') n.style = c.style;
  if (c.theme === 'black' || c.theme === 'color') n.theme = c.theme;
  Object.assign(miniCfg, n);
  // сменили вид (карточка ⇄ остров): пересоздаём окно с другой страницей и, если оно было на экране, показываем снова
  if (miniAlive() && loadedStyle !== (isIsland() ? 'island' : 'card')) { const was = miniVisible(); miniDestroy(); if (was) miniShow(); }
  if (miniAlive()) { miniPlace(); mini.webContents.send('mini:cfg', miniCfg); }
  if (!miniCfg.enabled) miniHide(); else miniCheck();
});
ipcMain.on('mini:preview', () => {          // «Показать сейчас»: проверить, как выглядит и где стоит
  miniShow(); clearTimeout(miniPreview);
  const end = () => { miniPreview = null; if (islHover) { miniPreview = setTimeout(end, 2000); return; } if (!(win && !win.isDestroyed() && (win.isMinimized() || !winFocused))) miniHide(); };
  miniPreview = setTimeout(end, isIsland() ? 10000 : 6000);   // у острова дольше: нужно успеть навести курсор
});
ipcMain.on('mini:cmd', (_e, c) => {
  if (!win || win.isDestroyed()) return;
  if (c === 'toggle' || c === 'next' || c === 'prev' || (c && typeof c === 'object' && typeof c.seek === 'number')) win.webContents.send('mini:cmd', c);
  else if (c === 'close') { miniDismissed = true; miniHide(); }
  else if (c === 'open' || c === 'settings') {
    miniHide(); if (win.isMinimized()) win.restore(); win.show(); win.focus();
    if (c === 'settings') win.webContents.send('mini:cmd', 'settings');
  }
});

app.whenReady().then(() => {
  startServer();
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 420, minHeight: 600, backgroundColor: '#07050d',
    icon: path.join(__dirname, 'assets/icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: true }
  });
  win.on('minimize', () => { miniDismissed = false; miniCheck(); });
  win.on('blur', () => { winFocused = false; miniDismissed = false; miniCheck(); });
  win.on('focus', () => { winFocused = true; miniHide(); });
  win.on('restore', () => miniHide());
  win.on('show', () => { if (!win.isMinimized() && winFocused) miniHide(); });
  win.on('closed', () => { miniDestroy(); });
  // плеер YouTube отказывается играть из file:// без Referer (ошибка 153), поэтому подставляем его
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'] }, (d, cb) => {
    const h = d.requestHeaders; if (!h.Referer && !h.referer) h.Referer = 'https://razy.app/'; cb({ requestHeaders: h });
  });
  applyProxy().then(() => win.loadFile(path.join(__dirname, 'app/index.html')));
  win.webContents.on('did-finish-load', () => win.webContents.send('discord-status', status));
  connect();
});
app.on('before-quit', () => { stopServer(); try { client && client.destroy(); } catch (e) {} });
app.on('window-all-closed', () => app.quit());
