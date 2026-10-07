let DATA = {log:[], projects:[]}, TIERS = [], ROWS = [], LOG = [], PROJECTS = [];
const CUR = "";
const VIEW = location.pathname.startsWith('/view') || new URLSearchParams(location.search).has('view');
if (VIEW) document.body.classList.add('viewonly');
const state = {tier:0, tech:null, q:'', sort:{key:null, dir:1}, edit:false, pin:null};
let cart = [];
try { cart = JSON.parse(localStorage.getItem('pricelist-cart') || '[]'); } catch(e) {}

async function loadData() {
  try {
    const [jRes, cRes] = await Promise.all([fetch('data/data.json'), fetch('data/pricing_data.csv')]);
    DATA = await jRes.json();
    const csvText = await cRes.text();
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l);
    const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').replace(/""/g, '"'));
    const rcIdx = headers.findIndex(h => h.toLowerCase() === 'rate_card');
    TIERS = headers.slice(3).filter((_, i) => rcIdx === -1 || (i + 3) !== rcIdx);
    DATA.tiers = TIERS;
    ROWS = [];
    for(let i=1; i<lines.length; i++) {
       const row = [];
       let inQ = false, curr = '';
       for(let j=0; j<lines[i].length; j++) {
         const c = lines[i][j];
         if(c === '"') inQ = !inQ;
         else if(c === ',' && !inQ) { row.push(curr); curr=''; }
         else curr += c;
       }
       row.push(curr);
       const p = row.map(v => v.replace(/^"|"$/g, '').replace(/""/g, '"'));
       let rate_card = true;
       if (rcIdx !== -1 && p.length > rcIdx) {
         rate_card = String(p[rcIdx]).toLowerCase().trim() === 'true';
       }
       const rawPrices = p.slice(3).filter((_, idx) => rcIdx === -1 || (idx + 3) !== rcIdx);
       ROWS.push({ id: i-1, service: p[0], tech: p[1], unit: p[2], rate_card, prices: rawPrices.map(x => x === '' ? null : Number(x)) });
    }
    DATA.rows = ROWS;
    LOG = DATA.log = DATA.log || [];
    PROJECTS = DATA.projects = DATA.projects || Array.from({length:1}, (_, i) => newProject(i));
    renderAll();
    renderCart();
    try { updateProjUi(); renderProjects(); } catch(e) {}
  } catch(e) {
    console.error(e);
    document.body.innerHTML = '<h2>Failed to load data. Make sure the server is running.</h2>';
  }
}
loadData();

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => CUR + n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const moneyR = n => CUR + Math.round(n).toLocaleString();
const pretty = t => t.replace(/_/g,' ');
const saveCart = () => { try { localStorage.setItem('pricelist-cart', JSON.stringify(cart)); } catch(e) {} };
let toastTimer;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = '', 3000);
}

