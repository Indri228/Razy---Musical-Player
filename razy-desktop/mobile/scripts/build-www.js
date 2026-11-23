// Собирает mobile/www из десктопной версии:
//  - app/index.html  -> www/index.html (+ подключение net.js и мобильных стилей)
//  - сетевая логика из main.js (поиск, тексты, YouTube, Spotify) -> www/net.js (window.razyNet / razyYT / razyCfg)
// Единый исходник: правки поиска в main.js автоматически попадают и на телефон.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), www = path.join(__dirname, '..', 'www');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const A = main.indexOf('// ---- Поиск музыки'), B = main.indexOf('// Адрес сервера общих треков');
if (A < 0 || B < A) throw new Error('main.js: не найден блок сетевой логики (маркеры «// ---- Поиск музыки» / «// Адрес сервера общих треков»)');
let region = main.slice(A, B);
region = region
  .replace(/ipcMain\.handle\(/g, 'HANDLE(')
  .replace(/app\.getLocaleCountryCode\(\)/g, "((navigator.language || '').split('-')[1] || '')");
const bad = region.match(/\b(require|__dirname|process\.|Buffer|ipcMain|session\.|app\.getPath)/g);
if (bad) throw new Error('В сетевом блоке остались вещи только для Electron: ' + [...new Set(bad)].join(', '));
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch (e) {}
const srv = /localhost|127\.0\.0\.1/.test(String(cfg.server || '')) ? '' : String(cfg.server || '');   // localhost на телефоне — это сам телефон
const net = `/* Создано scripts/build-www.js из main.js — не править вручную */
(function () {
const H = {}, HANDLE = (n, f) => { H[n] = (...a) => f(null, ...a); };
${region}
window.razyNet = {
  search: (q, o) => H.search(q, o), popular: o => H.popular(o), lyrics: (a, t, d) => H.lyrics(a, t, d),
  section: (k, o, s) => H.section(k, o, s), suggest: q => H.suggest(q), match: (a, t, o) => H.match(a, t, o),
  spotify: u => H['spotify:playlist'](u)
};
window.razyYT = { search: (k, q) => H['yt:search'](k, q) };
window.razyCfg = { get: async () => ({ server: ${JSON.stringify(srv)} }) };
window.__razyMobile = true;
})();
`;
const css = `<style id="mobile-css">
/* только телефон */
.r2:has(#nprx){display:none}                 /* прокси настраивается в системе телефона */
html,body{overscroll-behavior:none;-webkit-tap-highlight-color:transparent}
.indri{pointer-events:none}
/* легче для слабых телефонов */
html.ultra .row{contain-intrinsic-size:auto 58px}
html.ultra *{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
html,body{touch-action:manipulation}
</style>`;
let html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');
if (!html.includes('<script>')) throw new Error('index.html: не найден <script>');
html = html.replace('<script>', '<script src="net.js"></script>\n<script>').replace('</head>', css + '\n</head>');
// Лёгкая версия для телефона: при первом запуске включается режим «Ультра экономия» (без размытий, фоновых анимаций,
// визуализатора и снега). Поменять можно кнопкой «Режим работы» вверху: выбор запоминается.
const perfOld = "if(typeof S.perf!=='number')S.perf=S.lite?1:0;";
if (!html.includes(perfOld)) throw new Error('index.html: не найдена строка выбора режима производительности');
html = html.replace(perfOld, "if(typeof S.perf!=='number')S.perf=window.__razyMobile?2:(S.lite?1:0);");
html = html.replace(/<\/body>/i, '<script src="device-music.js"></script>\n</body>');
fs.rmSync(www, { recursive: true, force: true }); fs.mkdirSync(www, { recursive: true });
fs.writeFileSync(path.join(www, 'index.html'), html);
fs.writeFileSync(path.join(www, 'net.js'), net);
fs.copyFileSync(path.join(__dirname, 'device-music.js'), path.join(www, 'device-music.js'));
console.log('www готов:', fs.statSync(path.join(www, 'index.html')).size, 'байт index.html,', fs.statSync(path.join(www, 'net.js')).size, 'байт net.js');
