// Headless desktop screenshots of the WEB build (for the desktop design review), independent of any visible window.
// Usage: node tools/deskshot.mjs <url> <outPrefix> [widths=1280,1440,1920] [steps.js]
//   - loads <url>, injects tools/web-inspect.js (seed data + inspection-only signed-in state, cloud writes stubbed),
//   - then for each width and each step in the steps file (array of {name, js}) runs the JS and saves
//     tools/out/<outPrefix>-<width>-<name>.png. Default step: the current page.
// Never signs in: the signed-in state is synthetic, for layout inspection only.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const [url, prefix = 'desk', widthsArg = '1280,1440,1920', stepsFile] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/deskshot.mjs <url> <outPrefix> [widths] [steps.js]'); process.exit(2); }
const BROWSER = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
const PORT = 9444, sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(here('./out'), { recursive: true });

const userDir = here('./out/.deskshot-profile');
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result?.result?.value; };

const inspect = readFileSync(here('./web-inspect.js'), 'utf8');
const steps = stepsFile ? (await import(pathToFileURL(stepsFile).href)).default : [{ name: 'page', js: '1' }];
await send('Page.enable');
for (const w of widthsArg.split(',').map(Number)) {
  const h = w >= 1900 ? 1080 : 900;
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url }); await sleep(2500);
  await evaluate(inspect); await sleep(600);
  for (const s of steps) {
    try { await evaluate(`(()=>{${s.js};return 1})()`); } catch (e) { console.log(`  step ${s.name} @${w}: ${e.message.split('\n')[0]}`); }
    await sleep(s.wait || 700);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = here(`./out/${prefix}-${w}-${s.name}.png`);
    writeFileSync(file, Buffer.from(shot.result.data, 'base64')); console.log(file);
  }
}
ws.close(); proc.kill();