function techCounts(ti){
  const m = new Map();
  ROWS.forEach(r => { if (state.edit || r.prices[ti] != null) m.set(r.tech, (m.get(r.tech)||0)+1); });
  return [...m.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
}

function renderFilters(){
  $('tiers').innerHTML = TIERS.map((t,i) =>
    `<button class="chip${i===state.tier?' on':''}" data-tier="${i}" aria-pressed="${i===state.tier}">${esc(pretty(t))}</button>`).join('');
  const counts = techCounts(state.tier);
  const total = counts.reduce((a,c)=>a+c[1],0);
  const chip = (label, n, val, on) =>
    `<button class="chip${on?' on':''}" data-tech="${esc(val)}" aria-pressed="${on}">${esc(label)}<span class="c">${n}</span></button>`;
  $('techs').innerHTML = chip('All', total, '__all__', state.tech == null) +
    counts.map(([t,n]) => chip(t, n, t, state.tech === t)).join('');
}

function sortVal(r, key, ti){
  return key === 'price' ? r.prices[ti] : String(r[key] || '');
}
function th(key, label, cls){
  const on = state.sort.key === key;
  const aria = on ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none';
  const arr = on ? (state.sort.dir === 1 ? '▲' : '▼') : '↕';
  return `<th class="${cls||''}" aria-sort="${aria}"><button class="sh" data-sort="${key}">${esc(label)}<span class="arr">${arr}</span></button></th>`;
}

function renderTable(){
  if (state.edit) return renderEditTable();
  const ti = state.tier, needle = state.q.toLowerCase();
  const list = ROWS.map(r=>({r,i:r.id})).filter(({r}) =>
    r.prices[ti] != null &&
    (state.tech == null || r.tech === state.tech) &&
    (!needle || r.service.toLowerCase().includes(needle)));
  const {key, dir} = state.sort;
  if (key) list.sort((a,b) => {
    const x = sortVal(a.r,key,ti), y = sortVal(b.r,key,ti);
    return dir * (typeof x === 'number' ? x - y : x.localeCompare(y, undefined, {numeric:true, sensitivity:'base'}));
  });
  const showTech = state.tech == null;
  $('tbl').innerHTML = list.length ? `<div class="tbl-wrap"><table>
    <thead><tr>${th('service','Service')}${showTech?th('tech','Technology'):''}${th('unit','Unit')}
    ${th('price', pretty(TIERS[ti]), 'r')}<th class="r q">Qty</th><th class="act"></th></tr></thead><tbody>` +
    list.map(({r,i}) => {
      const color = r.rate_card === false ? ' style="color:var(--warn);"' : '';
      return `<tr${color}><td>${esc(r.service)}</td>${showTech?`<td class="unit">${esc(r.tech)}</td>`:''}
      <td class="unit">${esc(r.unit)}</td><td class="r num">${money(r.prices[ti])}</td>
      <td class="r q"><input class="qty num" type="number" min="1" step="1" value="1" id="q${i}" aria-label="Quantity for ${esc(r.service)}"></td>
      <td class="act"><button class="add" data-add="${i}">Add</button></td></tr>`;}).join('') +
    `</tbody></table></div>` : `<p class="note">No services match these filters.</p>`;
}

function renderAll(){ renderFilters(); renderTable(); }

function renderCart(){
  const c = $('cart');
  if (!cart.length){ c.innerHTML = `<p class="empty">Nothing added yet. Use Add on any row.</p>`; return; }
  let total = 0;
  const items = cart.map((it,k) => {
    const lt = it.price * it.qty; total += lt;
    return `<div class="item"><span class="n">${esc(it.service)}</span><span class="num">${money(lt)}</span>
      <span class="m">${esc(pretty(TIERS[it.tier]))} · ${money(it.price)} ${esc(it.unit)}</span>
      <span class="ctl"><label>Qty <input class="qty num" type="number" min="1" step="1" value="${it.qty}" data-qty="${k}"></label>
      <button class="rm" data-rm="${k}">Remove</button></span></div>`;
  }).join('');
  c.innerHTML = items + `<div class="total"><span>Total</span><span class="num" id="tot">${money(total)}</span></div>
    <div class="actions"><button class="btn" data-act="copy">Copy as table</button>
    <button class="btn" data-act="copysimple">Copy simple</button>
    <button class="btn ghost" data-act="csv" title="Download CSV">CSV</button>
    <button class="btn ghost" data-act="clear">Clear</button></div>`;
}

function addItem(i, btn){
  const r = ROWS.find(x => x.id === i), ti = state.tier;
  const qty = Math.max(1, Math.floor(Number($('q'+i).value) || 1));
  const hit = cart.find(x => x.row === i && x.tier === ti);
  if (hit) hit.qty += qty;
  else cart.push({row:i, tier:ti, service:r.service, unit:r.unit, price:r.prices[ti], qty});
  saveCart(); renderCart();
  btn.classList.add('flash'); btn.textContent = 'Added';
  setTimeout(() => { btn.classList.remove('flash'); btn.textContent = 'Add'; }, 900);
  $('q'+i).value = 1;
}

function listText(){
  const head = ['Qty','Service','Tier','Unit price','Unit','Total'];
  const right = [true,false,false,true,false,true];
  let total = 0;
  const rows = cart.map(it => { const lt = it.price*it.qty; total += lt;
    return [String(it.qty), it.service, pretty(TIERS[it.tier]), it.price.toFixed(2), it.unit, lt.toFixed(2)]; });
  const w = head.map((_,c) => Math.max(...[head,...rows].map(r => r[c].length)));
  const fmt = r => r.map((v,c) => right[c] ? v.padStart(w[c]) : v.padEnd(w[c])).join('  ').trimEnd();
  const width = fmt(head).length, rule = '-'.repeat(width), tot = total.toFixed(2);
  return [fmt(head), rule, ...rows.map(fmt), rule, 'Total' + tot.padStart(width - 5)].join('\n');
}
function listSimple(){
  let total = 0;
  const lines = cart.map(it => { const lt = it.price*it.qty; total += lt;
    return `${it.qty} x ${it.service} (${pretty(TIERS[it.tier])}): ${money(lt)}`; });
  return lines.join('\n') + `\n\nTotal: ${money(total)}`;
}
function listHtml(){
  const cell = (v, right, bold) => `<td style="padding:4px 8px;border:1px solid #d9e2db;color:#000;background:#fff;font-size:11pt;line-height:normal;${right ? 'text-align:right;' : 'text-align:left;'}font-weight:${bold ? 'bold' : 'normal'};">${v}</td>`;
  const head = (v, right) => `<th style="padding:4px 8px;border:1px solid #d9e2db;color:#000;background:#fff;font-size:11pt;line-height:normal;text-align:${right ? 'right' : 'left'};font-weight:bold;">${v}</th>`;
  let total = 0;
  const rows = cart.map(it => { const lt = it.price*it.qty; total += lt;
    return `<tr>${cell(it.qty,true)}${cell(esc(it.service))}${cell(esc(pretty(TIERS[it.tier])))}${cell(money(it.price),true)}${cell(esc(it.unit))}${cell(money(lt),true)}</tr>`; }).join('');
  return `<table style="border-collapse:collapse;border:1px solid #d9e2db;color:#000;background:#fff;font-size:11pt;">` +
    `<thead><tr>${head('Qty',1)}${head('Service')}${head('Tier')}${head('Unit price',1)}${head('Unit')}${head('Total',1)}</tr></thead>` +
    `<tbody>${rows}<tr><td colspan="5" style="padding:4px 8px;border:1px solid #d9e2db;color:#000;background:#fff;font-size:11pt;line-height:normal;text-align:right;font-weight:bold;">Total</td>${cell(money(total),true,true)}</tr></tbody></table>`;
}
function copyText(text){
  const fb = () => { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand('copy'); ta.remove(); };
  return (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).catch(fb);
}
function copyRich(html, text){
  // Works on plain-http too: intercept the copy event and write our own payload,
  // so output never depends on the browser serialising computed page styles.
  const fb = () => {
    const ta = document.createElement('textarea'); ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(ta); ta.select();
    const h = e => { e.clipboardData.setData('text/html', html); e.clipboardData.setData('text/plain', text); e.preventDefault(); };
    document.addEventListener('copy', h, {once:true});
    let ok = false; try { ok = document.execCommand('copy'); } finally { document.removeEventListener('copy', h); ta.remove(); }
    if (!ok) throw new Error('copy failed');
  };
  if (navigator.clipboard && window.ClipboardItem)
    return navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], {type:'text/html'}),
      'text/plain': new Blob([text], {type:'text/plain'}) })]).catch(() => { try { fb(); } catch(e) { return Promise.reject(e); } });
  try { fb(); return Promise.resolve(); } catch(e) { return Promise.reject(e); }
}
function listCsv(){
  const q = s => '"' + String(s).replace(/"/g,'""') + '"';
  const rows = [['Service','Tier','Unit','Unit price','Qty','Line total'].map(q).join(',')];
  cart.forEach(it => rows.push([q(it.service), q(pretty(TIERS[it.tier])), q(it.unit),
    it.price.toFixed(2), it.qty, (it.price*it.qty).toFixed(2)].join(',')));
  return rows.join('\n');
}

document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.tier != null){
    state.tier = +t.dataset.tier;
    if (state.tech && !techCounts(state.tier).some(c => c[0] === state.tech)) state.tech = null;
    renderAll();
  }
  else if (t.dataset.tech != null){ state.tech = t.dataset.tech === '__all__' ? null : t.dataset.tech; renderAll(); }
  else if (t.dataset.add != null) addItem(+t.dataset.add, t);
  else if (t.dataset.rm != null){ cart.splice(+t.dataset.rm,1); saveCart(); renderCart(); }
  else if (t.dataset.act === 'clear'){ cart = []; saveCart(); renderCart(); }
  else if (t.dataset.act === 'copy' || t.dataset.act === 'copysimple'){
    const label = t.textContent;
    const done = () => { t.textContent = 'Copied'; setTimeout(()=>t.textContent=label,900); };
    (t.dataset.act === 'copy' ? copyRich(listHtml(), listText()) : copyText(listSimple())).then(done, () => {
      t.textContent = 'Failed'; setTimeout(()=>t.textContent=label,900); });
  }
  else if (t.dataset.sort){
    const k = t.dataset.sort, so = state.sort;
    if (so.key !== k) { so.key = k; so.dir = 1; }
    else if (so.dir === 1) so.dir = -1;
    else so.key = null;
    renderTable();
  }
  else if (t.dataset.act === 'csv'){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([listCsv()],{type:'text/csv'}));
    a.download = 'selected_items.csv'; a.click(); URL.revokeObjectURL(a.href);
  }
});
// ---------- edit mode ----------
let dirty = false;
const setDirty = v => { dirty = v; $('dirty').hidden = !v; $('saveBtn').hidden = !(v || state.edit); };
const markDirty = () => setDirty(true);
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
const byId = id => ROWS.find(r => r.id === id);
const uniq = f => [...new Set(ROWS.map(r => r[f]).filter(Boolean))].sort((a,b) => a.localeCompare(b));
function updateLists(){
  const opts = f => uniq(f).map(v => `<option value="${esc(v)}">`).join('');
  $('techlist').innerHTML = opts('tech'); $('unitlist').innerHTML = opts('unit');
}

