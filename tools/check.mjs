// Integrity check for www/index.html — run after every edit.
// Usage: node tools/check.mjs [path/to/index.html]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2] || new URL('../www/index.html', import.meta.url);
const html = readFileSync(file, 'utf8');
let errors = 0, warnings = 0;
const err = m => { errors++; console.log('ERROR  ' + m); };
const warn = m => { warnings++; console.log('WARN   ' + m); };

// 1. Document skeleton
for (const tag of ['<!DOCTYPE html>', '<head>', '</head>', '<body', '</body>', '</html>']) {
  if (!html.includes(tag)) err(`missing ${tag}`);
}
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
console.log('title: ' + title);

// 2. Inline scripts must compile
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
scripts.forEach((m, i) => {
  const isModule = /type=["']module["']/.test(m[0].slice(0, m[0].indexOf('>')));
  if (isModule) return; // module scripts live in separate files and are checked with `node --check`
  try {
    new vm.Script(m[1], { filename: `inline-script-${i}` });
  } catch (e) {
    const before = html.slice(0, m.index).split('\n').length;
    err(`script #${i} (starts line ${before}) does not compile: ${e.message}`);
  }
});
const js = scripts.map(m => m[1]).join('\n');

// 3. Duplicate top-level function declarations (common surgical-edit mistake)
const fnNames = [...js.matchAll(/(?:^|[;\n}])\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
const counts = fnNames.reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {});
Object.entries(counts).filter(([, c]) => c > 1).forEach(([n, c]) => err(`function ${n} declared ${c} times`));

// 4. Inline handlers must call defined functions
const defined = new Set([
  ...fnNames,
  ...[...js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
  ...[...js.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
]);
const builtins = new Set(['if', 'for', 'while', 'return', 'function', 'parseInt', 'parseFloat', 'Math', 'Number', 'String',
  'setTimeout', 'clearTimeout', 'alert', 'confirm', 'event', 'this', 'document', 'window', 'state', 'JSON', 'Date',
  'encodeURIComponent', 'decodeURIComponent', 'isNaN', 'Array', 'Object', 'navigator', 'location', 'console', 'switch', 'catch',
  'var', 'rgb', 'rgba', 'url', 'calc', 'translate', 'translateY', 'translateX', 'scale']); // CSS functions inside style strings
const handlerCalls = new Set();
for (const m of html.matchAll(/\bon(?:click|input|change|submit|keyup|keydown|blur|focus|touchstart|touchend)="([^"]*)"/g)) {
  for (const c of m[1].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) handlerCalls.add(c[1]);
}
[...handlerCalls].filter(n => !defined.has(n) && !builtins.has(n)).forEach(n => warn(`handler calls undefined function: ${n}()`));

// 5. Balanced containers in static markup (rough)
const open = (html.match(/<div\b/g) || []).length, close = (html.match(/<\/div>/g) || []).length;
if (open !== close) warn(`<div> count ${open} vs </div> ${close} (templates may legitimately differ)`);

console.log(`lines: ${html.split('\n').length}  functions: ${fnNames.length}  scripts: ${scripts.length}`);
console.log(errors ? `FAIL — ${errors} error(s), ${warnings} warning(s)` : `OK — ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
