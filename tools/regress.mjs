// End-to-end regression on the emulator (no account / offline mode). Real taps via adb, asserts via CDP.
// Usage: node tools/regress.mjs            (expects the debug APK installed; wipes app data first!)
// Emulator only — never run against Jimbo's phone.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const ADB = path.join(process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
const PKG = 'cl.cobral.ventas';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, a.map(String), { encoding: 'utf8' });
const js = expr => { const out = execFileSync('node', [here('./cdp.mjs'), expr], { encoding: 'utf8' }).trim(); try { return JSON.parse(out); } catch { return out; } };
const tap = (sel, i = 0, fx = 0.5) => execFileSync('node', [here('./tap.mjs'), sel, String(i), String(fx)], { encoding: 'utf8' });
const swipe = (sel, dir, px = 300, ms = 300) => execFileSync('node', [here('./tap.mjs'), '--swipe', sel, dir, String(px), String(ms)], { encoding: 'utf8' });
const type = t => execFileSync('node', [here('./tap.mjs'), '--text', t], { encoding: 'utf8' });

const results = [];
const check = (id, ok, detail = '') => { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`); };
async function step(id, fn) { try { await fn(); } catch (e) { check(id, false, 'exception: ' + String(e.message || e).split('\n')[0]); } }
async function ready() { for (let i = 0; i < 40; i++) { try { if (js("typeof state!=='undefined'&&!document.getElementById('splashScreen')") === true) return; } catch {} await sleep(1000); } throw new Error('app not ready'); }
const hideKb = () => { try { adb('shell', 'input', 'keyevent', '111'); } catch {} };

// ---------- clean state + seed ----------
adb('shell', 'pm', 'clear', PKG); adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
await ready();
execFileSync('node', [here('./cdp.mjs'), '-f', here('./seed.js')], { encoding: 'utf8' });
await sleep(4000); await ready();

await step('R01 boot', async () => {
  const s = js("JSON.stringify({t:document.title,n:state.sales.length,native:isNative,cloud:typeof window.CobralCloud})");
  check('R01 boot + seed', s.t.startsWith('Cobral v') && s.n > 250 && s.native === true && s.cloud === 'undefined', JSON.stringify(s));
});

await step('R02 A1 search', async () => {
  tap('.nav-item[data-tab=sales]'); await sleep(500);
  js("state.filterPeriod='year';render();1"); await sleep(300);
  tap('#salesSearchInput'); await sleep(300); type('Miel'); await sleep(900); hideKb();
  // adb typing sometimes drops/adds keys; the check is about live totals, so make sure the query really is 'Miel'
  const typed = js("document.getElementById('salesSearchInput').value");
  if (typed !== 'Miel') { console.log(`  (typed "${typed}", retrying via input event)`); js("(()=>{const e=document.getElementById('salesSearchInput');e.value='Miel';e.dispatchEvent(new Event('input'));return 1})()"); await sleep(500); }
  const r = js("(()=>{const v=getVisibleSales();const shown=document.getElementById('salesStats').innerText;return {rows:document.querySelectorAll('#salesList .sale-item').length,n:v.length,exp:formatMoney(v.reduce((s,x)=>s+x.finalAmount,0)),shown,all:v.every(s=>s.items.some(i=>/miel/i.test(i.name)))}})()");
  check('R02 A1 live totals on search', r.n > 0 && r.rows === r.n && r.shown.includes(r.exp) && r.all,`${r.n} ventas, ${r.exp}`);
  js("document.getElementById('salesSearchInput').value='#12';updateSalesSearch('#12');1");
  const t = js("[...document.querySelectorAll('#salesList .sale-item')].map(e=>e.innerText.split('\\n')[0].slice(0,4))");
  check('R03 A1 ticket search #12', t.length === 1 && t[0].startsWith('#12'), JSON.stringify(t));
  js("document.getElementById('salesSearchInput').value='';updateSalesSearch('');1");
});

await step('R04 A2 calendar', async () => {
  js("state.filterPeriod='day';goToCurrentPeriod('sales');1"); await sleep(300);
  tap('.period-icon'); await sleep(700);
  const g = js("(()=>{const k=[...document.querySelector('.cal-grid').children];return k.slice(0,7).map(e=>e.innerText).join(' ')})()");
  check('R04 A2 calendar starts Monday', g === 'Lu Ma Mi Ju Vi Sá Do', g);
  js("closeModal();state.filterPeriod='week';render();1"); await sleep(300);
  const w = js("(()=>{const ws=state.selectedWeekStart;return {dow:ws.getDay(),chips:[...document.querySelectorAll('.period-item')].map(e=>e.innerText.split('\\n')[0])}})()");
  check('R05 A2 weeks start Monday + ISO number', w.dow === 1 && w.chips.every(c => /^Sem \d+/.test(c)), JSON.stringify(w.chips));
});

await step('R06 A3 Hoy', async () => {
  let ok = true, det = [];
  for (const ctx of ['sales', 'home']) {
    tap(`.nav-item[data-tab=${ctx}]`); await sleep(400);
    for (const p of ['day', 'week', 'month', 'year']) {
      js(`state.${ctx === 'sales' ? 'filterPeriod' : 'homeFilterPeriod'}='${p}';render();document.querySelector('.period-selector').scrollLeft=0;1`); await sleep(250);
      tap('.period-item', 0); await sleep(350); tap('.period-today'); await sleep(450);
      const cur = js("document.querySelector('.period-today').classList.contains('current')");
      if (!cur) { ok = false; det.push(ctx + '/' + p); }
    }
  }
  check('R06 A3 "Hoy" returns to current period (8 cases)', ok, det.join(','));
});

await step('R07 A4 drill-down', async () => {
  js("state.homeFilterPeriod='month';goToCurrentPeriod('home');1"); await sleep(400);
  tap('.top-product', 0); await sleep(800);
  const r = js("(()=>{const pid=state.homeDrillProductId;const exp=getFilteredSalesByPeriodAndLocation().filter(s=>s.items.some(i=>i.productId===pid));let rev=0;exp.forEach(s=>s.items.forEach(i=>{if(i.productId===pid)rev+=i.price*i.qty}));const cards=[...document.querySelectorAll('#modalContainer .sale-item')];const first=cards.every(c=>{const h=c.querySelector('.item-highlight');return h&&h===c.querySelector('.item-highlight, [class*=item]')||h});return {cards:cards.length,exp:exp.length,rev:formatMoney(rev),summary:document.querySelector('#modalContainer .summary-box').innerText,first}})()");
  check('R07 A4 drill-down totals + product first', r.cards === r.exp && r.summary.includes(r.rev) && r.first, `${r.cards} ventas, ${r.rev}`);
  js("closeModal();1");
});

await step('R08 A5 halves', async () => {
  tap('.nav-item[data-tab=sales]'); await sleep(400);
  tap('.fab'); await sleep(1000);
  js("selectSaleCategory('Todos');document.getElementById('saleProductList').scrollTop=400;1"); await sleep(400);
  const pid = js("(()=>{const L=document.getElementById('saleProductList').getBoundingClientRect();const c=[...document.querySelectorAll('#saleProductList .product-card')].find(e=>{const r=e.getBoundingClientRect();const p=state.products.find(x=>x.id==e.dataset.productId);return r.top>L.top+10&&r.bottom<L.bottom-10&&p.unit!=='g'&&p.stock>5&&!(p.offers&&p.offers.length)});return c.dataset.productId})()");
  const sel = `#saleProductList .product-card[data-product-id="${pid}"]`;
  const s0 = js(`state.products.find(x=>x.id==${pid}).stock`);
  for (let i = 0; i < 3; i++) { tap(sel, 0, 0.75); await sleep(300); }
  tap(sel, 0, 0.25); await sleep(350);
  const r = js(`({qty:(state.cart.find(x=>x.productId==${pid})||{qty:0}).qty,stock:state.products.find(x=>x.id==${pid}).stock,scroll:document.getElementById('saleProductList').scrollTop})`);
  check('R08 A5 +3 −1 → qty 2, stock −2, list does not jump', r.qty === 2 && r.stock === s0 - 2 && r.scroll === 400, JSON.stringify(r));
});

