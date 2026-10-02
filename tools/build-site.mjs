// Builds dist-web/ (what Firebase Hosting serves): a copy of www/ + the Android download page.
// Same model as tsc-web: Firebase hosts ONLY the web; the APK lives in this repo's GitHub Release
// (asset "Cobral.apk", stable URL .../releases/latest/download/Cobral.apk) and the page just links to it.
// The APK file is only read here for its size / date / SHA-256 shown on the page (Firebase Hosting's free plan
// also rejects .apk files, and www/ must never contain it because Capacitor copies www/ into the APK).
// Usage: node tools/build-site.mjs [path/to/Cobral.apk]   (default: ../Cobral_v<versionName>.apk)
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = /versionName\s+"([^"]+)"/.exec(readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'))[1];
const apk = path.resolve(process.argv[2] || path.join(root, '..', `Cobral_v${version}.apk`));
if (!existsSync(apk)) { console.error(`APK not found: ${apk}`); process.exit(1); }

const out = path.join(root, 'dist-web');
rmSync(out, { recursive: true, force: true });
cpSync(path.join(root, 'www'), out, { recursive: true });
const dl = path.join(out, 'descargar');
mkdirSync(dl, { recursive: true });
cpSync(path.join(root, 'site/descargar/icon.png'), path.join(dl, 'icon.png'));

const APK_URL = 'https://github.com/theperfectory-blip/cobral-app/releases/latest/download/Cobral.apk';
const buf = readFileSync(apk);
const sha = createHash('sha256').update(buf).digest('hex');
const mb = (statSync(apk).size / 1048576).toFixed(1).replace('.', ',');
const date = new Date(statSync(apk).mtime).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
const html = readFileSync(path.join(root, 'site/descargar/index.html'), 'utf8')
  .replaceAll('__VERSION__', version).replaceAll('__APK_URL__', APK_URL)
  .replaceAll('__SIZE__', mb).replaceAll('__DATE__', date).replaceAll('__SHA__', sha);
writeFileSync(path.join(dl, 'index.html'), html);
console.log(`dist-web ready: Cobral v${version}, ${mb} MB, sha256 ${sha}`);
