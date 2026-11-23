// Razy: сервер общих треков и профилей артистов. Без зависимостей, нужен только Node.js 18+.
//   node server/server.js            (порт 3000, данные в server/data)
// Переменные: PORT, HOST (например 127.0.0.1: слушать только этот компьютер), DATA_DIR, RAZY_ADMIN (секрет администратора; без него админ-запросы отключены)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN = process.env.RAZY_ADMIN || '';
const AUDIO = path.join(DATA, 'audio'), DBF = path.join(DATA, 'db.json');
const MAX_AUDIO = 30 * 1024 * 1024, MAX_JSON = 400 * 1024, MAX_TRACKS = 100;
const EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac' };
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };

fs.mkdirSync(AUDIO, { recursive: true });
let db = { seq: 1, artists: [], tracks: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch (e) {}
let saving = null;
const save = () => { clearTimeout(saving); saving = setTimeout(() => { const t = DBF + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, DBF); }, 150); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const img = s => (typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= 160000) ? s : '';
const url = s => { s = clip(s, 200); return /^https?:\/\/[^\s]+$/i.test(s) ? s : ''; };

const pubArtist = a => ({ id: a.id, name: a.name, genre: a.genre, bio: a.bio, avatar: a.avatar, link: a.link, status: a.status, badge: !!a.badge, created: a.created, tracks: db.tracks.filter(t => t.artist === a.id).length });
const pubTrack = t => { const a = db.artists.find(x => x.id === t.artist); return { id: t.id, artist: t.artist, artistName: a ? a.name : '', artistBadge: !!(a && a.badge), title: t.title, album: t.album, cover: t.cover, dur: t.dur, created: t.created, src: '/audio/' + t.file }; };

function send(res, code, body, extra) {
  const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Meta, X-Admin', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' }, extra || {}));
  res.end(b);
}
const fail = (res, code, msg) => send(res, code, { error: msg });
function readBody(req, limit) {
  return new Promise((ok, no) => {
    const c = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > limit) { no(Object.assign(new Error('Слишком большой файл'), { code: 413 })); req.destroy(); } else c.push(d); });
    req.on('end', () => ok(Buffer.concat(c))); req.on('error', no);
  });
}
const json = async req => { try { return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}'); } catch (e) { throw Object.assign(new Error(e.code === 413 ? e.message : 'Некорректный запрос'), { code: e.code === 413 ? 413 : 400 }); } };
const isAdmin = req => ADMIN && req.headers['x-admin'] && eq(sha(req.headers['x-admin']), sha(ADMIN));
function owner(req, a) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  return !!(m && a && a.tokenHash && eq(sha(m[1]), a.tokenHash));
}
const hits = new Map(); // простая защита от спама: не больше 20 записей в минуту с одного адреса
function limited(req) {
  const ip = req.socket.remoteAddress, now = Date.now(), l = (hits.get(ip) || []).filter(t => now - t < 60000);
  l.push(now); hits.set(ip, l); return l.length > 20;
}

