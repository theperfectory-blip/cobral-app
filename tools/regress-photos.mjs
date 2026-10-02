// Photo sync (Cloudinary) regression on the Android emulator, against the LOCAL Firebase emulators and tools/fake-cloudinary.mjs.
// Needs running: bash tools/emulators.sh, node tools/fake-cloudinary.mjs, the Android emulator with the debug APK installed.
// Mimics a v5.5 user upgrading: the phone already holds photos (IndexedDB), then signs up → they must be backed up.
// Wipes app data first. Never touches the real cobral-app project or the real Cloudinary account.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const ADB = path.join(process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
const PKG = 'cl.cobral.ventas';
const FAKE = 'http://127.0.0.1:9199';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, a.map(String), { encoding: 'utf8' });
const js = expr => { const out = execFileSync('node', [here('./cdp.mjs'), expr], { encoding: 'utf8' }).trim(); try { return JSON.parse(out); } catch { return out; } };
const tap = (sel, i = 0) => execFileSync('node', [here('./tap.mjs'), sel, String(i)], { encoding: 'utf8' });
const EMAIL = `photos-${Date.now()}@cobral.test`, PASS = 'emu-only-123';
const peer = (...a) => execFileSync('node', [here('./sync-peer.mjs'), a[0], EMAIL, PASS, ...a.slice(1)], { encoding: 'utf8' }).split('\n').filter(l => l && !/warning|trace-warnings/i.test(l)).join(' ');
const stats = async () => (await (await fetch(FAKE + '/__stats')).json());
const results = [];
const check = (id, ok, d = '') => { results.push({ id, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${d ? '  — ' + d : ''}`); };
async function step(id, fn) { try { await fn(); } catch (e) { check(id, false, 'exception: ' + String(e.message || e).split('\n')[0]); } }
async function ready() { for (let i = 0; i < 40; i++) { try { if (js("typeof state!=='undefined'&&!document.getElementById('splashScreen')") === true) return; } catch {} await sleep(1000); } throw new Error('app not ready'); }
async function until(expr, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (js(expr) === true) return true; } catch { } await sleep(700); } return false; }

await fetch(FAKE + '/__reset', { method: 'POST' });
adb('reverse', 'tcp:9099', 'tcp:9099'); adb('reverse', 'tcp:8080', 'tcp:8080'); adb('reverse', 'tcp:9199', 'tcp:9199');
adb('shell', 'pm', 'clear', PKG); adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await ready();
js(`localStorage.setItem('cobralEmulatorHost','127.0.0.1');localStorage.setItem('cobralCloudinaryBase','${FAKE}');1`);
execFileSync('node', [here('./cdp.mjs'), '-f', here('./seed.js')], { encoding: 'utf8' }); await sleep(4000); await ready();

const WITH = ['Miel kilo', 'Miel ulmo', 'Carro chico', 'Bolsa karro grande', 'Silabario'];
const WITHOUT = 'Saco';
const colors = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#f39c12'];
// photos that exist on the phone BEFORE any account (what a v5.5 install has)
js(`(()=>{const names=${JSON.stringify(WITH)},cols=${JSON.stringify(colors)};names.forEach((n,i)=>{const p=state.products.find(x=>x.name===n);const k=document.createElement('canvas');k.width=40;k.height=40;const x=k.getContext('2d');x.fillStyle=cols[i];x.fillRect(0,0,40,40);const d=k.toDataURL('image/jpeg',0.8);state.photoCache[String(p.id)]=d;IDB.save(String(p.id),d)});return 1})()`);
await sleep(1500);

await step('R1', async () => {
  const photosBefore = js(`state.products.filter(p=>state.photoCache[String(p.id)]).length`);
  js('closeModal();openAccountModal();1'); if (!await until("!!document.getElementById('cloudEmailInput')", 30000)) throw new Error('account form did not appear');
  js(`(()=>{document.getElementById('cloudEmailInput').value='${EMAIL}';document.getElementById('cloudPassInput').value='${PASS}';return 1})()`);
  tap('#cloudSignUpBtn');
  const synced = await until("state.cloudUser!=null&&state.cloudStatus==='synced'", 300000);
  const uploaded = await until(`state.products.filter(p=>p.imageUrl).length===${WITH.length}`, 120000);
  const st = await stats();
  await until("state.cloudStatus==='synced'", 300000); await sleep(3000);
  const cloud = peer('photos');
  check('R1 existing phone photos are backed up on sign-up (v5.5 upgrade): uploaded, imageUrl set, in the cloud', synced && uploaded && st.uploads === WITH.length && photosBefore === WITH.length && /photos: 5 of/.test(cloud), `uploads ${st.uploads} | ${cloud}`);
});

await step('R2', async () => {
  const url = js(`state.products.find(p=>p.name==='${WITH[0]}').imageUrl`);
  peer('set-photo', WITHOUT, url);
  const ok = await until(`(()=>{const p=state.products.find(x=>x.name==='${WITHOUT}');return !!(p&&p.imageUrl&&state.photoCache[String(p.id)])})()`, 90000);
  check('R2 a photo set on another device is downloaded by the phone', ok, url);
});

await step('R3', async () => {
  peer('set-photo', WITH[2], '');
  const ok = await until(`(()=>{const p=state.products.find(x=>x.name==='${WITH[2]}');return p&&p.imageUrl===''&&!state.photoCache[String(p.id)]})()`, 90000);
  const inIdb = js(`IDB.get(String(state.products.find(x=>x.name==='${WITH[2]}').id)).then(v=>v===null)`);
  check('R3 a photo deleted on another device is removed from the phone (cache + IndexedDB)', ok, `idb cleared: ${inIdb}`);
});

await step('R4', async () => {
  const id = js(`state.products.find(p=>p.name==='${WITH[4]}').id`);
  const before = (await stats()).uploads;
  js(`openEditProduct(${id});1`); await sleep(800);
  js(`(()=>{const k=document.createElement('canvas');k.width=40;k.height=40;const x=k.getContext('2d');x.fillStyle='#16a085';x.fillRect(0,0,40,40);state.tempPhoto=k.toDataURL('image/jpeg',0.8);[...document.querySelectorAll('#modalContainer .modal-footer button')].find(b=>/Guardar/.test(b.innerText)).click();return 1})()`);
  const oldUrl = (js(`state.products.find(p=>p.id===${id}).imageUrl`));
  const ok = await until(`(()=>{const p=state.products.find(x=>x.id===${id});return !!p.imageUrl&&p.imageUrl!==${JSON.stringify(oldUrl)}})()`, 60000);
  await until("state.cloudStatus==='synced'", 120000); await sleep(2500);
  check('R4 editing a product photo through the real "Guardar" button uploads the new photo', ok && (await stats()).uploads === before + 1, `${(await stats()).uploads - before} new upload(s)`);
});

const fails = results.filter(r => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} passed`);
process.exit(fails.length ? 1 : 0);
