// Restores a Cobral backup (format "cobral-respaldo-1": localStorage + IndexedDB photos, made by reading a debuggable app over CDP)
// into the running, debuggable app on the connected device. DESTRUCTIVE for the target app's data, so it only runs on an
// EMULATOR (serial emulator-*) unless --allow-device is given on purpose.
// Usage: node tools/restore-backup.mjs <backup.json> --yes [--allow-device]      (use ANDROID_SERIAL when several devices are attached)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const [file, ...flags] = process.argv.slice(2);
if (!file || !flags.includes('--yes')) { console.error('usage: node tools/restore-backup.mjs <backup.json> --yes [--allow-device]'); process.exit(2); }
const ADB = path.join(process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
const serial = execFileSync(ADB, ['get-serialno'], { encoding: 'utf8' }).trim();
if (!/^emulator-/.test(serial) && !flags.includes('--allow-device')) { console.error(`target ${serial} is not an emulator — refusing (pass --allow-device only if you really mean to overwrite that device)`); process.exit(3); }

let d = JSON.parse(readFileSync(file, 'utf8')); if (typeof d === 'string') d = JSON.parse(d);
if (d.formato !== 'cobral-respaldo-1') { console.error('unknown backup format'); process.exit(4); }
const out = here('./out'); mkdirSync(out, { recursive: true });
const jsFile = path.join(out, 'restore-payload.js');
writeFileSync(jsFile, `(async()=>{
  const d=${JSON.stringify(d)};
  const db=await IDB.open();
  await new Promise((res,rej)=>{const tx=db.transaction('photos','readwrite');tx.objectStore('photos').clear();tx.oncomplete=()=>res();tx.onerror=e=>rej(e)});
  for(const [k,v] of Object.entries(d.fotos)) await IDB.save(k,v);
  Object.keys(localStorage).forEach(k=>localStorage.removeItem(k));
  for(const [k,v] of Object.entries(d.localStorage)) localStorage.setItem(k,v);
  setTimeout(()=>location.reload(),300);
  return 'restored '+Object.keys(d.fotos).length+' photos and '+Object.keys(d.localStorage).length+' localStorage keys on ${serial}';
})()`);
console.log(execFileSync('node', [here('./cdp.mjs'), '-f', jsFile], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim());
