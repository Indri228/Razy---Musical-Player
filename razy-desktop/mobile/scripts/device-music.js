/* Импорт музыки из памяти телефона (только APK). Нативный плагин DeviceMusic читает MediaStore,
   копирует выбранный трек в кэш приложения, а здесь он попадает в библиотеку через обычный addFiles(). */
(function () {
  const cap = window.Capacitor;
  const P = cap && ((cap.Plugins && cap.Plugins.DeviceMusic) || (cap.registerPlugin && cap.registerPlugin('DeviceMusic')));
  if (!P || typeof addFiles !== 'function') return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = s => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const KEY = 'razy_devimp';
  const done = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')) } catch (e) { return new Set() } };
  const saveDone = set => { try { localStorage.setItem(KEY, JSON.stringify([...set])) } catch (e) {} };

  const st = document.createElement('style');
  st.textContent = `
.dm{position:fixed;inset:0;z-index:130;display:flex;flex-direction:column;justify-content:flex-end;background:#000b;opacity:0;pointer-events:none;transition:opacity .25s}
.dm.open{opacity:1;pointer-events:auto}
.dm>div{background:#120d22;border:1px solid #ffffff14;border-radius:26px 26px 0 0;max-height:92vh;display:flex;flex-direction:column;transform:translateY(40px);transition:transform .3s cubic-bezier(.2,.9,.3,1.05);padding-bottom:env(safe-area-inset-bottom)}
.dm.open>div{transform:none}
.dm h3{margin:0;font-size:18px;padding:18px 20px 4px}
.dm .sub{padding:0 20px 10px;color:var(--mu);font-size:13px}
.dm .bar{display:flex;gap:8px;padding:4px 16px 10px;align-items:center}
.dm .bar input{flex:1;min-width:0;border:0;border-radius:14px;background:#ffffff12;color:var(--tx);padding:11px 14px;font:inherit;font-size:14px;outline:0}
.dm .bar button,.dm .act2 button{border:0;border-radius:14px;padding:11px 14px;font:inherit;font-size:13px;font-weight:700;color:var(--tx);background:#ffffff14;cursor:pointer;white-space:nowrap}
.dm .lst{overflow:auto;flex:1;min-height:120px;padding:0 8px;-webkit-overflow-scrolling:touch}
.dm .it{display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:14px;cursor:pointer}
.dm .it:active{background:#ffffff0d}
.dm .ck{width:22px;height:22px;border-radius:7px;border:2px solid #ffffff40;flex:none;display:grid;place-items:center;font-size:14px;line-height:1;color:#fff}
.dm .it.sel .ck{background:var(--g);border-color:transparent}.dm .it.sel .ck:after{content:"✓"}
.dm .it .tx{min-width:0;flex:1}.dm .it b{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm .it span{display:block;font-size:12px;color:var(--mu);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm .it em{font-style:normal;font-size:10px;color:var(--mu);border:1px solid #ffffff24;border-radius:8px;padding:2px 6px;flex:none}
.dm .it.had{opacity:.5}
.dm .msg{padding:30px 20px;text-align:center;color:var(--mu);font-size:14px;line-height:1.5}
.dm .foot{padding:10px 16px 14px;display:flex;gap:10px}
.dm .foot .go{flex:1;border:0;border-radius:16px;padding:14px;font:inherit;font-weight:800;font-size:15px;color:#fff;background:var(--g);cursor:pointer}
.dm .foot .go:disabled{opacity:.45}
.dm .act2{padding:6px 16px 16px;display:flex;flex-direction:column;gap:10px}
.dm .act2 button{padding:15px;font-size:15px;text-align:left;border-radius:16px}`;
  document.head.appendChild(st);
  document.body.insertAdjacentHTML('beforeend', '<div class="dm" id="dmChoice"><div><h3>Добавить музыку</h3><div class="act2"><button data-c="dev">📱 Из музыки телефона</button><button data-c="file">📁 Выбрать файлы</button><button data-c="x">Отмена</button></div></div></div>' +
    '<div class="dm" id="dmList"><div><h3>Музыка телефона</h3><div class="sub" id="dmSub"></div><div class="bar"><input id="dmQ" placeholder="Поиск" autocomplete="off"><button id="dmAll">Все</button></div><div class="lst" id="dmLst"></div><div class="foot"><button class="go" id="dmGo" disabled>Импортировать</button><button id="dmX" style="border:0;border-radius:16px;padding:0 18px;background:#ffffff14;color:var(--tx);font:inherit;font-weight:700">Закрыть</button></div></div></div>');
  const ch = document.getElementById('dmChoice'), ls = document.getElementById('dmList');
  const lst = document.getElementById('dmLst'), sub = document.getElementById('dmSub'), go = document.getElementById('dmGo'), qi = document.getElementById('dmQ');
  let all = [], sel = new Set(), busy = false;

  const vis = () => { const q = qi.value.trim().toLowerCase(); return q ? all.filter(t => (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q)) : all };
  function paint() {
    const d = done(), v = vis();
    lst.innerHTML = v.length ? v.map(t => `<div class="it${sel.has(t.id) ? ' sel' : ''}${d.has(t.id) ? ' had' : ''}" data-id="${esc(t.id)}"><div class="ck"></div><div class="tx"><b>${esc(t.title || t.name)}</b><span>${esc(t.artist || 'Неизвестный исполнитель')} · ${fmt(t.dur)}</span></div>${d.has(t.id) ? '<em>в Razy</em>' : ''}</div>`).join('') : '<div class="msg">Ничего не найдено</div>';
    go.textContent = busy ? go.textContent : (sel.size ? `Импортировать (${sel.size})` : 'Выберите треки');
    go.disabled = busy || !sel.size;
  }
  lst.onclick = e => { if (busy) return; const it = e.target.closest('.it'); if (!it) return; const id = it.dataset.id; sel.has(id) ? sel.delete(id) : sel.add(id); paint() };
  qi.oninput = paint;
  document.getElementById('dmAll').onclick = () => { if (busy) return; const d = done(), v = vis().filter(t => !d.has(t.id)); const every = v.every(t => sel.has(t.id)); v.forEach(t => every ? sel.delete(t.id) : sel.add(t.id)); paint() };
  document.getElementById('dmX').onclick = () => { if (!busy) ls.classList.remove('open') };
  ch.onclick = e => {
    const c = e.target.closest('button'); if (e.target === ch || (c && c.dataset.c === 'x')) { ch.classList.remove('open'); return }
    if (!c) return; ch.classList.remove('open');
    if (c.dataset.c === 'file') document.getElementById('file').click(); else openList();
  };

  async function openList() {
    ls.classList.add('open'); sel = new Set(); qi.value = ''; sub.textContent = ''; lst.innerHTML = '<div class="msg">Загружаю список…</div>'; go.disabled = true; go.textContent = 'Выберите треки';
    try {
      const r = await P.list(); all = (r && r.tracks) || [];
      sub.textContent = all.length ? `Найдено на телефоне: ${all.length}` : '';
      if (!all.length) lst.innerHTML = '<div class="msg">На телефоне не найдено музыки.</div>'; else paint();
    } catch (e) {
      const denied = /denied/i.test(String(e && (e.message || e)));
      lst.innerHTML = '<div class="msg">' + (denied ? 'Нет доступа к музыке. Разрешите «Музыка и аудио» для Razy в настройках телефона (Приложения → Razy → Разрешения).' : 'Не удалось прочитать музыку телефона: ' + esc(e && (e.message || e))) + '</div>';
    }
  }

  go.onclick = async () => {
    if (busy || !sel.size) return; busy = true; go.disabled = true;
    const items = all.filter(t => sel.has(t.id)), d = done(); let ok = 0, fail = 0;
    for (let i = 0; i < items.length; i++) {
      const t = items[i]; go.textContent = `Импорт ${i + 1} из ${items.length}…`;
      try {
        const r = await P.copy({ id: t.id });
        const resp = await fetch(cap.convertFileSrc('file://' + r.path)); if (!resp.ok) throw new Error('read ' + resp.status);
        const bl = await resp.blob();
        const ext = (t.name.match(/\.[A-Za-z0-9]{2,5}$/) || ['.mp3'])[0];
        addFiles([new File([bl], t.name || (t.title + ext), { type: t.mime || bl.type || 'audio/mpeg' })]);
        d.add(t.id); sel.delete(t.id); ok++;
      } catch (e) { fail++ }
      try { await P.clean() } catch (e) {}
    }
    saveDone(d); busy = false; paint();
    sub.textContent = `Добавлено: ${ok}` + (fail ? `, не удалось: ${fail}` : '');
    if (!fail) setTimeout(() => ls.classList.remove('open'), 700);
  };

  // кнопка «Файл» внизу: выбор — музыка телефона или обычный выбор файлов
  document.addEventListener('click', e => {
    const l = e.target.closest('.tabs label.up'); if (!l) return;
    e.preventDefault(); ch.classList.add('open');
  }, true);
  window.__devMusic = { open: openList };
})();