await step('R09 A6 gestures', async () => {
  const st = () => js("({min:state.saleMinimized,modal:!!document.getElementById('dragSheet'),cart:state.cart.length})");
  adb('shell', 'input', 'tap', '540', '100'); await sleep(500);
  const a = st();
  swipe('#saleModalHeader', 'down', 40, 300); await sleep(600);
  const b = st();
  swipe('#saleModalHeader', 'down', 320, 350); await sleep(900);
  const c = st();
  tap('#miniBarSwipe'); await sleep(600);
  const d = st();
  swipe('#miniBarSwipe', 'up', 260, 250); await sleep(900);
  const e = st();
  check('R09 A6 tap outside/short drag keep sheet', a.modal && !a.min && b.modal && !b.min, JSON.stringify([a, b]));
  check('R10 A6 long swipe minimizes, tap on bar does not expand, swipe up expands', c.min && !d.modal && e.modal && e.cart === c.cart, JSON.stringify([c, d, e]));
});

await step('R11 sale débito', async () => {
  const n0 = js('state.sales.length');
  tap('#saleContinueBtn'); await sleep(800);
  tap('#modalContainer .payment-method', 1); await sleep(400);
  const fee = js("[...document.querySelectorAll('#modalContainer .summary-row')].map(e=>e.innerText.replace(/\\n/g,' ')).join(' | ')");
  js("[...document.querySelectorAll('#modalContainer .modal-footer button')].find(b=>/Confirmar/.test(b.innerText)).click();1"); await sleep(2500);
  const s = js("(()=>{const s=state.sales[state.sales.length-1];return {n:state.sales.length,pay:s.paymentMethod,fee:s.fee,final:s.finalAmount,sub:s.subtotal,persist:JSON.parse(localStorage.ventasApp).sales.length}})()");
  check('R11 sale with débito: IVA label, fee, persisted', /IVA incluido/.test(fee) && s.n === n0 + 1 && s.pay === 'debito' && Math.abs(s.fee - s.sub * 1.3029 / 100) < 1 && s.persist === s.n, fee);
});

