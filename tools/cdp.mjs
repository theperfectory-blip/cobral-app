// Evaluate JavaScript inside the Cobral WebView running on the emulator/device.
// Usage:
//   node tools/cdp.mjs "state.sales.length"
//   node tools/cdp.mjs -f tools/seed.js
// Requires a debug APK (WebView debugging on) and the app in the foreground.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ADB = path.join(process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
const PKG = 'cl.cobral.ventas';
const PORT = 9333;

const args = process.argv.slice(2);
const expr = args[0] === '-f' ? readFileSync(args[1], 'utf8') : args.join(' ');
if (!expr) { console.error('usage: node tools/cdp.mjs "<expression>" | -f file.js'); process.exit(2); }

const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8' }).trim();
const pid = adb('shell', 'pidof', PKG);
if (!pid) { console.error(`${PKG} is not running`); process.exit(1); }
adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);

const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = pages.find(p => p.type === 'page') || pages[0];
if (!page) { console.error('no debuggable page found'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.send(JSON.stringify({
  id: 1, method: 'Runtime.evaluate',
  params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true },
}));
const msg = await new Promise(res => { ws.onmessage = e => { const d = JSON.parse(e.data); if (d.id === 1) res(d); }; });
ws.close();

const r = msg.result || {};
if (r.exceptionDetails) {
  console.error('EXCEPTION: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  process.exit(1);
}
const v = r.result?.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
