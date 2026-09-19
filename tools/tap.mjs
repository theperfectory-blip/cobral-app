// Real touch input on the emulator, targeted by CSS selector (via adb, so gestures are genuine).
// Usage:
//   node tools/tap.mjs "<selector>" [index] [fx]      tap element center (fx = horizontal fraction 0..1, default 0.5)
//   node tools/tap.mjs --swipe "<selector>" up|down|left|right [distPx=300] [ms=250]
//   node tools/tap.mjs --text "<string>"              type into the focused input
// The Cobral WebView is edge-to-edge, so device px = CSS px * devicePixelRatio.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ADB = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const cdp = expr => execFileSync('node', [fileURLToPath(new URL('./cdp.mjs', import.meta.url)), expr], { encoding: 'utf8' }).trim();
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8' });

const rectOf = (sel, idx = 0, fx = 0.5) => {
  const out = cdp(`(()=>{const els=document.querySelectorAll(${JSON.stringify(sel)});const e=els[${idx}];if(!e)return 'NOTFOUND:'+els.length;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width*${fx},y:r.y+r.height/2,dpr:devicePixelRatio})})()`);
  if (out.startsWith('NOTFOUND')) { console.error(`selector not found: ${sel} [${idx}] (${out})`); process.exit(1); }
  const r = JSON.parse(out);
  return { x: Math.round(r.x * r.dpr), y: Math.round(r.y * r.dpr) };
};

const a = process.argv.slice(2);
if (a[0] === '--swipe') {
  const { x, y } = rectOf(a[1]);
  const dist = +(a[3] || 300), ms = a[4] || '250';
  const [dx, dy] = { up: [0, -dist], down: [0, dist], left: [-dist, 0], right: [dist, 0] }[a[2]];
  adb('shell', 'input', 'swipe', x, y, x + dx, y + dy, ms);
  console.log(`swipe ${a[2]} from ${x},${y}`);
} else if (a[0] === '--text') {
  adb('shell', 'input', 'text', a[1].replace(/([#&;()<>|*?'"$`\\])/g, '\\$1').replace(/ /g, '%s'));
  console.log(`typed ${a[1]}`);
} else {
  const { x, y } = rectOf(a[0], +(a[1] || 0), +(a[2] || 0.5));
  adb('shell', 'input', 'tap', x, y);
  console.log(`tap ${x},${y}`);
}