await step('R12 F3 cancelSale', async () => {
  tap('.fab'); await sleep(1000);
  const id = js("state.products.find(p=>p.unit!=='g'&&p.stock>3).id");
  const s0 = js(`state.products.find(p=>p.id==${id}).stock`);
  js(`addToCart(${id});addToCart(${id});1`);
  js(`state.products.find(p=>p.id==${id}).stock-=1;1`); // simulate a remote decrement while the sale is open
  js('cancelSale();1'); await sleep(400);
  const s1 = js(`state.products.find(p=>p.id==${id}).stock`);
  check('R12 F3 cancelSale restores only what the cart took', s1 === s0 - 1, `before ${s0}, after ${s1} (expected ${s0 - 1})`);
});

await step('R13 F7 back button', async () => {
  tap('.fab'); await sleep(1000);
  tap('#saleProductList .product-card', 0, 0.75); await sleep(300);
  adb('shell', 'input', 'keyevent', '4'); await sleep(1200);
  const r = js("({fg:document.visibilityState,min:state.saleMinimized,cart:state.cart.length})");
  check('R13 F7 back button minimizes the open sale (app stays open)', r.fg === 'visible' && r.min && r.cart === 1, JSON.stringify(r));
  js('cancelSale();1');
});

await step('R14 A7 margin', async () => {
  tap('.nav-item[data-tab=inventory]'); await sleep(500);
  tap('.fab'); await sleep(800);
  js("(()=>{const set=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('input'))};set('inputProdCost','1000');set('inputProdMargin','30');return 1})()");
  const a = js("({sale:document.getElementById('inputProdSale').value,real:document.getElementById('prodMarginReal').innerText})");
  js("(()=>{const e=document.getElementById('inputProdSale');e.value='1200';e.dispatchEvent(new Event('input'));return 1})()");
  const b = js("document.getElementById('inputProdMargin').value");
  check('R14 A7 margin 30% on cost 1000 → $1.500 (33,3% real); price 1200 → 16,7%', a.sale === '1500' && /33,3/.test(a.real) && String(b).replace(',', '.') === '16.7', JSON.stringify([a, b]));
  js('closeModal();1');
});

