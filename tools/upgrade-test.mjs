// Upgrade safety test (emulator only, never the phone): install an OLD APK, fill it with realistic data + photos, install the
// NEW APK over it with `adb install -r` (what the phone does), and verify nothing was lost. Also proves the safety net:
// an APK signed with a DIFFERENT key is refused by Android and leaves the data untouched.
// Usage: node tools/upgrade-test.mjs <old.apk> <new.apk>        e.g. ../Cobral_v5.6.apk ../Cobral_v6.2.apk
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const [OLD, NEW] = process.argv.slice(2).map(p => path.resolve(p));
if (!OLD || !NEW || !existsSync(OLD) || !existsSync(NEW)) { console.error('usage: node tools/upgrade-test.mjs <old.apk> <new.apk>'); process.exit(2); }
const SDK = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
const PKG = 'cl.cobral.ventas';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => { try { return { ok: true, out: execFileSync(cmd, args.map(String), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message) }; } };
const adb = (...a) => run(ADB, a);
const js = expr => { const r = run('node', [here('./cdp.mjs'), expr]); const out = r.out.trim(); try { return JSON.parse(out); } catch { return out; } };
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const jsJson = expr => { let v = js(expr); if (typeof v === 'string') { try { v = JSON.parse(v); } catch { } } if (typeof v === 'string') { try { v = JSON.parse(v); } catch { } } return v; };
async function ready() { for (let i = 0; i < 60; i++) { if (js("typeof state!=='undefined'&&!document.getElementById('splashScreen')") === true) return true; await sleep(1000); } return false; }

// Everything that matters to the user, in a form that can be compared before/after (photos compared byte for byte).
const SNAP = `(async()=>{
  const all=await IDB.getAll();
  const slim=a=>a.map(x=>JSON.stringify(x, Object.keys(x).sort()));
  const prods=state.products.map(p=>[p.id,p.name,p.costPrice,p.salePrice,p.stock,p.unit,p.category,JSON.stringify(p.offers||null),JSON.stringify(p.locationPrices||null)].join('|'));
  const sales=state.sales.map(s=>[s.id,s.numVenta,s.finalAmount,s.date,s.paymentMethod,s.location,s.items.map(i=>i.productId+'x'+i.qty+'@'+i.price).join(',')].join('|'));
  const debts=state.debts.map(d=>[d.id,d.name,d.total,d.remaining].join('|'));
  const hist=state.debtHistory.map(d=>[d.id,d.name,d.paidAmount||d.total].join('|'));
  const h=s=>{let x=5381;for(let i=0;i<s.length;i++)x=((x<<5)+x+s.charCodeAt(i))|0;return (x>>>0).toString(16)};
  const photoKeys=Object.keys(all).filter(k=>k!=='user').sort();
  const rev=state.sales.reduce((t,s)=>t+s.finalAmount,0);
  return JSON.stringify({
    counts:{sales:state.sales.length,products:state.products.length,debts:state.debts.length,debtHistory:state.debtHistory.length,photos:photoKeys.length},
    revenue:rev,
    hashes:{products:h(prods.join('\\n')),sales:h(sales.join('\\n')),debts:h(debts.join('\\n')),hist:h(hist.join('\\n')),photos:h(photoKeys.map(k=>k+':'+all[k]).join('\\n'))},
    settings:{userName:state.userName,debitFee:state.debitFee,creditFee:state.creditFee,dark:state.darkMode,categories:state.categories.join(','),locations:JSON.stringify(state.locations)}
  });
})()`;

console.log(`old: ${path.basename(OLD)}   new: ${path.basename(NEW)}`);
adb('uninstall', PKG);                                                   // emulator only: clean slate
const inst = adb('install', OLD); check('U1 old APK installs on a clean emulator', inst.ok && /Success/.test(inst.out));
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); check('U2 old app starts', await ready());

// realistic data: 296 sales / ~92 products from the seed, a debt, custom settings, photos on 6 products (IndexedDB, like the phone)
run('node', [here('./cdp.mjs'), '-f', here('./seed.js')]); await sleep(4000); await ready();
js(`(()=>{
  state.userName='Jimbo';state.debitFee=1.45;state.creditFee=2.7;state.darkMode=true;
  state.debts.push({id:Date.now(),name:'Don Pedro',items:[{productId:state.products[0].id,name:state.products[0].name,price:1000,costPrice:400,qty:2,unit:'u'}],total:2000,totalCost:800,remaining:1200,date:new Date().toISOString(),location:'Metro'});
  const cols=['#c0392b','#2980b9','#27ae60','#8e44ad','#f39c12','#16a085'];
  state.products.slice(0,6).forEach((p,i)=>{const k=document.createElement('canvas');k.width=64;k.height=64;const x=k.getContext('2d');x.fillStyle=cols[i];x.fillRect(0,0,64,64);x.fillStyle='#fff';x.fillRect(8+i*4,8,20,20);const d=k.toDataURL('image/jpeg',0.8);state.photoCache[String(p.id)]=d;IDB.save(String(p.id),d)});
  saveData();return 1})()`);