function renderEditTable(){
  const needle = state.q.toLowerCase();
  let list = ROWS.filter(r => r.id === state.pin ||
    ((state.tech == null || r.tech === state.tech) && (!needle || r.service.toLowerCase().includes(needle))));
  const {key, dir} = state.sort;
  if (key && key !== 'price') list = list.slice().sort((a,b) =>
    dir * String(a[key]||'').localeCompare(String(b[key]||''), undefined, {numeric:true, sensitivity:'base'}));
  const pi = list.findIndex(r => r.id === state.pin);
  if (pi > 0) list.unshift(list.splice(pi,1)[0]);
  const inp = (attrs, val, cls) => `<input class="ed ${cls||''}" ${attrs} value="${esc(val)}">`;
  $('tbl').innerHTML = list.length ? `<div class="tbl-wrap"><table><thead><tr>${th('service','Service')}${th('tech','Technology')}${th('unit','Unit')}<th class="act">Rate Card</th>` +
    TIERS.map((t,i) => `<th class="r"><input class="ed tn num" data-tn="${i}" value="${esc(t)}" aria-label="Tier ${i+1} name"></th>`).join('') +
    `<th class="act"></th></tr></thead><tbody>` +
    list.map(r => {
      const isRc = r.rate_card !== false;
      const rcStyle = isRc ? '' : ' style="color:var(--warn);"';
      return `<tr data-id="${r.id}"${rcStyle}><td>${inp('data-f="service" placeholder="Service name"', r.service, 'wide')}</td>` +
      `<td>${inp('data-f="tech" list="techlist"', r.tech)}</td><td>${inp('data-f="unit" list="unitlist"', r.unit)}</td>` +
      `<td class="act" style="text-align:center;"><input type="checkbox" data-f="rate_card" ${isRc ? 'checked' : ''}></td>` +
      TIERS.map((_,i) => `<td class="r"><input class="ed num pr" type="number" step="any" min="0" data-p="${i}" value="${r.prices[i]==null?'':r.prices[i]}" aria-label="Price, tier ${i+1}"></td>`).join('') +
      `<td class="act"><button class="rm" data-del="${r.id}">Delete</button></td></tr>`;
    }).join('') +
    `</tbody></table></div>` : `<p class="note">No services match these filters.</p>`;
  updateLists();
}

