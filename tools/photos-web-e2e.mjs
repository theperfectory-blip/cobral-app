// Photo sync (Cloudinary) end to end on the WEB build with TWO independent browsers (two "devices"), against the LOCAL Firebase
// emulators and tools/fake-cloudinary.mjs (never the real Cloudinary account). Start first:
//   bash tools/emulators.sh   +   node tools/fake-cloudinary.mjs   +   a static server for www/ on http://localhost:5173
// Usage: node tools/photos-web-e2e.mjs [url=http://localhost:5173/index.html]
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const URL_APP = process.argv[2] || 'http://localhost:5173/index.html';
const FAKE = 'http://localhost:9199';
const BROWSER = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EMAIL = `photos-${Date.now()}@cobral.test`, PASS = 'emu-only-123';
mkdirSync(here('./out'), { recursive: true });
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const peer = (...a) => execFileSync('node', [here('./sync-peer.mjs'), a[0], EMAIL, PASS, ...a.slice(1)], { encoding: 'utf8' }).split('\n').filter(l => l && !/warning|trace-warnings/i.test(l)).join(' ');
const fake = async (path, method = 'GET') => (await fetch(FAKE + path, { method })).text();
const stats = async () => JSON.parse(await fake('/__stats'));

async function launch(port, name) {
  const dir = here(`./out/.photos-${name}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result?.result?.value; };
  const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await js(expr)) return true; } catch { } await sleep(400); } return false; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const boot = async () => { await send('Page.navigate', { url: URL_APP }); await sleep(1500); await js("localStorage.setItem('cobralEmulatorHost','127.0.0.1');localStorage.setItem('cobralCloudinaryBase','" + FAKE + "');1"); await send('Page.navigate', { url: URL_APP }); };
  return { js, until, send, errors, boot, close: () => { try { ws.close(); } catch { } proc.kill(); } };
}

const jpeg = c => `(()=>{const k=document.createElement('canvas');k.width=40;k.height=40;const x=k.getContext('2d');x.fillStyle='${c}';x.fillRect(0,0,40,40);return k.toDataURL('image/jpeg',0.8)})()`;
const addProduct = (name, color) => `(()=>{openNewProduct();const v=(i,x)=>{const e=document.getElementById(i);e.value=x;e.dispatchEvent(new Event('input'))};v('inputProdName','${name}');v('inputProdCost','1000');v('inputProdSale','2000');v('inputProdStock','5');state.tempPhoto=${jpeg(color)};saveProduct();return 1})()`;
const editPhoto = (name, tempExpr) => `(()=>{const p=state.products.find(x=>x.name==='${name}');openEditProduct(p.id);state.tempPhoto=${tempExpr};saveProduct();return 1})()`;
const prod = n => `state.products.find(x=>x.name==='${n}')`;

let A, B;
try {
  await fake('/__reset', 'POST');
  A = await launch(9461, 'A'); await A.boot();
  check('P1 login gate on device A', await A.until("!!document.getElementById('cloudEmailInput')", 30000));
  await A.js(`(()=>{document.getElementById('cloudEmailInput').value='${EMAIL}';document.getElementById('cloudPassInput').value='${PASS}';document.getElementById('cloudSignUpBtn').click();return 1})()`);
  check('P2 sign-up → synced', await A.until("state.cloudUser&&state.cloudStatus==='synced'", 120000));

  // ---- upload of a new photo
  await A.js(addProduct('Foto Uno', '#c0392b'));
  const up = await A.until(`!!(${prod('Foto Uno')}||{}).imageUrl`, 60000);
  const st = await stats();
  check('P3 new product photo is uploaded to (fake) Cloudinary with the cobral_fotos preset; imageUrl set', up && st.uploads === 1 && st.presets[0] === 'cobral_fotos', JSON.stringify(st) + ' ' + (await A.js(`(${prod('Foto Uno')}||{}).imageUrl`)));
  await A.until("state.cloudStatus==='synced'", 60000); await sleep(2500);
  const cloud = peer('photos');
  check('P4 the cloud product doc carries the imageUrl (another device sees it)', /photos: 1 of/.test(cloud), cloud);
  await A.js('openAccountModal();1'); await sleep(800);
  check('P5 account modal shows "Fotos respaldadas: 1 de 1"', (await A.js("document.getElementById('accountModalBody').innerText")).includes('Fotos respaldadas: 1 de 1'));
  await A.js('closeModal();1');

  // ---- second device pulls it
  B = await launch(9462, 'B'); await B.boot();
  await B.until("!!document.getElementById('cloudEmailInput')", 30000);
  await B.js(`(()=>{document.getElementById('cloudEmailInput').value='${EMAIL}';document.getElementById('cloudPassInput').value='${PASS}';document.getElementById('cloudSignInBtn').click();return 1})()`);
  const pulled = await B.until(`(()=>{const p=${prod('Foto Uno')};return !!(p&&state.photoCache[String(p.id)])})()`, 120000);
  const same = await B.js(`(()=>{const p=${prod('Foto Uno')};return state.photoCache[String(p.id)]===${JSON.stringify('')}||state.photoCache[String(p.id)].slice(0,23)})()`);
  const aData = await A.js(`state.photoCache[String(${prod('Foto Uno')}.id)]`);
  const bData = await B.js(`state.photoCache[String(${prod('Foto Uno')}.id)]`);
  check('P6 device B (fresh, no photos) downloads the photo; bytes identical to A', pulled && aData === bData, `B has ${bData ? bData.length : 0} chars, A ${aData.length}`);
  check('P7 B persisted it in IndexedDB (survives reload)', await B.js(`IDB.get(String(${prod('Foto Uno')}.id)).then(v=>v===${JSON.stringify(aData)})`));

  // ---- replace photo on A → B follows
  await A.js(editPhoto('Foto Uno', jpeg('#2980b9')));
  const oldUrl = await A.js(`(${prod('Foto Uno')}).imageUrl`);
  const newUrl = await A.until(`(${prod('Foto Uno')}).imageUrl&&(${prod('Foto Uno')}).imageUrl!==${JSON.stringify(oldUrl)}`, 60000);
  const aNew = await A.js(`state.photoCache[String(${prod('Foto Uno')}.id)]`);
  const bFollows = await B.until(`state.photoCache[String(${prod('Foto Uno')}.id)]===${JSON.stringify(aNew)}`, 90000);
  check('P8 replacing the photo on A uploads a new one and B switches to it', newUrl && aNew !== aData && bFollows, `${(await stats()).uploads} uploads`);

  // ---- delete photo on A → B drops it
  await A.js(editPhoto('Foto Uno', "'__deleted__'"));
  const bDropped = await B.until(`(()=>{const p=${prod('Foto Uno')};return p&&p.imageUrl===''&&!state.photoCache[String(p.id)]})()`, 90000);
  check('P9 deleting the photo on A removes it on B (imageUrl "" propagates)', bDropped && !(await A.js(`!!state.photoCache[String(${prod('Foto Uno')}.id)]`)), peer('photos'));

  // ---- Cloudinary rejects (preset missing): photos stay local, no crash, then recovers after a reload
  await fake('/__mode/nopreset', 'POST');
  await A.js(addProduct('Foto Dos', '#27ae60'));
  const off = await A.until('state.photoSyncOff===true', 30000);
  const kept = await A.js(`!!state.photoCache[String(${prod('Foto Dos')}.id)]&&!(${prod('Foto Dos')}).imageUrl`);
  await A.js('openAccountModal();1'); await sleep(600);
  const note = await A.js("document.getElementById('accountModalBody').innerText");
  check('P10 preset missing: uploads switch off for the session, photo kept locally, account says unavailable', off && kept && /no disponible/.test(note), note.replace(/\n/g, ' | ').slice(0, 120));
  await A.js('closeModal();1');
  await fake('/__mode/ok', 'POST');
  await A.boot();
  const recovered = await A.until(`!!(${prod('Foto Dos')}||{}).imageUrl`, 120000);
  check('P11 after the service is back (app reload) the pending photo uploads', recovered);

  // ---- offline: photo saved offline uploads when the connection returns
  const before = (await stats()).uploads;
  await A.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await A.js(addProduct('Foto Tres', '#8e44ad')); await sleep(5000);
  const idle = (await stats()).uploads === before && !(await A.js(`(${prod('Foto Tres')}).imageUrl`));
  await A.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await A.js("window.dispatchEvent(new Event('online'));1");
  const sent = await A.until(`!!(${prod('Foto Tres')}||{}).imageUrl`, 90000);
  check('P12 offline: photo works locally, no upload; uploads once back online', idle && sent, `${(await stats()).uploads - before} new upload(s)`);

  check('P13 no uncaught JS errors on either device', A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].slice(0, 2).join(' | '));
} catch (e) { check('photos e2e crashed', false, (e.stack || e.message).split('\n').slice(0, 3).join(' / ')); }
A && A.close(); B && B.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
