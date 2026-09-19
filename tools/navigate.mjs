// Navigate the Cobral WebView to a URL via DevTools (browser-initiated, so Capacitor doesn't hand it
// to an external browser). Used to run the WEB build inside the emulator's WebView for testing:
//   node tools/navigate.mjs http://127.0.0.1:5173/     (needs `adb reverse tcp:5173 tcp:5173`)
// Return to the app with: adb shell am force-stop cl.cobral.ventas && adb shell am start -n cl.cobral.ventas/.MainActivity
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const pid = execFileSync(ADB, ['shell', 'pidof', 'cl.cobral.ventas'], { encoding: 'utf8' }).trim();
execFileSync(ADB, ['forward', 'tcp:9333', `localabstract:webview_devtools_remote_${pid}`]);
const page = (await (await fetch('http://127.0.0.1:9333/json')).json()).find(p => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: process.argv[2] } }));
const m = await new Promise(r => { ws.onmessage = e => { const d = JSON.parse(e.data); if (d.id === 1) r(d); }; });
console.log(JSON.stringify(m.result || m.error));
ws.close();