await sleep(2500);
const before = jsJson(`(async()=>await ${SNAP})()`);
const withData = before.counts.sales > 200 && before.counts.products > 50 && before.counts.photos === 6 && before.counts.debts >= 1;
check('U3 old app filled with data (sales, inventory, debt, settings, 6 photos)', withData, JSON.stringify(before.counts) + ' revenue ' + before.revenue);

// ---- safety net: an APK signed with ANOTHER key must be refused and must not touch the data
const tmp = path.join(path.dirname(here('./out/x')), '.upgrade'); mkdirSync(tmp, { recursive: true });
const env = { ...process.env, JAVA_HOME: 'C:/Users/Administrator/jdk-temurin-21/jdk-21.0.11+10', JAVA_TOOL_OPTIONS: '-Djdk.net.unixdomain.tmpdir=C:/cobral-no-uds' };
const keytool = path.join(env.JAVA_HOME, 'bin', 'keytool.exe');
const ks = path.join(tmp, 'other.keystore');
run(keytool, ['-genkeypair', '-keystore', ks, '-storepass', 'otherpass', '-keypass', 'otherpass', '-alias', 'other', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '30', '-dname', 'CN=Other Key'], { env });
const bt = path.join(SDK, 'build-tools'); const ver = execFileSync('cmd', ['/c', 'dir', '/b', bt], { encoding: 'utf8' }).trim().split(/\r?\n/).sort().pop();
const resigned = path.join(tmp, 'other-signed.apk');
const sign = run('cmd', ['/c', path.join(bt, ver, 'apksigner.bat'), 'sign', '--ks', ks, '--ks-pass', 'pass:otherpass', '--key-pass', 'pass:otherpass', '--out', resigned, NEW], { env });
const bad = adb('install', '-r', resigned);
check('U4 safety net: an APK signed with a different key is REFUSED by Android (update-incompatible)', sign.ok && !bad.ok && /INCOMPATIBLE|signatures do not match|UPDATE_INCOMPATIBLE/i.test(bad.out), bad.out.trim().split('\n').pop().slice(0, 140));
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await ready();
const afterBad = jsJson(`(async()=>await ${SNAP})()`);
check('U5 …and the refused install left every datum untouched (data, photos, settings)', JSON.stringify(afterBad) === JSON.stringify(before));

// ---- the real upgrade: new APK, same signature, installed OVER the old one (no uninstall)
adb('shell', 'am', 'force-stop', PKG);
const up = adb('install', '-r', NEW);
check('U6 new APK installs OVER the old one with `install -r` (same signature, higher version)', up.ok && /Success/.test(up.out), up.out.trim().split('\n').pop());
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); check('U7 upgraded app starts', await ready());
await sleep(3000);
const after = jsJson(`(async()=>await ${SNAP})()`);
check('U8 sales, inventory, debts and debt history identical (field by field hashes)', ['products', 'sales', 'debts', 'hist'].every(k => before.hashes[k] === after.hashes[k]) && JSON.stringify(before.counts) === JSON.stringify(after.counts), JSON.stringify(after.counts));
check('U9 every photo identical byte for byte', before.hashes.photos === after.hashes.photos && after.counts.photos === 6);
check('U10 settings kept (name, card fees, dark mode, categories, locations)', JSON.stringify(before.settings) === JSON.stringify(after.settings), JSON.stringify(after.settings).slice(0, 110));
check('U11 statistics unchanged (revenue total and a monthly Top ranking)', after.revenue === before.revenue);
const shown = js(`(()=>{state.currentTab='inventory';render();const imgs=[...document.querySelectorAll('#inventoryList img, .product-image img')].filter(i=>i.src.startsWith('data:')).length;return imgs})()`);
check('U12 photos actually render in the inventory screen after the upgrade', Number(shown) >= 1, `${shown} photo(s) visible`);
const ver2 = js('document.title'); check('U13 the app now is the new version', /6\./.test(String(ver2)), String(ver2));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
