/* My Recipe — recipes & shopping list. Plain JS, no frameworks. */
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => (s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const API = 'https://www.themealdb.com/api/json/v1/1';
const PEXELS_KEY = 'PASTE_YOUR_KEY_HERE'; // free from pexels.com/api — leave as-is to skip previews
const VIDEO_MODE = 'external'; // 'embed' = in-app player (ad-free only when installed from Brave)
const PURGE_MS = 24 * 60 * 60 * 1000;

const DB = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
let saved = DB.get('mise.saved', []);
let list  = DB.get('mise.list',  []);
let current = null, selection = new Set(), resultsById = {};

/* ── API ── */
async function searchMeals(q) {
  const r = await fetch(`${API}/search.php?s=${encodeURIComponent(q)}`);
  return (await r.json()).meals || [];
}
async function lookupMeal(id) {
  const r = await fetch(`${API}/lookup.php?i=${id}`);
  return (await r.json()).meals?.[0] || null;
}
async function pexelsPreview(query) {
  if (!PEXELS_KEY || PEXELS_KEY.includes('PASTE_')) return null;
  query = (query || 'cooking').toLowerCase();
  const cache = DB.get('mise.vcache', {});
  if (cache[query]) return cache[query];
  try {
    const r = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query + ' cooking')}&per_page=3&orientation=portrait`,
      { headers: { Authorization: PEXELS_KEY } });
    if (!r.ok) return null;
    const j = await r.json();
    for (const v of j.videos || []) {
      const f = (v.video_files || []).filter(f => f.file_type === 'video/mp4')
        .sort((a, b) => (a.quality === 'sd' ? 0 : 1) - (b.quality === 'sd' ? 0 : 1))[0];
      if (f?.link) { cache[query] = f.link; DB.set('mise.vcache', cache); return f.link; }
    }
    return null;
  } catch { return null; }
}
function loadPreview(m) {
  const q = (ingredientsOf(m)[0]?.name || m.strMeal).split(' ').slice(-1)[0];
  pexelsPreview(q).then(url => {
    if (!url || current !== m || !$('#sheet').classList.contains('open')) return;
    const vid = document.createElement('video');
    vid.src = url; vid.muted = true; vid.loop = true; vid.playsInline = true;
    vid.poster = m.strMealThumb;
    vid.addEventListener('canplay', () => { vid.play().catch(() => {}); vid.classList.add('on'); });
    $('#hero').insertBefore(vid, $('#hero').firstChild);
  });
}

/* ── Discover ── */
const CHIPS = ['Chicken', 'Pasta', 'Vegetarian', 'Seafood', 'Beef', 'Dessert', 'Breakfast', 'Vegan'];
function renderChips() { $('#chips').innerHTML = CHIPS.map(c => `<button class="chip">${c}</button>`).join(''); }
function skeletons() {
  $('#results').innerHTML = Array(6).fill(`<div class="card skel"><div class="ph"></div><div class="ln"></div></div>`).join('');
  $('#searchEmpty').hidden = true;
}
function cardHTML(m) {
  const isSaved = saved.some(s => s.id === m.idMeal);
  return `<article class="card" data-id="${m.idMeal}">
    <img loading="lazy" src="${m.strMealThumb}/preview" alt="${esc(m.strMeal)}">
    <div class="info"><h3>${esc(m.strMeal)}</h3><div class="sub">${esc(m.strCategory)} · ${esc(m.strArea)}</div></div>
    <button class="bmk ${isSaved ? 'on' : ''}" data-bmk aria-label="Save recipe">
      <svg viewBox="0 0 24 24" class="ic"><path d="M6 3h12v18l-6-4.5L6 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
    </button></article>`;
}
function renderResults(meals, q) {
  resultsById = {}; meals.forEach(m => resultsById[m.idMeal] = m);
  $('#results').innerHTML = meals.map(cardHTML).join('');
  $('#searchEmpty').hidden = meals.length > 0;
  if (!meals.length) $('#searchEmpty').querySelector('p').textContent = `No dishes matched “${q}”. Try another word.`;
}
async function runSearch(q) {
  q = q.trim(); if (q.length < 2) return;
  skeletons();
  renderResults(await searchMeals(q), q);
}

/* ── Saved ── */
function renderSaved() {
  $('#savedGrid').innerHTML = saved.map(m => cardHTML({
    idMeal: m.id, strMeal: m.title, strMealThumb: m.thumb, strCategory: m.category, strArea: m.area
  })).join('');
  $('#savedEmpty').hidden = saved.length > 0;
  $('#savedCount').textContent = saved.length ? `${saved.length} recipe${saved.length > 1 ? 's' : ''}` : '';
}
function toggleSave(meal) {
  const i = saved.findIndex(s => s.id === meal.idMeal);
  if (i >= 0) { saved.splice(i, 1); toast('Removed from saved'); }
  else {
    saved.push({ id: meal.idMeal, title: meal.strMeal, thumb: meal.strMealThumb, category: meal.strCategory, area: meal.strArea });
    toast('Saved to your recipes');
  }
  DB.set('mise.saved', saved);
  renderSaved();
  $$('.card .bmk').forEach(b => b.classList.toggle('on', saved.some(s => s.id === b.closest('.card').dataset.id)));
}

/* ── Recipe sheet ── */
function ingredientsOf(m) {
  const out = [];
  for (let i = 1; i <= 20; i++) {
    const name = m[`strIngredient${i}`]?.trim();
    if (name) out.push({ name, measure: m[`strMeasure${i}`]?.trim() || '' });
  }
  return out;
}
async function openDetail(id) {
  const sheet = $('#sheet');
  sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#hero').querySelector('iframe')?.remove();
  $('#hero').querySelector('video')?.remove();
  $('#dTitle').textContent = 'Loading…'; $('#dIng').innerHTML = ''; $('#dSteps').textContent = '';
  $('#dPlay').hidden = true; $('#addSel').disabled = true;
  const m = (resultsById[id] && resultsById[id].strInstructions) ? resultsById[id] : await lookupMeal(id);
  if (!m) { closeSheet(); return; }
  current = m;
  $('#dImg').src = m.strMealThumb;
  $('#dTitle').textContent = m.strMeal;
  const tags = (m.strTags || '').split(',').filter(Boolean).slice(0, 2);
  $('#dMeta').innerHTML = `<span class="meta">${esc(m.strCategory)}</span><span class="meta plain">${esc(m.strArea)}</span>` +
    tags.map(t => `<span class="meta plain">${esc(t)}</span>`).join('');
  $('#dSteps').textContent = (m.strInstructions || '').replace(/\r\n/g, '\n').trim();
  if (m.strYoutube) $('#dPlay').hidden = false;
  selection = new Set(ingredientsOf(m).keys());
  renderIngredients();
  loadPreview(m);
  $('.sheet-body').scrollTop = 0;
}
function renderIngredients() {
  const ings = ingredientsOf(current);
  $('#dIng').innerHTML = ings.map((g, i) => `<li class="ing ${selection.has(i) ? 'checked' : ''}" data-i="${i}">
      <span class="box"><svg viewBox="0 0 24 24" class="ic"><path d="M5 12l5 5 9-11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="name">${esc(g.name)}</span><span class="measure">${esc(g.measure)}</span></li>`).join('');
  $('#dSel').textContent = `${selection.size} of ${ings.length} selected`;
  const btn = $('#addSel');
  btn.disabled = selection.size === 0;
  btn.textContent = selection.size ? `Add ${selection.size} item${selection.size > 1 ? 's' : ''} to shopping list` : 'Select ingredients';
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
function addSelectionToList() {
  const ings = ingredientsOf(current);
  let added = 0;
  selection.forEach(i => {
    const g = ings[i];
    if (list.some(x => x.name.toLowerCase() === g.name.toLowerCase())) return;
    list.push({ id: `${current.idMeal}-${i}`, name: g.name, qty: g.measure, src: current.strMeal, checked: false, checkedAt: 0 });
    added++;
  });
  DB.set('mise.list', list);
  renderList(); closeSheet();
  toast(added ? `Added ${added} item${added > 1 ? 's' : ''}` : 'Already on your list', added ? 'View list' : null, () => switchTab('list'));
}

/* ── Shopping list + swipe ── */
function renderList() {
  $('#list').innerHTML = list.map(it => `<li class="item ${it.checked ? 'checked' : ''}" data-id="${it.id}">
      <div class="behind">Delete
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="row">
        <span class="box"><svg viewBox="0 0 24 24" class="ic"><path d="M5 12l5 5 9-11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="txt"><span class="name">${esc(it.name)}</span><span class="src">from ${esc(it.src)}</span></span>
        ${it.qty ? `<span class="qty">${esc(it.qty)}</span>` : ''}
      </div></li>`).join('');
  $('#listEmpty').hidden = list.length > 0;
  const n = list.filter(i => !i.checked).length;
  $('#listBadge').hidden = n === 0;
  $('#listBadge').textContent = n;
  $$('#list .row').forEach(attachSwipe);
}
function attachSwipe(row) {
  let startX = 0, dx = 0, moved = false;
  row.addEventListener('pointerdown', e => { startX = e.clientX; dx = 0; moved = false; row.style.transition = 'none'; row.setPointerCapture(e.pointerId); });
  row.addEventListener('pointermove', e => { dx = e.clientX - startX; if (dx < 0) { row.style.transform = `translateX(${dx}px)`; if (dx < -8) moved = true; } });
  row.addEventListener('pointerup', () => {
    const li = row.closest('.item');
    row.style.transition = 'transform .22s cubic-bezier(.32,.72,0,1)';
    if (dx < -row.offsetWidth * 0.35) {
      row.style.transform = 'translateX(-105%)';
      setTimeout(() => deleteItem(li.dataset.id), 180);
    } else {
      row.style.transform = '';
      setTimeout(() => { row.style.transition = 'none'; }, 220);
    }
  });
  row.addEventListener('click', () => {
    if (moved) { moved = false; return; }
    const it = list.find(i => i.id === row.closest('.item').dataset.id);
    it.checked = !it.checked;
    it.checkedAt = it.checked ? Date.now() : 0;
    DB.set('mise.list', list);
    renderList();
  });
}
function deleteItem(id) {
  const idx = list.findIndex(i => i.id === id);
  if (idx < 0) return;
  const [gone] = list.splice(idx, 1);
  DB.set('mise.list', list); renderList();
  toast(`Removed ${gone.name}`, 'Undo', () => { list.splice(idx, 0, gone); DB.set('mise.list', list); renderList(); });
}
function purgeOld() {
  const before = list.length;
  list = list.filter(i => !(i.checked && Date.now() - (i.checkedAt || 0) > PURGE_MS));
  if (list.length !== before) { DB.set('mise.list', list); renderList(); }
}

/* ── Composer (the + button) ── */
function openComposer() { $('#fab').hidden = true; $('#composer').hidden = false; $('#cName').focus(); }
function closeComposer() { $('#composer').hidden = true; $('#fab').hidden = false; }

/* ── Toast ── */
let toastTimer;
function toast(msg, actionLabel, actionFn) {
  const t = $('#toast'), act = $('#toastAct');
  $('#toastMsg').textContent = msg;
  act.hidden = !actionLabel; act.textContent = actionLabel || '';
  act.onclick = () => { t.classList.remove('show'); actionFn?.(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

/* ── Tabs ── */
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'saved') renderSaved();
  if (name === 'list') renderList();
  window.scrollTo({ top: 0 });
}

/* ── Wiring ─ */
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch($('#q').value); });
$('#chips').addEventListener('click', e => {
  if (!e.target.classList.contains('chip')) return;
  $('#q').value = e.target.textContent; runSearch(e.target.textContent);
});
$('#results').addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  if (e.target.closest('[data-bmk]')) { toggleSave(resultsById[card.dataset.id]); return; }
  openDetail(card.dataset.id);
});
$('#savedGrid').addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  if (e.target.closest('[data-bmk]')) { toggleSave({ idMeal: card.dataset.id }); return; }
  openDetail(card.dataset.id);
});
$('#dIng').addEventListener('click', e => {
  const li = e.target.closest('.ing'); if (!li) return;
  const i = +li.dataset.i;
  selection.has(i) ? selection.delete(i) : selection.add(i);
  renderIngredients();
});
$('#addSel').addEventListener('click', addSelectionToList);
$('#dPlay').addEventListener('click', () => {
  const url = current?.strYoutube;
  if (!url) return toast('No video for this recipe');
  if (VIDEO_MODE === 'embed') {
    const id = url.match(/v=([\w-]+)/)?.[1] || url.match(/youtu\.be\/([\w-]+)/)?.[1];
    if (!id) { window.open(url, '_blank', 'noopener'); return; }
    $('#dPlay').hidden = true;
    $('#hero').insertAdjacentHTML('beforeend',
      `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe>`);
  } else {
    window.open(url, '_blank', 'noopener');
  }
});
$$('[data-close]').forEach(el => el.addEventListener('click', closeSheet));
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.view)));
$('#clearDone').addEventListener('click', () => {
  const done = list.filter(i => i.checked);
  if (!done.length) return toast('Nothing checked yet');
  const prev = [...list];
  list = list.filter(i => !i.checked);
  DB.set('mise.list', list); renderList();
  toast(`Cleared ${done.length} item${done.length > 1 ? 's' : ''}`, 'Undo', () => { list = prev; DB.set('mise.list', list); renderList(); });
});
$('#fab').addEventListener('click', openComposer);
$('#cClose').addEventListener('click', closeComposer);
$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#cName').value.trim();
  if (!name) return;
  list.push({ id: 'm' + Date.now(), name, qty: $('#cQty').value.trim(), src: 'Manual', checked: false, checkedAt: 0 });
  DB.set('mise.list', list); renderList();
  $('#cName').value = ''; $('#cQty').value = ''; $('#cName').focus();
  toast(`Added ${name}`);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('#sheet').classList.contains('open')) closeSheet();
  else if (!$('#composer').hidden) closeComposer();
});

/* ── PWA ── */
let deferredInstall;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => { deferredInstall?.prompt(); $('#installBtn').hidden = true; });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js');

/* ── Init ── */
renderChips(); renderSaved(); renderList(); purgeOld();
setInterval(purgeOld, 60000);
