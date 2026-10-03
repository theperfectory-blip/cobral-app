// In-app updater test on the EMULATOR (never the phone): an "older" build (<old.apk>, e.g. versionCode 61) with data + photos is told
// by a fake update.json that a newer version exists; the test drives the real flow (dialog → install permission → download from
// the real GitHub release asset → SHA-256 check → Android installer UI → new version) and verifies data survived.
// Needs: the Android emulator, node tools/fake-cloudinary.mjs (serves /update.json). Usage:
//   node tools/updater-test.mjs <old.apk> <targetVersionCode> <targetVersionName> <githubApkUrl> <sha256>
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const [OLD, TCODE, TNAME, TURL, TSHA] = process.argv.slice(2);
if (!OLD || !TCODE || !TURL || !TSHA) { console.error('usage: node tools/updater-test.mjs <old.apk> <code> <name> <githubApkUrl> <sha256>'); process.exit(2); }
const ADB = path.join(process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
const PKG = 'cl.cobral.ventas';
const FAKE = 'http://127.0.0.1:9199';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args) => { try { return { ok: true, out: execFileSync(cmd, args.map(String), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message) }; } };
const adb = (...a) => run(ADB, a);
const serial = adb('get-serialno').out.trim();
if (!/^emulator-/.test(serial)) { console.error(`target ${serial} is not an emulator — refusing (set ANDROID_SERIAL=emulator-5554)`); process.exit(3); }
const js = expr => { const r = run('node', [here('./cdp.mjs'), expr]); const o = r.out.trim(); try { return JSON.parse(o); } catch { return o; } };
const jsJson = e => { let v = js(e); if (typeof v === 'string') { try { v = JSON.parse(v); } catch { } } return v; };
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
async function ready() { for (let i = 0; i < 60; i++) { if (js("typeof state!=='undefined'&&!document.getElementById('splashScreen')") === true) return true; await sleep(1000); } return false; }
const setManifest = async m => { await fetch(FAKE + '/__manifest', { method: 'POST', body: typeof m === 'string' ? m : JSON.stringify(m) }); };
const versionCode = () => (/versionCode=(\d+)/.exec(adb('shell', 'dumpsys', 'package', PKG).out) || [])[1];
mkdirSync(here('./out'), { recursive: true });
function screenshot(name) { try { execFileSync('cmd', ['/c', `"${ADB}" exec-out screencap -p > "${here('./out/' + name + '.png')}"`], { stdio: 'ignore' }); } catch { } }

