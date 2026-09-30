// Sync regression on the emulator against the LOCAL Firebase emulators only (tools/emulators.sh must be running).
// Covers F1 (first login keeps pre-login sales), live remote sale, offline queue, F2 (edit during remote change),
// F5 (status after sign-out/sign-in). Wipes app data first. Never touches the real cobral-app project.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const ADB = path.join(process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
const PKG = 'cl.cobral.ventas';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, a.map(String), { encoding: 'utf8' });
const js = expr => { const out = execFileSync('node', [here('./cdp.mjs'), expr], { encoding: 'utf8' }).trim(); try { return JSON.parse(out); } catch { return out; } };
const tap = (sel, i = 0) => execFileSync('node', [here('./tap.mjs'), sel, String(i)], { encoding: 'utf8' });
const EMAIL = `regress-${Date.now()}@cobral.test`, PASS = 'emu-only-123';
const peer = (...a) => execFileSync('node', [here('./sync-peer.mjs'), a[0], EMAIL, PASS, ...a.slice(1)], { encoding: 'utf8' }).split('\n').filter(l => l && !/warning|trace-warnings/i.test(l)).join(' ');
const results = [];
const check = (id, ok, d = '') => { results.push({ id, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${d ? '  — ' + d : ''}`); };
async function step(id, fn) { try { await fn(); } catch (e) { check(id, false, 'exception: ' + String(e.message || e).split('\n')[0]); } }
async function ready() { for (let i = 0; i < 40; i++) { try { if (js("typeof state!=='undefined'&&!document.getElementById('splashScreen')") === true) return; } catch {} await sleep(1000); } throw new Error('app not ready'); }
async function until(expr, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (js(expr) === true) return true; } catch { /* WebView busy (e.g. first sync) — retry */ } await sleep(700); } return false; }

// clean state, emulator mode, seed
adb('reverse', 'tcp:9099', 'tcp:9099'); adb('reverse', 'tcp:8080', 'tcp:8080');
adb('shell', 'pm', 'clear', PKG); adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await ready();
js("localStorage.setItem('cobralEmulatorHost','127.0.0.1');1");
execFileSync('node', [here('./cdp.mjs'), '-f', here('./seed.js')], { encoding: 'utf8' }); await sleep(4000); await ready();

await step('S1', async () => {
  js("(()=>{openNewSale();addToCart(state.products.find(p=>p.name==='Saco').id);state.selectedPayment='efectivo';completeSale();return 1})()"); await sleep(1500);
  const local = js('state.sales.length');
  js('closeModal();openAccountModal();1'); await sleep(4000);
  js(`(()=>{document.getElementById('cloudEmailInput').value='${EMAIL}';document.getElementById('cloudPassInput').value='${PASS}';return 1})()`);
  tap('#cloudSignUpBtn');
  // the local Firestore emulator needs ~30–40 s for the ~390-doc first upload; status must stay 'pending' meanwhile
  await sleep(4000); const midStatus = js('state.cloudStatus');
  const ok = await until("state.cloudUser!=null&&state.cloudStatus==='synced'", 180000) && midStatus === 'pending';
  await sleep(3000);
  const cloud = peer('dump');
  check('S1 F1 sign-up uploads every local sale (incl. one made before login); status Pendiente until done', ok && cloud.includes(`sales=${local}`), `status during upload: ${midStatus} | local ${local} | cloud: ${cloud}`);
});

await step('S2', async () => {
  const n0 = js('state.sales.length');
  peer('add-sale', 'Miel kilo');
  const ok = await until(`state.sales.length===${n0 + 1}`, 45000);
  check('S2 sale made on another device appears on the phone', ok, `${n0} → ${js('state.sales.length')}`);
});

await step('S3', async () => {
  js('CobralCloud._network(false);1'); await sleep(1000);
  js("(()=>{openNewSale();addToCart(state.products.find(p=>p.name==='Saco').id);state.selectedPayment='efectivo';completeSale();return 1})()"); await sleep(2500);
  const st = js('state.cloudStatus'); const before = peer('dump'); const local = js('state.sales.length');
  js('CobralCloud._network(true);1');
  const ok = await until("state.cloudStatus==='synced'", 20000); await sleep(2000);
  const after = peer('dump');
  check('S3 offline sale: status offline/pending, uploaded after reconnect', (st === 'offline' || st === 'pending') && !before.includes(`sales=${local}`) && ok && after.includes(`sales=${local}`), `status ${st} | before: ${before} | after: ${after}`);
});

await step('S4', async () => {
  const id = js("state.products.find(p=>p.name==='Miel ulmo').id");
  js(`openEditProduct(${id});1`); await sleep(800);
  peer('add-sale', 'Miel ulmo');
  await until(`state.products.find(p=>p.id===${id}).stock<${js(`state.products.find(p=>p.id===${id}).stock`)}`, 12000);
  const remoteStock = js(`state.products.find(p=>p.id===${id}).stock`);
  js("(()=>{const e=document.getElementById('inputProdSale');e.value='8500';e.dispatchEvent(new Event('input'));[...document.querySelectorAll('#modalContainer .modal-footer button')].find(b=>/Guardar/.test(b.innerText)).click();return 1})()");
  let p, cloud, conv = false;
  for (let i = 0; i < 12 && !conv; i++) { await sleep(4000); p = js(`(()=>{const p=state.products.find(x=>x.id===${id});return {price:p.salePrice,stock:p.stock}})()`); cloud = peer('stock', 'Miel ulmo'); conv = cloud.includes(`= ${p.stock}`); }
  check('S4 F2 edit during a remote change keeps the price edit and phone/cloud stock converge', p.price === 8500 && conv, `${JSON.stringify(p)} | ${cloud}`);
});

await step('S5', async () => {
  js('cloudSignOut();1'); await sleep(2500);
  js('closeModal();openAccountModal();1'); await sleep(2500);
  js(`(()=>{document.getElementById('cloudEmailInput').value='${EMAIL}';document.getElementById('cloudPassInput').value='${PASS}';return 1})()`);
  tap('#cloudSignInBtn');
  const ok = await until("state.cloudUser!=null&&state.cloudStatus==='synced'", 30000);
  check('S5 F5 sign-out + sign-in settles to "Sincronizado" (not stuck in Pendiente)', ok, js('state.cloudStatus'));
});

const fails = results.filter(r => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