async function route(req, res) {
  const u = new URL(req.url, 'http://x'), p = u.pathname, M = req.method;
  if (M === 'OPTIONS') return send(res, 204, '');

  if (M === 'GET' && p === '/api/health') return send(res, 200, { ok: true, artists: db.artists.length, tracks: db.tracks.length });

  if (M === 'GET' && p.startsWith('/audio/')) {
    const f = path.basename(p), fp = path.join(AUDIO, f);
    if (!/^[\w.-]+$/.test(f) || !fs.existsSync(fp)) return fail(res, 404, 'Нет файла');
    const size = fs.statSync(fp).size, type = MIME[path.extname(f).slice(1)] || 'application/octet-stream';
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' };
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (r) {
      let s = r[1] === '' ? Math.max(0, size - +r[2]) : +r[1], e = r[1] === '' || r[2] === '' ? size - 1 : Math.min(+r[2], size - 1);
      if (s > e || s >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
      res.writeHead(206, Object.assign(h, { 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 }));
      return fs.createReadStream(fp, { start: s, end: e }).pipe(res);
    }
    res.writeHead(200, Object.assign(h, { 'Content-Length': size }));
    return fs.createReadStream(fp).pipe(res);
  }

  if (M === 'GET' && p === '/api/artists') {
    const q = clip(u.searchParams.get('q'), 60).toLowerCase();
    const l = db.artists.filter(a => a.status === 'verified' && (!q || (a.name + ' ' + a.genre).toLowerCase().includes(q)))
      .map(pubArtist).sort((a, b) => (b.badge - a.badge) || (b.tracks - a.tracks) || b.created - a.created);
    return send(res, 200, { artists: l.slice(0, 200) });
  }
  let m;
  if (M === 'GET' && (m = /^\/api\/artists\/(\d+)$/.exec(p))) {
    const a = db.artists.find(x => x.id === +m[1]); if (!a) return fail(res, 404, 'Артист не найден');
    const own = owner(req, a);
    if (a.status !== 'verified' && !own && !isAdmin(req)) return fail(res, 404, 'Артист не найден');
    return send(res, 200, { artist: pubArtist(a), tracks: db.tracks.filter(t => t.artist === a.id).sort((x, y) => y.created - x.created).map(pubTrack) });
  }
  if (M === 'GET' && p === '/api/tracks') {
    const q = clip(u.searchParams.get('q'), 60).toLowerCase(), lim = Math.min(+u.searchParams.get('limit') || 100, 200);
    const l = db.tracks.map(pubTrack).filter(t => { const a = db.artists.find(x => x.id === t.artist); return a && a.status === 'verified' && (!q || (t.title + ' ' + t.artistName + ' ' + t.album).toLowerCase().includes(q)); })
      .sort((a, b) => b.created - a.created).slice(0, lim);
    return send(res, 200, { tracks: l });
  }

  if (M === 'POST' && p === '/api/artists') {
    if (limited(req)) return fail(res, 429, 'Слишком много запросов, подождите минуту');
    const b = await json(req), name = clip(b.name, 40);
    if (name.length < 2) return fail(res, 400, 'Имя артиста: минимум 2 символа');
    if (!b.owns) return fail(res, 400, 'Подтвердите, что вы автор загружаемой музыки');
    if (db.artists.some(a => a.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Артист с таким именем уже есть');
    const token = crypto.randomBytes(24).toString('hex');
    const a = { id: db.seq++, name, genre: clip(b.genre, 30), bio: clip(b.bio, 300), avatar: img(b.avatar), link: url(b.link),
      email: clip(b.email, 120).toLowerCase(), emailVerified: !!b.emailVerified, status: b.emailVerified ? 'verified' : 'pending', badge: false, created: Date.now(), tokenHash: sha(token) };
    db.artists.push(a); save();
    return send(res, 201, { artist: pubArtist(a), token });
  }
  if (M === 'PATCH' && (m = /^\/api\/artists\/(\d+)$/.exec(p))) {
    const a = db.artists.find(x => x.id === +m[1]); if (!a) return fail(res, 404, 'Артист не найден');
    if (!owner(req, a)) return fail(res, 403, 'Нет доступа');
    const b = await json(req), name = b.name == null ? a.name : clip(b.name, 40);
    if (name.length < 2) return fail(res, 400, 'Имя артиста: минимум 2 символа');
    if (db.artists.some(x => x.id !== a.id && x.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Артист с таким именем уже есть');
    a.name = name;
    if (b.genre != null) a.genre = clip(b.genre, 30);
    if (b.bio != null) a.bio = clip(b.bio, 300);
    if (b.link != null) a.link = url(b.link);
    if (b.avatar) a.avatar = img(b.avatar) || a.avatar;
    save(); return send(res, 200, { artist: pubArtist(a) });
  }
  if (M === 'POST' && (m = /^\/api\/artists\/(\d+)\/tracks$/.exec(p))) {
    if (limited(req)) return fail(res, 429, 'Слишком много запросов, подождите минуту');
    const a = db.artists.find(x => x.id === +m[1]); if (!a) return fail(res, 404, 'Артист не найден');
    if (!owner(req, a)) return fail(res, 403, 'Нет доступа');
    if (a.status !== 'verified') return fail(res, 403, 'Профиль ещё не подтверждён');
    if (db.tracks.filter(t => t.artist === a.id).length >= MAX_TRACKS) return fail(res, 400, 'Достигнут лимит треков');
    let meta = {}; try { meta = JSON.parse(decodeURIComponent(req.headers['x-meta'] || '{}')); } catch (e) {}
    const title = clip(meta.title, 80); if (!title) return fail(res, 400, 'Укажите название трека');
    const ext = EXT[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
    if (!ext) return fail(res, 400, 'Поддерживаются mp3, m4a, aac, ogg, wav, flac');
    const body = await readBody(req, MAX_AUDIO); if (body.length < 1024) return fail(res, 400, 'Файл пустой');
    const id = db.seq++, file = id + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(AUDIO, file), body);
    const t = { id, artist: a.id, title, album: clip(meta.album, 60), cover: img(meta.cover), dur: Math.max(0, Math.min(+meta.dur || 0, 36000)), file, created: Date.now() };
    db.tracks.push(t); save(); return send(res, 201, { track: pubTrack(t) });
  }
  if (M === 'DELETE' && (m = /^\/api\/tracks\/(\d+)$/.exec(p))) {
    const t = db.tracks.find(x => x.id === +m[1]); if (!t) return fail(res, 404, 'Трек не найден');
    if (!owner(req, db.artists.find(x => x.id === t.artist)) && !isAdmin(req)) return fail(res, 403, 'Нет доступа');
    db.tracks = db.tracks.filter(x => x !== t); try { fs.unlinkSync(path.join(AUDIO, t.file)); } catch (e) {}
    save(); return send(res, 200, { ok: true });
  }

  // админ: подтвердить заявку, выдать галочку, удалить артиста
  if ((m = /^\/api\/admin\/artists\/(\d+)\/(approve|badge|reject)$/.exec(p)) && M === 'POST') {
    if (!isAdmin(req)) return fail(res, 403, 'Нужен X-Admin');
    const a = db.artists.find(x => x.id === +m[1]); if (!a) return fail(res, 404, 'Артист не найден');
    if (m[2] === 'approve') a.status = 'verified'; else if (m[2] === 'badge') a.badge = !a.badge; else a.status = 'pending';
    save(); return send(res, 200, { artist: pubArtist(a) });
  }
  if (M === 'GET' && p === '/api/admin/pending') {
    if (!isAdmin(req)) return fail(res, 403, 'Нужен X-Admin');
    return send(res, 200, { artists: db.artists.filter(a => a.status !== 'verified').map(a => Object.assign(pubArtist(a), { email: a.email })) });
  }
  if (M === 'DELETE' && (m = /^\/api\/admin\/artists\/(\d+)$/.exec(p))) {
    if (!isAdmin(req)) return fail(res, 403, 'Нужен X-Admin');
    const a = db.artists.find(x => x.id === +m[1]); if (!a) return fail(res, 404, 'Артист не найден');
    db.tracks.filter(t => t.artist === a.id).forEach(t => { try { fs.unlinkSync(path.join(AUDIO, t.file)); } catch (e) {} });
    db.tracks = db.tracks.filter(t => t.artist !== a.id); db.artists = db.artists.filter(x => x !== a);
    save(); return send(res, 200, { ok: true });
  }
  fail(res, 404, 'Не найдено');
}

http.createServer((req, res) => route(req, res).catch(e => { if (!res.headersSent) fail(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, e.code ? e.message : 'Ошибка сервера'); else res.end(); }))
  .listen(PORT, process.env.HOST || undefined, () => console.log('Razy server: http://localhost:' + PORT + (ADMIN ? '' : '  (RAZY_ADMIN не задан: админ-функции отключены)')));