function setEdit(on){
  if (VIEW) return;
  if (!on){
    const n = ROWS.length;
    for (let i = ROWS.length - 1; i >= 0; i--) if (!ROWS[i].service.trim()) ROWS.splice(i,1);
    if (ROWS.length !== n) markDirty();
    state.pin = null;
  }
  state.edit = on;
  if (!on && state.tech && !techCounts(state.tier).some(c => c[0] === state.tech)) state.tech = null;
  document.body.classList.toggle('editing', on);
  $('editbar').hidden = !on;
  $('editBtn').textContent = on ? 'Done' : 'Edit';
  setDirty(dirty);
  renderAll(); renderCart();
}

function syncCart(id, oldService){
  const r = byId(id); if (!r) return;
  cart.forEach(it => { if (it.row === id && it.service === oldService){
    it.service = r.service; it.unit = r.unit; if (r.prices[it.tier] != null) it.price = r.prices[it.tier]; } });
  saveCart(); renderCart();
}

function addService(){
  const id = ROWS.reduce((m,r) => Math.max(m, r.id), -1) + 1;
  ROWS.push({id, service:'', tech: state.tech || 'Other', unit:'', rate_card: true, prices: TIERS.map(() => null)});
  state.pin = id; state.q = ''; $('q').value = '';
  markDirty(); renderAll();
  const f = document.querySelector(`tr[data-id="${id}"] [data-f="service"]`);
  if (f){ f.focus(); f.scrollIntoView({block:'nearest'}); }
}

