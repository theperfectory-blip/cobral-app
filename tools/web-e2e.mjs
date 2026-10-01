// End-to-end check of the WEB build in desktop layout against the LOCAL Firebase emulators (tools/emulators.sh):
// headless Edge at 1440 px → real sign-up of a throwaway @cobral.test account on the Auth emulator → create a product
// and a sale through the desktop UI → a second "device" (tools/sync-peer.mjs) sees them and sells one more → the web
// table updates live. Never talks to the real project (the app only honours cobralEmulatorHost on localhost).
// Usage: node tools/web-e2e.mjs [url=http://localhost:5173/index.html]
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const url = process.argv[2] || 'http://localhost:5173/index.html';
const BROWSER = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
const PORT = 9445, sleep = ms => new Promise(r => setTimeout(r, ms));
const EMAIL = `web-${Date.now()}@cobral.test`, PASS = 'emu-only-123';
mkdirSync(here('./out'), { recursive: true });
const userDir = here('./out/.web-e2e-profile');
if (existsSync(userDir)) rmSync(userDir, { recursive: true, force: true });

const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result?.result?.value; };
const until = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await js(expr)) return true; } catch { } await sleep(500); } return false; };
const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(here(`./out/web-e2e-${name}.png`), Buffer.from(s.result.data, 'base64')); };
const peer = (...a) => execFileSync('node', [here('./sync-peer.mjs'), a[0], EMAIL, PASS, ...a.slice(1)], { encoding: 'utf8' }).split('\n').filter(l => l && !/warning|trace-warnings/i.test(l)).join(' ');
const results = []; const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url }); await sleep(1500);
  await js("localStorage.clear();localStorage.setItem('cobralEmulatorHost','127.0.0.1');indexedDB.deleteDatabase&&1");
  await send('Page.navigate', { url });
  check('W1 login gate shown (desktop, signed out)', await until("!!document.getElementById('cloudEmailInput')", 30000));
  await js(`(()=>{document.getElementById('cloudEmailInput').value='${EMAIL}';document.getElementById('cloudPassInput').value='${PASS}';document.getElementById('cloudSignUpBtn').click();return 1})()`);
  const signed = await until("state.cloudUser!=null&&state.cloudStatus==='synced'&&document.body.classList.contains('desk')", 120000);
  check('W2 real sign-up on the Auth emulator → desktop layout, Sincronizado', signed, await js("state.cloudStatus+' desk='+document.body.classList.contains('desk')"));

  await js("(()=>{openNewProduct();const v=(i,x)=>{const e=document.getElementById(i);e.value=x;e.dispatchEvent(new Event('input'));};v('inputProdName','Miel Web');v('inputProdCost','4000');v('inputProdSale','7000');v('inputProdStock','10');saveProduct();return 1})()");
  await sleep(500);
  await js("(()=>{const p=state.products.find(x=>x.name==='Miel Web');openNewSale();addToCart(p.id);addToCart(p.id);deskSelectPayment('efectivo');deskSaleConfirm();return 1})()");
  const local = await js("(()=>{const p=state.products.find(x=>x.name==='Miel Web');return {stock:p&&p.stock,sales:state.sales.length,open:!!document.getElementById('deskSale')}})()");
  check('W3 product + desktop two-pane sale saved locally', local.stock === 8 && local.sales === 1 && !local.open, JSON.stringify(local));
  await until("state.cloudStatus==='synced'", 120000); await sleep(3000);
  const dump = peer('stock', 'Miel Web');
  check('W4 another device sees the web product with stock 8', dump.includes('= 8 price=7000'), dump);

  await js("state.currentTab='sales';state.filterPeriod='day';goToCurrentPeriod('sales');1");
  const added = peer('add-sale', 'Miel Web');
  const live = await until("state.sales.length===2&&document.querySelectorAll('#deskSalesTable tbody tr').length===2&&state.products.find(x=>x.name==='Miel Web').stock===7", 120000);
  check('W5 sale from the other device appears live in the desktop table; stock 7', live, added);
  await shot('ventas');
  await js("CobralCloud._network(false).then(()=>{const p=state.products.find(x=>x.name==='Miel Web');p.salePrice=7100;saveData();return 1})");
  const off = await until("/Sin conexión|Pendiente/.test(document.getElementById('deskSidebar').innerText)", 20000);
  await js("CobralCloud._network(true).then(()=>1)");
  const back = await until("state.cloudStatus==='synced'&&/Sincronizado/.test(document.getElementById('deskSidebar').innerText)", 120000);
  check('W7 sidebar shows the real sync status (offline edit → Sin conexión/Pendiente → Sincronizado)', off && back, await js("document.getElementById('deskCloudStatus').innerText"));
  check('W6 no uncaught JS errors in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
  await js("cloudSignOut&&cloudSignOut();1"); await sleep(1500);
} catch (e) { check('web e2e crashed', false, e.message.split('\n')[0]); }
ws.close(); proc.kill();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