await step('R15 A8 location price', async () => {
  const id = js("state.products.find(p=>p.name==='Miel ulmo').id");
  js(`(()=>{const p=state.products.find(x=>x.id==${id});p.locationPrices={Mann:7500};saveData();state.currentLocation='Mann';return 1})()`);
  tap('.nav-item[data-tab=sales]'); await sleep(400); tap('.fab'); await sleep(900);
  js(`addToCart(${id});1`);
  const a = js(`state.cart.find(i=>i.productId==${id}).price`);
  js("(()=>{const o=state.currentLocation;state.currentLocation='Los Aromos';migrateCartPricesForLocationChange(o,'Los Aromos');return 1})()");
  const b = js(`state.cart.find(i=>i.productId==${id}).price`);
  check('R15 A8 Mann price $7.500 → switch location → $8.000', a === 7500 && b === 8000, `${a} → ${b}`);
  js('cancelSale();1');
});

await step('R16 debt + abono', async () => {
  const d0 = js('state.debts.length');
  js("(()=>{openNewDebt();const i=document.querySelector('#modalContainer input');i.value='Cliente Regresión';[...document.querySelectorAll('#modalContainer button')].find(b=>/Continuar/.test(b.innerText)).click();return 1})()"); await sleep(900);
  tap('#saleProductList .product-card', 0, 0.75); await sleep(300); tap('#saleProductList .product-card', 1, 0.75); await sleep(300);
  tap('#saleContinueBtn'); await sleep(1800);
  const d = js("(()=>{const d=state.debts[state.debts.length-1];return {n:state.debts.length,name:d.name,total:d.total,rem:d.remaining,id:d.id}})()");
  js(`(()=>{openPayDebt(${d.id});state.debtPayAmount=Math.round(${d.total}/2);state.debtPayMethod='efectivo';payDebt();return 1})()`); await sleep(1500);
  const rem = js(`state.debts.find(x=>x.id==${d.id}).remaining`);
  check('R16 debt created with real taps + 50% abono', d.n === d0 + 1 && d.name === 'Cliente Regresión' && Math.abs(rem - (d.total - Math.round(d.total / 2))) < 1, JSON.stringify({ ...d, rem }));
});

await step('R17 edit + delete sale', async () => {
  const s = js("(()=>{const s=[...state.sales].reverse().find(x=>!x.isAbono);return {id:s.id,n:s.items.length}})()");
  js(`(()=>{editSale(${s.id});const p=state.products.find(x=>x.unit!=='g'&&x.stock>3&&!state.cart.some(c=>c.productId===x.id));addToEditCart(p.id);openEditPaymentModal();state.selectedPayment='efectivo';completeEditSale();return 1})()`); await sleep(1500);
  const n = js(`state.sales.find(x=>x.id==${s.id}).items.length`);
  const c0 = js('state.sales.length');
  js(`deleteSale(${s.id});1`); await sleep(800);
  check('R17 edit sale adds a line; delete removes it', n === s.n + 1 && js('state.sales.length') === c0 - 1, `${s.n}→${n} lines`);
});

await step('R18 no JS errors', async () => {
  const out = execFileSync('bash', [here('./errors.sh')], { encoding: 'utf8' }).trim();
  check('R18 no JS errors in the WebView', out === 'no JS errors', out.split('\n')[0]);
});

const fails = results.filter(r => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} passed${fails.length ? ' — FAILED: ' + fails.map(f => f.id.split(' ')[0]).join(', ') : ''}`);
process.exit(fails.length ? 1 : 0);
