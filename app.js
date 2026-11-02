/* Mise — recipes & shopping list. Plain JS, zero frameworks. */
'use strict';

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => (s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const API = 'https://www.themealdb.com/api/json/v1/1';
const PURGE_MS = 24 * 60 * 60 * 1000; // checked items auto-clear after 24h

/* ── Storage ── */
const DB = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
let saved   = DB.get('mise.saved', []);   // {id,title,thumb,category,area}
let list    = DB.get('mise.list',  []);   // {id,name,qty,src,checked,checkedAt}
let recents = DB.get('mise.recents', []);
let current = null, selection = new Set(), resultsById = {};
let searchToken = 0, sheetPushed = false, currentTab = 'search', deferredInstall = null;

/* ── Aisle grouping ── */
const CATS = [
  ['Frozen',       /frozen|ice cream|gelato|sorbet|french fr|ice cubes/i],
  ['Pantry',       /stock|broth|bouillon|dried|canned|tin\b|tomato (paste|sauce|puree|soup)|ketchup|mustard|mayo|vinegar|oil|flour|cornstarch|cornflour|sugar|salt|pepper|paprika|cumin|curry|cinnamon|nutmeg|oregano|thyme|rosemary|bay leaf|chili (powder|flakes|sauce)|garlic (powder|salt)|onion (powder|flakes)|coconut milk|peanut butter|chocolate|cocoa|vanilla|yeast|baking|breadcrumb|rice|pasta|noodle|lentil|bean|chickpea|quinoa|oats|cereal|honey|syrup|jam\b|sauce|soy\b|worcester|sesame|seed|nut\b|almond|walnut|cashew|raisin|coffee|tea\b/i],
  ['Dairy & Eggs', /milk|butter|cheese|cream|yogurt|yoghurt|feta|parmesan|mozzarella|cheddar|egg|ghee|custard/i],
  ['Meat & Fish',  /beef|chicken|pork|lamb|bacon|ham\b|sausage|turkey|duck|veal|mince|steak|breast|thigh|wing|ribs|loin|fillet|salmon|tuna|prawn|shrimp|crab|cod\b|tilapia|anchov|pepperoni|chorizo|meatball|fish/i],
  ['Bakery',       /bread|bun\b|roll\b|baguette|tortilla|pita|naan|croissant|bagel|wrap|ciabatta|sourdough|brioche|flatbread|muffin/i],
  ['Drinks',       /juice|soda|beer|wine|sparkling|lemonade|cola|water\b|smoothie/i],
  ['Produce',      /tomato|lettuce|spinach|onion|garlic|pepper\b|cucumber|carrot|potato|avocado|lemon|lime\b|basil|coriander|parsley|mint\b|ginger|mushroom|celery|cabbage|kale|herb|greens|scallion|zucchini|eggplant|aubergine|beet|radish|peas\b|corn\b|chili\b|jalape|fruit|apple|banana|berr|strawberr|orange|grape|peach|pear|melon|mango|pineapple|turnip|leek|fennel|squash|pumpkin|rocket|arugula|romaine|sweet potato/i],
];
const GROUP_ORDER = ['Produce','Bakery','Meat & Fish','Dairy & Eggs','Frozen','Drinks','Pantry'];
const catOf = name => (CATS.find(([, re]) => re.test(name)) || ['Pantry'])[0];

/* ── API ── */
async function searchMeals(q) {
  const r = await fetch(`${API}/search.php?s=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('bad status');
  return (await r.json()).meals || [];
}
async function lookupMeal(id) {
  const r = await fetch(`${API}/lookup.php?i=${id}`);
  if (!r.ok) throw new Error('bad status');
  return (await r.json()).meals?.[0] || null;
}

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

/* ── Discover ── */
const CHIPS = ['Chicken','Pasta','Vegetarian','Seafood','Beef','Dessert','Breakfast','Vegan'];

function renderChips() {
  const rec = recents.slice(0, 4);
  const cats = CHIPS.filter(c => !rec.some(r => r.toLowerCase() === c.toLowerCase())).slice(0, 8 - rec.length);
  $('#chips').innerHTML =
    rec.map(c => `<button class="chip rec">${esc(c)}</button>`).join('') +
    cats.map(c => `<button class="chip">${c}</button>`).join('');
}
function pushRecent(q) {
  recents = [q, ...recents.filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, 6);
  DB.set('mise.recents', recents);
  renderChips();
}
function showSearchEmpty(msg) {
  $('#searchEmpty').hidden = false;
  $('#searchEmpty').querySelector('p').textContent =
    msg || 'Search any dish or ingredient, or tap a category above.';
}
function skeletons() {
  $('#results').innerHTML = Array(6).fill('<div class="card skel"><div class="ph"></div><div class="ln"></div></div>').join('');
  $('#searchEmpty').hidden = true;
}
function cardHTML(m) {
  return `<article class="card" data-id="${m.idMeal}">
    <img loading="lazy" src="${m.strMealThumb}/preview" alt="${esc(m.strMeal)}">
    ${m.strYoutube ? '<span class="vbadge"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></span>' : ''}
    <div class="info"><h3>${esc(m.strMeal)}</h3><div class="sub">${esc(m.strCategory)} · ${esc(m.strArea)}</div></div>
    <button class="bmk" data-bmk aria-label="Save recipe">
      <svg viewBox="0 0 24 24" class="ic"><path d="M6 3h12v18l-6-4.5L6 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
    </button></article>`;
}
function renderResults(meals, q) {
  resultsById = {}; meals.forEach(m => resultsById[m.idMeal] = m);
  $('#results').innerHTML = meals.map(cardHTML).join('');
  if (meals.length) $('#searchEmpty').hidden = true;
  else showSearchEmpty(`No dishes matched “${q}”. Try another word.`);
}
async function runSearch(q) {
  q = q.trim();
  if (q.length < 2) { $('#results').innerHTML = ''; showSearchEmpty(); return; }
  const t = ++searchToken;
  skeletons();
  try {
    const meals = await searchMeals(q);
    if (t !== searchToken) return;           // a newer search superseded this one
    pushRecent(q);
    renderResults(meals, q);
  } catch {
    if (t !== searchToken) return;
    $('#results').innerHTML = '';
    showSearchEmpty('Couldn’t reach the recipe service. Check your connection and try again.');
    toast('Connection trouble');
  }
}

/* ── Saved ─ */
function persistSaved() { DB.set('mise.saved', saved); renderSaved(); refreshCardBookmarks(); }
function refreshCardBookmarks() {
  $$('.card').forEach(c => c.querySelector('.bmk')?.classList.toggle('on', saved.some(s => s.id === c.dataset.id)));
}
function saveMeal(m) {
  if (saved.some(s => s.id === m.idMeal)) return toast('Already in saved');
  saved.unshift({ id: m.idMeal, title: m.strMeal, thumb: m.strMealThumb, category: m.strCategory, area: m.strArea });
  persistSaved(); toast('Saved to your recipes');
}
function unsaveById(id) {
  const i = saved.findIndex(s => s.id === id);
  if (i < 0) return;
  saved.splice(i, 1);
  persistSaved(); toast('Removed from saved');
}
function renderSaved() {
  $('#savedGrid').innerHTML = saved.map(m => cardHTML({
    idMeal: m.id, strMeal: m.title, strMealThumb: m.thumb, strCategory: m.category, strArea: m.area, strYoutube: ''
  })).join('');
  $('#savedEmpty').hidden = saved.length > 0;
  $('#savedCount').textContent = saved.length ? `${saved.length} recipe${saved.length > 1 ? 's' : ''}` : '';
  refreshCardBookmarks();
}

/* ── Recipe sheet ── */
const ingredientsOf = m => {
  const out = [];
  for (let i = 1; i <= 20; i++) {
    const name = m[`strIngredient${i}`]?.trim();
    if (name) out.push({ name, measure: m[`strMeasure${i}`]?.trim() || '' });
  }
  return out;
};
function hideSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
function closeSheet() {
  if (sheetPushed) { sheetPushed = false; history.back(); return; } // popstate finishes the job
  hideSheet();
}
async function openDetail(id) {
  $('#sheet').classList.add('open');
  $('#sheet').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (!sheetPushed) { sheetPushed = true; history.pushState({ mise: 1 }, ''); }
  $('#hero').querySelector('iframe')?.remove();
  $('#dTitle').textContent = 'Loading…';
  $('#dIng').innerHTML = ''; $('#dSteps').textContent = '';
  $('#dPlay').hidden = true; $('#addSel').disabled = true;
  try {
    const m = resultsById[id]?.strInstructions ? resultsById[id] : await lookupMeal(id);
    if (!m) { closeSheet(); return; }
    current = m;
    $('#dImg').src = m.strMealThumb;
    $('#dTitle').textContent = m.strMeal;
    const tags = (m.strTags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 2);
    $('#dMeta').innerHTML =
      `<span class="meta">${esc(m.strCategory)}</span><span class="meta plain">${esc(m.strArea)}</span>` +
      tags.map(t => `<span class="meta plain">${esc(t)}</span>`).join('');
    $('#dSteps').textContent = (m.strInstructions || '').replace(/\r\n/g, '\n').trim();
    $('#dPlay').hidden = !m.strYoutube;
    selection = new Set(ingredientsOf(m).keys());   // pre-tick everything
    renderIngredients();
    syncSaveBtn();
    $('.sheet-body').scrollTop = 0;
  } catch { closeSheet(); toast('Couldn’t load that recipe'); }
}
function renderIngredients() {
  const ings = ingredientsOf(current);
  $('#dIng').innerHTML = ings.map((g, i) => `<li class="ing ${selection.has(i) ? 'checked' : ''}" data-i="${i}">
      <span class="box"><svg viewBox="0 0 24 24" class="ic"><path d="M5 12l5 5 9-11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="name">${esc(g.name)}</span><span class="measure">${esc(g.measure)}</span></li>`).join('');
  $('#dSel').textContent = `${selection.size} of ${ings.length} selected`;
  const btn = $('#addSel');
  btn.disabled = selection.size === 0;
  btn.textContent = selection.size
    ? `Add ${selection.size} item${selection.size > 1 ? 's' : ''} to shopping list`
    : 'Select ingredients';
}
function syncSaveBtn() {
  $('#saveBtn').classList.toggle('on', saved.some(s => s.id === current?.idMeal));
}
function addSelectionToList() {
  const ings = ingredientsOf(current);
  let added = 0;
  selection.forEach(i => {
    const g = ings[i];
    if (list.some(x => x.name.toLowerCase() === g.name.toLowerCase())) return;  // no dupes
    list.push({ id: `${current.idMeal}-${i}`, name: g.name, qty: g.measure,
                src: current.strMeal, checked: false, checkedAt: 0 });
    added++;
  });
  persistList();
  closeSheet();
  toast(added ? `Added ${added} item${added > 1 ? 's' : ''}` : 'Already on your list',
        added ? 'View list' : null, () => switchTab('list'));
}

/* ── Shopping list ── */
function persistList() { DB.set('mise.list', list); }
function renderList() {
  const groups = new Map(GROUP_ORDER.map(g => [g, []]));
  list.forEach(it => groups.get(catOf(it.name)).push(it));
  let html = '';
  for (const [label, arr] of groups) {
    if (!arr.length) continue;
    arr.sort((a, b) => (a.checked ? 1 : 0) - (b.checked ? 1 : 0));  // checked sink down
    html += `<li class="grouph">${label}<span>${arr.length}</span></li>` + arr.map(it => `
      <li class="item ${it.checked ? 'checked' : ''}" data-id="${it.id}">
        <div class="behind">Delete
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="row">
          <span class="box"><svg viewBox="0 0 24 24" class="ic"><path d="M5 12l5 5 9-11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          <span class="txt"><span class="name">${esc(it.name)}</span><span class="src">from ${esc(it.src)}</span></span>
          ${it.qty ? `<button class="qty" aria-label="Edit quantity">${esc(it.qty)}</button>` : ''}
        </div></li>`).join('');
  }
  $('#list').innerHTML = html;
  $('#listEmpty').hidden = list.length > 0;
  $('#listFoot').hidden = list.length === 0;
  const n = list.filter(i => !i.checked).length;
  $('#listBadge').hidden = n === 0;
  $('#listBadge').textContent = n;
  $$('#list .row').forEach(attachSwipe);
}
function attachSwipe(row) {
  let startX = 0, dx = 0, moved = false;
  row.addEventListener('pointerdown', e => {
    if (e.target.closest('.qty,.qty-edit')) return;
    startX = e.clientX; dx = 0; moved = false;
    row.style.transition = 'none';
    row.setPointerCapture(e.pointerId);
  });
  row.addEventListener('pointermove', e => {
    dx = e.clientX - startX;
    if (dx < 0) { row.style.transform = `translateX(${dx}px)`; if (dx < -8) moved = true; }
  });
  const release = () => {
    row.style.transition = 'transform .22s cubic-bezier(.32,.72,0,1)';
    if (dx < -row.offsetWidth * 0.35) {
      row.style.transform = 'translateX(-105%)';
      setTimeout(() => deleteItem(row.closest('.item').dataset.id), 180);
    } else {
      row.style.transform = '';
      setTimeout(() => { row.style.transition = 'none'; }, 220);
    }
  };
  row.addEventListener('pointerup', release);
  row.addEventListener('pointercancel', () => { row.style.transition = 'transform .2s'; row.style.transform = ''; });
  row.addEventListener('click', e => {
    if (e.target.closest('.qty,.qty-edit')) return;
    if (moved) { moved = false; return; }
    const it = list.find(i => i.id === row.closest('.item').dataset.id);
    if (!it) return;
    it.checked = !it.checked;
    it.checkedAt = it.checked ? Date.now() : 0;
    persistList(); renderList();
  });
}
function startQtyEdit(btn) {
  const it = list.find(i => i.id === btn.closest('.item').dataset.id);
  if (!it) return;
  const inp = document.createElement('input');
  inp.className = 'qty-edit'; inp.value = it.qty; inp.maxLength = 12;
  btn.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = save => {
    if (inp.dataset.done) return;
    inp.dataset.done = '1';
    if (save) { it.qty = inp.value.trim(); persistList(); }
    renderList();
  };
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  ['pointerdown','click'].forEach(ev => inp.addEventListener(ev, e => e.stopPropagation()));
}
function deleteItem(id) {
  const idx = list.findIndex(i => i.id === id);
  if (idx < 0) return;
  const [gone] = list.splice(idx, 1);
  persistList(); renderList();
  toast(`Removed ${gone.name}`, 'Undo', () => {
    list.splice(Math.min(idx, list.length), 0, gone);
    persistList(); renderList();
  });
}
function purgeOld() {
  const before = list.length;
  list = list.filter(i => !(i.checked && Date.now() - (i.checkedAt || 0) > PURGE_MS));
  if (list.length !== before) { persistList(); renderList(); toast('Checked items auto-cleared'); }
}
function shareList() {
  if (!list.length) return toast('List is empty');
  const text = 'Shopping list — Mise\n' + list
    .map(i => `${i.checked ? '[x]' : '[ ]'} ${i.name}${i.qty ? ` (${i.qty})` : ''}`).join('\n');
  if (navigator.share) navigator.share({ title: 'Shopping list', text }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('List copied to clipboard'));
  else toast('Sharing not supported here');
}

/* ── Manual add (FAB + composer) ── */
function openComposer()  { $('#composer').hidden = false; $('#fab').hidden = true; $('#cName').focus(); }
function closeComposer() { $('#composer').hidden = true;  $('#fab').hidden = currentTab === 'list'; }
function addManual() {
  const name = $('#cName').value.trim();
  if (!name) { toast('Type an item name'); $('#cName').focus(); return; }
  list.push({ id: 'man-' + Date.now(), name, qty: $('#cQty').value.trim(),
              src: 'Added by hand', checked: false, checkedAt: 0 });
  persistList(); renderList();
  $('#cName').value = ''; $('#cQty').value = ''; $('#cName').focus();
}

/* ── Tabs ── */
function switchTab(name) {
  currentTab = name;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name !== 'list') closeComposer();
  $('#fab').hidden = !(name === 'list' && $('#composer').hidden);
  if (name === 'saved') renderSaved();
  if (name === 'list') renderList();
  window.scrollTo({ top: 0 });
}

/* ── Wiring ── */
let debTimer;
$('#q').addEventListener('input', e => {
  clearTimeout(debTimer);
  const v = e.target.value;
  debTimer = setTimeout(() => runSearch(v), 450);      // live results as you type
});
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); clearTimeout(debTimer); runSearch($('#q').value); });
$('#chips').addEventListener('click', e => {
  if (!e.target.classList.contains('chip')) return;
  $('#q').value = e.target.textContent;
  runSearch(e.target.textContent);
});
$('#results').addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  if (e.target.closest('[data-bmk]')) {
    const m = resultsById[card.dataset.id];
    if (!m) return;
    saved.some(s => s.id === m.idMeal) ? unsaveById(m.idMeal) : saveMeal(m);
    return;
  }
  openDetail(card.dataset.id);
});
$('#savedGrid').addEventListener('click', e => {
  const card = e.target.closest('.card'); if (!card) return;
  if (e.target.closest('[data-bmk]')) { unsaveById(card.dataset.id); return; }
  openDetail(card.dataset.id);
});
$('#dIng').addEventListener('click', e => {
  const li = e.target.closest('.ing'); if (!li || !current) return;
  const i = +li.dataset.i;
  selection.has(i) ? selection.delete(i) : selection.add(i);
  renderIngredients();
});
$('#addSel').addEventListener('click', addSelectionToList);
$('#saveBtn').addEventListener('click', () => {
  if (!current) return;
  saved.some(s => s.id === current.idMeal) ? unsaveById(current.idMeal) : saveMeal(current);
  syncSaveBtn();
});
$('#dPlay').addEventListener('click', () => {
  const id = current?.strYoutube?.match(/v=([\w-]+)/)?.[1]; if (!id) return;
  $('#dPlay').hidden = true;
  $('#hero').insertAdjacentHTML('beforeend',
    `<iframe src="https://www.youtube.com/embed/${id}?autoplay=1&rel=0" allow="autoplay; fullscreen" allowfullscreen></iframe>`);
});
$$('[data-close]').forEach(el => el.addEventListener('click', closeSheet));
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.view)));
$('#list').addEventListener('click', e => {
  const q = e.target.closest('.qty');
  if (q) startQtyEdit(q);
});
$('#clearDone').addEventListener('click', () => {
  const done = list.filter(i => i.checked);
  if (!done.length) return toast('Nothing checked yet');
  const prev = [...list];
  list = list.filter(i => !i.checked);
  persistList(); renderList();
  toast(`Cleared ${done.length} item${done.length > 1 ? 's' : ''}`, 'Undo', () => {
    list = prev; persistList(); renderList();
  });
});
$('#shareList').addEventListener('click', shareList);
$('#fab').addEventListener('click', openComposer);
$('#cCancel').addEventListener('click', closeComposer);
$('#composer').addEventListener('submit', e => { e.preventDefault(); addManual(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('#sheet').classList.contains('open')) closeSheet();
  else if (!$('#composer').hidden) closeComposer();
});
window.addEventListener('popstate', () => {           // Android back button closes the sheet
  if (sheetPushed) { sheetPushed = false; hideSheet(); }
});

/* ── PWA ── */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredInstall = e; $('#installBtn').hidden = false;
});
$('#installBtn').addEventListener('click', async () => {
  await deferredInstall?.prompt();
  $('#installBtn').hidden = true;
});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js');
}

/* ── Init ── */
renderChips(); renderSaved(); renderList(); purgeOld();
setInterval(purgeOld, 60000);