// UI automation of the system package installer
function uiTap(labels) {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml'); const x = adb('exec-out', 'cat', '/sdcard/ui.xml').out;
  if (!/package="com\.google\.android\.(packageinstaller|permissioncontroller|vending)"/.test(x)) return null;   // only tap inside the system installer, never in Cobral's own dialog (its button is also called "Actualizar")
  for (const label of labels) {
    const m = new RegExp(`<node[^>]*text="${label}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i').exec(x) || new RegExp(`<node[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*text="${label}"`, 'i').exec(x);
    if (m) { adb('shell', 'input', 'tap', Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2)); return label; }
  }
  return null;
}

// Google Play Protect ("App scan recommended"): the "Install without scanning" link sits inside a paragraph, so it is not a
// separate accessibility node → tap by position (emulator screen is 1080x2400): expand "More details", then the link.
let ppHandled = 0;
function playProtect() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml'); const x = adb('exec-out', 'cat', '/sdcard/ui.xml').out;
  if (!/App scan recommended/.test(x) || ppHandled >= 2) return false;
  ppHandled++; adb('shell', 'input', 'tap', 504, 1380); return true;
}
function playProtectLink() { adb('shell', 'input', 'tap', 539, 1459); }
console.log(`target ${serial}; old build: ${path.basename(OLD)}; manifest → ${TNAME} (${TCODE})`);
adb('reverse', 'tcp:9199', 'tcp:9199');
const resetInstaller = () => { adb('shell', 'am', 'force-stop', 'com.google.android.packageinstaller'); adb('shell', 'am', 'force-stop', 'com.android.vending'); };   // drop stale installer / Play Protect dialogs from earlier runs
resetInstaller();
adb('uninstall', PKG);
check('A1 old build installs', adb('install', OLD).ok);
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); check('A2 old build starts', await ready());
const oldCode = versionCode();
run('node', [here('./cdp.mjs'), '-f', here('./seed.js')]); await sleep(4000); await ready();
js(`(()=>{const cols=['#c0392b','#2980b9','#27ae60'];state.products.slice(0,3).forEach((p,i)=>{const k=document.createElement('canvas');k.width=40;k.height=40;const x=k.getContext('2d');x.fillStyle=cols[i];x.fillRect(0,0,40,40);const d=k.toDataURL('image/jpeg',0.8);state.photoCache[String(p.id)]=d;IDB.save(String(p.id),d)});saveData();return 1})()`);
await sleep(1500);
const SNAP = `(async()=>{const all=await IDB.getAll();return JSON.stringify({sales:state.sales.length,products:state.products.length,photos:Object.keys(all).length,rev:state.sales.reduce((t,s)=>t+s.finalAmount,0)})})()`;
const before = jsJson(SNAP); check('A3 data seeded (sales, products, 3 photos)', before.sales > 200 && before.photos === 3, JSON.stringify(before));

// ---- manifest handling
await setManifest(''); let r = jsJson(`updaterCheck('${FAKE}/update.json')`);
check('B1 manifest missing (404) → "could not check", no crash', r.ok === false && r.reason === 'red' && r.status === 404, JSON.stringify(r));
await setManifest({ versionCode: Number(oldCode), versionName: 'same', apkUrl: TURL }); r = jsJson(`updaterCheck('${FAKE}/update.json')`);
check('B2 same version → no update offered', r.ok === true && r.hasUpdate === false && r.currentCode === Number(oldCode), JSON.stringify(r).slice(0, 120));
await setManifest('{not json'); r = jsJson(`updaterCheck('${FAKE}/update.json')`);
check('B3 corrupt manifest → handled', r.ok === false && r.reason === 'manifiesto', JSON.stringify(r));
await setManifest({ versionCode: 10, versionName: 'older', apkUrl: TURL }); r = jsJson(`updaterCheck('${FAKE}/update.json')`);
check('B4 older version in the manifest is never offered (compares versionCode as numbers)', r.ok === true && r.hasUpdate === false);

// ---- security of the native side
const rej = u => js(`Capacitor.Plugins.AppUpdater.downloadAndInstall({url:${JSON.stringify(u)}}).then(()=>'ACCEPTED',e=>'REJECTED: '+e.message)`);
check('C1 plugin refuses a non-GitHub URL', /REJECTED.*URL no permitida/.test(rej('https://example.com/evil.apk')), rej('https://example.com/evil.apk'));
check('C2 plugin refuses http:// even on github.com', /REJECTED.*URL no permitida/.test(rej('http://github.com/x/y/releases/download/v1/a.apk')));

// ---- dialog + permission
const notes = 'Novedades <b>de prueba</b>\n- punto uno';
await setManifest({ versionCode: Number(TCODE), versionName: TNAME, apkUrl: TURL, sha256: TSHA, notes });
js("localStorage.removeItem('cobralUpdateLast');localStorage.removeItem('cobralUpdateDismissed');1");
js(`(()=>{window.__orig=UPDATE_MANIFEST_URL;return 1})()`);
// updaterAuto() uses the real manifest URL; for the test, call the manual path with the fake URL through openUpdateModal
const u = jsJson(`updaterCheck('${FAKE}/update.json').then(u=>{openUpdateModal(u);return JSON.stringify(u)})`);
await sleep(800); screenshot('updater-dialog');
const dlg = jsJson(`JSON.stringify({title:document.querySelector('#modalContainer .modal-title')&&document.querySelector('#modalContainer .modal-title').innerText,hasB:!!document.querySelector('#modalContainer b'),text:document.querySelector('#modalContainer .modal-body').innerText})`);
check('D1 update dialog shows new/current version and notes; HTML in notes is escaped', u.hasUpdate === true && /Nueva versión/.test(dlg.title) && dlg.hasB === false && /Novedades <b>de prueba<\/b>/.test(dlg.text) && /conservan/.test(dlg.text), dlg.text.replace(/\n/g, ' | ').slice(0, 130));
js("document.getElementById('updateLaterBtn').click()");
check('D2 "Más tarde" closes the dialog and remembers it for 24 h', js("!document.querySelector('#modalContainer .modal-overlay')") === true && js("updaterDismissedRecently(" + TCODE + ")") === true);
js("openSettings();1"); await sleep(500);
check('D3 Configuración shows "Buscar actualización" with the version', /Buscar actualización/.test(js("document.getElementById('modalContainer').innerText")));
js('closeModal();1');
js(`(()=>{updaterCheck('${FAKE}/update.json').then(u=>openUpdateModal(u));return 1})()`); await sleep(1500);
adb('shell', 'appops', 'set', PKG, 'REQUEST_INSTALL_PACKAGES', 'deny');
js('installUpdate();1'); await sleep(2500);
const top = adb('shell', 'dumpsys', 'activity', 'activities').out;
check('E1 without "install unknown apps" permission the app sends the user to Android settings (and asks to come back)', /ManageAppExternalSources|AppInfo|manage.*unknown|InstallUnknown|ManageUnknown/i.test(top) || /permiso/.test(js("document.getElementById('updateMsg')?document.getElementById('updateMsg').innerText:''")), (top.match(/ManageAppExternalSources|InstallUnknown\w*|ManageUnknown\w*/) || ['(settings activity not matched)'])[0]);
adb('shell', 'input', 'keyevent', '4'); await sleep(1000); adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await sleep(2000); await ready();
adb('shell', 'appops', 'set', PKG, 'REQUEST_INSTALL_PACKAGES', 'allow');

// ---- wrong SHA-256 → refused, nothing installed
await setManifest({ versionCode: Number(TCODE), versionName: TNAME, apkUrl: TURL, sha256: '0'.repeat(64), notes });
js(`(()=>{updaterCheck('${FAKE}/update.json').then(u=>openUpdateModal(u));return 1})()`); await sleep(1500);
js('installUpdate();1');
let msg = ''; for (let i = 0; i < 60; i++) { await sleep(2000); msg = js("document.getElementById('updateMsg')?document.getElementById('updateMsg').innerText:''"); if (/No se pudo actualizar/.test(msg)) break; }
check('F1 wrong SHA-256 → "no coincide", nothing installed, version unchanged', /no coincide/.test(msg) && versionCode() === oldCode, msg.slice(0, 120));

// ---- the real update
await setManifest({ versionCode: Number(TCODE), versionName: TNAME, apkUrl: TURL, sha256: TSHA, notes });
js(`(()=>{updaterCheck('${FAKE}/update.json').then(u=>openUpdateModal(u));return 1})()`); await sleep(1500);
resetInstaller(); js('installUpdate();1'); await sleep(2500); screenshot('updater-downloading');
let tapped = null;
for (let i = 0; i < 45 && !tapped; i++) { await sleep(2000); tapped = uiTap(['Install', 'Update', 'Instalar', 'Actualizar', 'INSTALL', 'UPDATE']); }
check('G1 download from GitHub verified (SHA-256) and the Android installer opened', !!tapped, 'tapped "' + tapped + '"');
let newCode = oldCode; for (let i = 0; i < 40 && newCode === oldCode; i++) { await sleep(2000); newCode = versionCode(); if (newCode === oldCode) { if (playProtect()) { await sleep(1500); playProtectLink(); } else uiTap(['Install anyway', 'Instalar de todos modos']); } }
check(`G2 app updated by the updater: versionCode ${oldCode} → ${newCode}`, newCode === TCODE, `target ${TCODE}`);
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); const up = await ready();
const after = up ? jsJson(SNAP) : {};
check('G3 after the in-app update every sale, product and photo is still there', up && JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