function download(text, type, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportServices(){
  const q = v => '"' + String(v).replace(/"/g,'""') + '"';
  const lines = [['Service','Technology','Unit',...TIERS, 'Rate_card'].map(q).join(',')];
  ROWS.filter(r => r.service.trim()).forEach(r =>
    lines.push([q(r.service), q(r.tech), q(r.unit), ...r.prices.map(p => p == null ? '' : p), q(r.rate_card !== false)].join(',')));
  download(lines.join('\n'), 'text/csv', 'services.csv');
}
function exportExcelServices(){
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '<table><tr><th>Service</th><th>Technology</th><th>Unit</th>' + TIERS.map(t => '<th>'+esc(t)+'</th>').join('') + '</tr>';
  ROWS.filter(r => r.service.trim()).forEach(r => {
    html += '<tr><td>' + esc(r.service) + '</td><td>' + esc(r.tech) + '</td><td>' + esc(r.unit) + '</td>' + r.prices.map(p => '<td>'+(p==null?'':p)+'</td>').join('') + '</tr>';
  });
  html += '</table>';
  const tpl = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Services</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>${html}</body></html>`;
  download(tpl, 'application/vnd.ms-excel', 'services.xls');
}

// The page rewrites itself: same HTML, with the data block replaced by the current data.
async function savePage(){
  const q = v => '"' + String(v).replace(/"/g,'""') + '"';
  const csvLines = [['Service','Technology','Unit',...TIERS, 'Rate_card'].map(q).join(',')];
  ROWS.filter(r => r.service.trim()).forEach(r =>
    csvLines.push([q(r.service), q(r.tech), q(r.unit), ...r.prices.map(p => p == null ? '' : p), q(r.rate_card !== false)].join(',')));
  const csvText = csvLines.join('\n');
  const jsonText = JSON.stringify({ log: LOG, projects: PROJECTS });
  try {
    const btn = document.getElementById('saveBtn');
    btn.textContent = 'Saving...';
    const res = await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv: csvText, json: jsonText }) });
    if(!res.ok) throw new Error("HTTP " + res.status);
    setDirty(false);
    btn.textContent = 'Save page';
    showToast('Saved successfully!');
  } catch (err) {
    showToast('Error saving data: ' + err.message, true);
    document.getElementById('saveBtn').textContent = 'Save page';
  }
}

document.addEventListener('change', e => {
  const el = e.target, ds = el.dataset || {};
  if (ds.qty != null){
    cart[+ds.qty].qty = Math.max(1, Math.floor(Number(el.value) || 1));
    saveCart(); renderCart(); return;
  }
  if (!state.edit) return;
  if (ds.tn != null){
    const was = TIERS[+ds.tn];
    TIERS[+ds.tn] = el.value.trim() || was; el.value = TIERS[+ds.tn];
    if (TIERS[+ds.tn] !== was) addLog('Renamed tier', '', 'Tier name', was, TIERS[+ds.tn]);
    markDirty(); renderFilters(); renderCart(); return;
  }
  const tr = el.closest('tr[data-id]'); if (!tr) return;
  const r = byId(+tr.dataset.id), old = r.service;
  if (ds.f){
    let v;
    if (ds.f === 'rate_card') v = el.checked;
    else if (ds.f === 'tech') v = el.value.trim() || 'Other';
    else v = el.value.trim();
    const was = r[ds.f]; r[ds.f] = v;
    if (ds.f !== 'rate_card') el.value = v;
    const label = {service:'Service name', tech:'Technology', unit:'Unit', rate_card:'Rate Card'}[ds.f];
    if (v !== was) addLog(ds.f === 'service' && !was ? 'Added' : 'Edited', r.service, label, was, v);
  } else if (ds.p != null){
    const n = el.value === '' ? null : Number(el.value);
    const was = r.prices[+ds.p], now = (n == null || isNaN(n)) ? null : n;
    r.prices[+ds.p] = now;
    if (now !== was) addLog('Edited', r.service || '(new service)', 'Price (' + TIERS[+ds.p] + ')', was, now);
  } else return;
  markDirty(); updateLists(); renderFilters(); syncCart(r.id, old);
});
document.addEventListener('click', e => {
  const t = e.target.closest('button[data-del]'); if (!t) return;
  const r = byId(+t.dataset.del); if (!r) return;
  if (!r.service.trim() || confirm(`Delete "${r.service}"?`)){
    if (r.service.trim()) addLog('Deleted', r.service, '', [r.tech, r.unit, ...r.prices.map(p => p == null ? '-' : p)].join(' | '), '');
    ROWS.splice(ROWS.indexOf(r),1); markDirty(); renderAll(); }
});
// ---------- projects ----------
function newProject(id){ return {id, name:'', desc:'', tier:0, samples:null, genome:null, cov:30, items:[]}; }
// Flow cell yield comes from the "(~100-120 Gb)" in the service name; the lower figure is used.
const yieldGb = r => { const m = r && /\(~?\s*(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?\s*Gb\)/i.exec(r.service); return m ? +m[1] : null; };
const defaultMode = r => yieldGb(r) ? 'gb' : (/sample|library/i.test(r.unit) ? 'sample' : 'fixed');
const projById = id => PROJECTS.find(p => p.id === id);
const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
const fmtN = n => n.toLocaleString(undefined, {maximumFractionDigits:2});

function compute(p){
  const S = p.samples > 0 ? p.samples : 0;
  const gb = (S && p.genome > 0 && p.cov > 0) ? S * (p.genome / 1000) * p.cov : null;
  const warn = []; let total = 0;
  const lines = p.items.map(it => {
    const r = byId(it.row); if (r) it.name = r.service;
    const price = r ? r.prices[p.tier] : null, y = yieldGb(r);
    let qty = 0;
    if (it.mode === 'gb'){ if (y && gb) qty = Math.ceil(gb / y - 1e-9); }
    else if (it.mode === 'sample') qty = S * (it.n || 0);
    else qty = it.n || 0;
    const line = price != null ? price * qty : 0;
    if (!r) warn.push(`"${it.name}" no longer exists in the price list.`);
    else if (price == null) warn.push(`"${it.name}" has no price in ${pretty(TIERS[p.tier])}.`);
    if (it.mode === 'gb' && !y) warn.push(`"${it.name}" has no Gb figure in its name.`);
    total += line;
    return {it, r, price, qty, line, y};
  });
  if (lines.some(l => l.it.mode === 'sample') && !S) warn.push('Enter the number of samples.');
  if (lines.some(l => l.it.mode === 'gb' && l.y) && !gb) warn.push('Enter samples, genome size and coverage to size flow cell items.');
  return {lines, gb, total, per: S ? total / S : null, warn: [...new Set(warn)]};
}
const qtyText = l => '= ' + fmtN(l.qty) + (l.it.mode === 'gb' && l.y ? ` (${l.y} Gb each)` : '');

function cardHtml(p){
  const c = compute(p), v = x => x == null ? '' : x;
  const groups = new Map();
  ROWS.forEach(r => { if (!groups.has(r.tech)) groups.set(r.tech, []); groups.get(r.tech).push(r); });
  const opts = [...groups.entries()].sort((a,b) => a[0].localeCompare(b[0])).map(([t, rs]) =>
    `<optgroup label="${esc(t)}">` + rs.map(r => { const ok = r.prices[p.tier] != null;
      return `<option value="${r.id}"${ok ? '' : ' disabled'}>${esc(r.service)} (${esc(r.unit)})${ok ? '' : ' - no price'}</option>`; }).join('') + '</optgroup>').join('');
  const modeOpts = (l) => [['sample','per sample ×'],['fixed','fixed qty'],...(l.y ? [['gb','by data (Gb)']] : [])]
    .map(([k,t]) => `<option value="${k}"${l.it.mode === k ? ' selected' : ''}>${t}</option>`).join('');
  const lines = c.lines.map((l,i) => `<div class="pl" data-i="${i}">
      <div class="pn">${esc(l.it.name)}<span class="pu">${esc(l.r ? l.r.unit : '')}</span></div>
      <span class="num" data-out="lp${i}">${l.price == null ? '—' : money(l.line)}</span>
      <button class="rm" data-plrm="${i}" aria-label="Remove item">×</button>
      <div class="ctl"><select class="ed" data-pl="mode">${modeOpts(l)}</select>
        <input class="ed num" type="number" min="0" step="any" data-pl="n" value="${l.it.n}"${l.it.mode === 'gb' ? ' disabled' : ''}>
        <span data-out="lq${i}">${qtyText(l)}</span></div></div>`).join('');
  return `<article class="proj" data-pid="${p.id}">
    <div class="ph"><input class="ed pname" data-pf="name" placeholder="Example name" value="${esc(p.name)}">
      <button class="rm" data-pdel aria-label="Delete card">Delete</button></div>
    <input class="ed" data-pf="desc" placeholder="Short description (optional)" value="${esc(p.desc)}">
    <div class="pf">
      <label>Tier<select class="ed" data-pf="tier">${TIERS.map((t,i) => `<option value="${i}"${i === p.tier ? ' selected' : ''}>${esc(pretty(t))}</option>`).join('')}</select></label>
      <label>Samples<input class="ed num" type="number" min="0" step="1" data-pf="samples" value="${v(p.samples)}"></label>
      <label>Genome (Mb)<input class="ed num" type="number" min="0" step="any" data-pf="genome" value="${v(p.genome)}"></label>
      <label>Coverage (×)<input class="ed num" type="number" min="0" step="any" data-pf="cov" value="${v(p.cov)}"></label>
    </div>
    <div>${lines}</div>
    <select class="ed" data-padd><option value="">+ Add item…</option>${opts}</select>
    <div class="pwarn" data-out="warn">${esc(c.warn.join(' '))}</div>
    <div class="ptot"><div><span>Data needed</span><b data-out="gb">${c.gb ? fmtN(c.gb) + ' Gb' : '—'}</b></div>
      <div><span>Total</span><b data-out="total">${p.items.length ? money(c.total) : '—'}</b></div>
      <div><span>Per sample</span><b data-out="per">${p.items.length && c.per != null ? money(c.per) : '—'}</b></div></div>
  </article>`;
}
const hasContent = p => p.name || p.desc || p.items.length || p.samples || p.genome;
let projMode = 'show';
const mbText = mb => mb >= 1000 ? fmtN(mb / 1000) + ' Gb' : fmtN(mb) + ' Mb';
function qtyDesc(l){
  const unit = l.r ? l.r.unit : '';
  return `${fmtN(l.qty)} × ${l.price == null ? '—' : money(l.price)} ${unit}` + (l.it.mode === 'gb' && l.y ? ` · ${l.y} Gb each` : '');
}
function showHtml(p){
  if (!hasContent(p)) return `<article class="pc empty" data-pid="${p.id}"><b>Empty example</b><span>Switch to Edit to fill it in</span></article>`;
  const c = compute(p), max = c.total || 1;
  const pills = [pretty(TIERS[p.tier]), p.samples ? `${fmtN(p.samples)} sample${p.samples == 1 ? '' : 's'}` : '',
    p.genome ? mbText(p.genome) + ' genome' : '', p.genome && p.cov ? `${fmtN(p.cov)}× coverage` : '']
    .filter(Boolean).map(t => `<span class="pill">${esc(t)}</span>`).join('');
  const lines = c.lines.map(l => `<li><div class="lr"><span>${esc(l.it.name)}</span><span class="num">${l.price == null ? '—' : moneyR(l.line)}</span></div>
      <div class="lm"><span class="qty-badge">${fmtN(l.qty)}×</span>${l.price == null ? '—' : moneyR(l.price)} ${esc(l.r ? l.r.unit : '')}${l.it.mode === 'gb' && l.y ? ` · ${l.y} Gb each` : ''}</div></li>`).join('');
  return `<article class="pc" data-pid="${p.id}">
    <div><h3>${esc(p.name || 'Untitled example')}</h3>${p.desc ? `<p class="desc">${esc(p.desc)}</p>` : ''}</div>
    <div class="pills">${pills}</div>
    <div class="kpis"><div><span>Total</span><b>${p.items.length ? moneyR(c.total) : '—'}</b></div>
      <div class="per"><span>Per sample</span><b>${p.items.length && c.per != null ? moneyR(c.per) : '—'}</b></div></div>
    <div class="data">${c.gb ? fmtN(c.gb) + ' Gb of data needed' : ''}</div>
    <ul>${lines}</ul>
    <div class="pwarn">${esc(c.warn.join(' '))}</div>
  </article>`;
}
const renderProjects = () => { $('projgrid').innerHTML = PROJECTS.map(projMode === 'show' ? showHtml : cardHtml).join(''); };
function updateProjUi(){
  document.querySelectorAll('#projMode button').forEach(b => { const on = b.dataset.pm === projMode;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $('addProj').hidden = projMode !== 'edit';
  $('projgrid').classList.toggle('show', projMode === 'show');
}
function setProjMode(m){ projMode = m; updateProjUi(); renderProjects(); }
const redrawCard = id => { const el = document.querySelector(`.proj[data-pid="${id}"]`); if (el) el.outerHTML = cardHtml(projById(id)); };
function refreshCard(art){
  const p = projById(+art.dataset.pid), c = compute(p);
  const set = (k, t) => { const e = art.querySelector(`[data-out="${k}"]`); if (e) e.textContent = t; };
  c.lines.forEach((l,i) => { set('lp'+i, l.price == null ? '—' : money(l.line)); set('lq'+i, qtyText(l)); });
  set('gb', c.gb ? fmtN(c.gb) + ' Gb' : '—');
  set('total', p.items.length ? money(c.total) : '—');
  set('per', p.items.length && c.per != null ? money(c.per) : '—');
  set('warn', c.warn.join(' '));
}
{
  const pg = $('projgrid');
  const itemOf = el => { const art = el.closest('.proj'); return [projById(+art.dataset.pid), el.closest('.pl') ? +el.closest('.pl').dataset.i : null, art]; };
  pg.addEventListener('focusin', e => {
    const el = e.target; if (!el.closest('.proj')) return;
    const [p, i] = itemOf(el);
    if (el.dataset.pf) el.dataset.was = p[el.dataset.pf] == null ? '' : p[el.dataset.pf];
    else if (el.dataset.pl === 'n') el.dataset.was = p.items[i].n;
  });
  pg.addEventListener('input', e => {
    const el = e.target; if (el.type !== 'number') return;
    const [p, i, art] = itemOf(el);
    if (el.dataset.pf) p[el.dataset.pf] = num(el.value);
    else if (el.dataset.pl === 'n') p.items[i].n = num(el.value) || 0;
    else return;
    markDirty(); refreshCard(art);
  });
  pg.addEventListener('change', e => {
    const el = e.target; if (!el.closest('.proj')) return;
    const [p, i, art] = itemOf(el), ds = el.dataset;
    if (ds.pf){
      const f = ds.pf, old = ds.was == null ? '' : ds.was;
      if (f === 'name' || f === 'desc') p[f] = el.value.trim();
      else if (f === 'tier') p.tier = +el.value;
      else p[f] = num(el.value);
      const now = f === 'tier' ? TIERS[p.tier] : (p[f] == null ? '' : p[f]);
      const was = f === 'tier' ? TIERS[+old] : old;
      if (String(now) !== String(was)) markDirty();
      if (f === 'tier') redrawCard(p.id); else refreshCard(art);
    } else if (ds.padd !== undefined){
      const r = byId(+el.value); if (!r) return;
      p.items.push({row: r.id, name: r.service, mode: defaultMode(r), n: 1});
      markDirty(); redrawCard(p.id);
    } else if (ds.pl === 'mode'){
      p.items[i].mode = el.value;
      markDirty(); redrawCard(p.id);
    } else if (ds.pl === 'n'){
      const it = p.items[i], was = ds.was == null ? '' : ds.was;
      if (String(it.n) !== String(was)) markDirty();
      refreshCard(art);
    }
  });
  pg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !b.closest('.proj')) return;
    const [p, , art] = itemOf(b);
    if (b.dataset.plrm != null){
      p.items.splice(+b.dataset.plrm, 1);
      markDirty(); redrawCard(p.id);
    } else if (b.dataset.pdel !== undefined){
      const has = p.name || p.desc || p.items.length;
      if (!has || confirm(`Delete "${p.name || 'this card'}"?`)){
        PROJECTS.splice(PROJECTS.indexOf(p), 1); markDirty(); renderProjects();
      }
    }
  });
  $('addProj').addEventListener('click', () => {
    const id = PROJECTS.reduce((m,p) => Math.max(m, p.id), -1) + 1;
    PROJECTS.push(newProject(id)); markDirty(); renderProjects();
    const f = document.querySelector(`.proj[data-pid="${id}"] [data-pf="name"]`);
    if (f){ f.focus(); f.scrollIntoView({block:'nearest'}); }
  });
}

$('projMode').addEventListener('click', e => { const b = e.target.closest('button[data-pm]'); if (b) setProjMode(b.dataset.pm); });
updateProjUi();

// ---------- edit log ----------
let logDir = -1;   // -1 newest first, 1 oldest first
const pad2 = n => String(n).padStart(2, '0');
const fmtTime = iso => { const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
function addLog(action, service, field, from, to){
  LOG.push({t: new Date().toISOString(), action, service: service || '', field: field || '',
            from: from == null ? '' : String(from), to: to == null ? '' : String(to)});
}
function sortedLog(){
  return LOG.map((e,i) => ({e,i})).sort((a,b) => logDir * (a.e.t < b.e.t ? -1 : a.e.t > b.e.t ? 1 : a.i - b.i)).map(x => x.e);
}
function renderLog(){
  const rows = sortedLog();
  $('logcount').textContent = `${LOG.length} edit${LOG.length === 1 ? '' : 's'}`;
  $('logtbl').innerHTML = rows.length ? `<div class="tbl-wrap"><table><thead><tr>
    <th aria-sort="${logDir === 1 ? 'ascending' : 'descending'}"><button class="sh" id="logSort">Time<span class="arr">${logDir === 1 ? '▲' : '▼'}</span></button></th>
    <th>Action</th><th>Service</th><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>` +
    rows.map(e => `<tr><td class="num">${fmtTime(e.t)}</td><td>${esc(e.action)}</td><td>${esc(e.service || '—')}</td>
      <td>${esc(e.field || '')}</td><td class="unit">${esc(e.from || '—')}</td><td>${esc(e.to || '—')}</td></tr>`).join('') +
    `</tbody></table></div>` : `<p class="note">No edits recorded yet.</p>`;
}
let lastTab = 'prices';
function setView(v){
  if (VIEW && v === 'log') v = 'prices';
  document.body.dataset.view = v;
  $('logpage').hidden = v !== 'log';
  $('projects').hidden = v !== 'projects';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === v));
  $('logBtn').textContent = v === 'log' ? 'Hide log' : 'Show log';
  if (v !== 'log') lastTab = v;
  if (v === 'log') renderLog();
  if (v === 'projects') renderProjects();
  window.scrollTo(0, 0);
}
const setLogView = on => setView(on ? 'log' : lastTab);
function exportLog(){
  const q = v => '"' + String(v).replace(/"/g,'""') + '"';
  const lines = [['Time','Action','Service','Field','From','To'].map(q).join(',')];
  sortedLog().forEach(e => lines.push([fmtTime(e.t), e.action, e.service, e.field, e.from, e.to].map(q).join(',')));
  download(lines.join('\n'), 'text/csv', 'edit_log.csv');
}
document.addEventListener('click', e => { if (e.target.closest('#logSort')){ logDir = -logDir; renderLog(); } });
$('logBtn').addEventListener('click', () => setLogView(document.body.dataset.view !== 'log'));
$('tabs').addEventListener('click', e => { const t = e.target.closest('.tab'); if (t) setView(t.dataset.view); });
$('logCsv').addEventListener('click', exportLog);
$('clearLog').addEventListener('click', () => {
  if (!LOG.length || confirm('Clear the entire edit log?')) {
    LOG.length = 0; markDirty(); renderLog();
  }
});
$('editBtn').addEventListener('click', () => setEdit(!state.edit));
$('saveBtn').addEventListener('click', savePage);
$('addSvc').addEventListener('click', addService);
$('exportCsv').addEventListener('click', exportServices);
$('exportExcel').addEventListener('click', exportExcelServices);
$('q').addEventListener('input', e => { state.q = e.target.value.trim(); renderTable(); });
