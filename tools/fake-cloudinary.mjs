// Fake Cloudinary for photo-sync tests (never talks to the real account).
// Usage: node tools/fake-cloudinary.mjs [port=9199]
//   POST /v1_1/<cloud>/image/upload   multipart (file = data URL, upload_preset)  → {secure_url}
//   GET  /img/<n>                     the uploaded bytes (CORS *)
//   GET  /__stats                     {uploads, presets:[…], mode}
//   POST /__mode/<ok|nopreset|down>   ok = normal; nopreset = 400 "Upload preset not found"; down = 503
//   POST /__reset                     forget everything
// The app only honours localStorage.cobralCloudinaryBase when it runs on hostname "localhost"
// (web served on localhost, or the Capacitor WebView; for the Android emulator also `adb reverse tcp:9199 tcp:9199`).
import http from 'node:http';

const PORT = Number(process.argv[2] || 9199);
let mode = 'ok';
let uploads = [];           // {type, bytes:Buffer}
let presets = [];

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { ...cors, ...headers }); res.end(body); };

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return {};
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(pos + boundary.length + 2, next - 2);      // strip CRLF before/after
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = part.subarray(0, headEnd).toString('utf8');
      const name = /name="([^"]+)"/.exec(head);
      if (name) fields[name[1]] = part.subarray(headEnd + 4);
    }
    pos = next;
  }
  return fields;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (url.pathname === '/__stats') return send(res, 200, JSON.stringify({ uploads: uploads.length, presets, mode }), { 'Content-Type': 'application/json' });
  if (url.pathname.startsWith('/__mode/')) { mode = url.pathname.split('/')[2]; return send(res, 200, mode); }
  if (url.pathname === '/__reset') { uploads = []; presets = []; mode = 'ok'; return send(res, 200, 'reset'); }

  const img = /^\/img\/(\d+)/.exec(url.pathname);
  if (req.method === 'GET' && img) {
    const u = uploads[Number(img[1])];
    return u ? send(res, 200, u.bytes, { 'Content-Type': u.type, 'Cache-Control': 'no-store' }) : send(res, 404, 'not found');
  }

  if (req.method === 'POST' && /^\/v1_1\/[^/]+\/image\/upload$/.test(url.pathname)) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (mode === 'down') return send(res, 503, JSON.stringify({ error: { message: 'Service unavailable' } }), { 'Content-Type': 'application/json' });
      const f = parseMultipart(Buffer.concat(chunks), req.headers['content-type']);
      const preset = f.upload_preset ? f.upload_preset.toString() : '';
      if (mode === 'nopreset' || !preset) return send(res, 400, JSON.stringify({ error: { message: 'Upload preset not found' } }), { 'Content-Type': 'application/json' });
      const dataUrl = f.file ? f.file.toString() : '';
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
      if (!m) return send(res, 400, JSON.stringify({ error: { message: 'Invalid image file' } }), { 'Content-Type': 'application/json' });
      uploads.push({ type: m[1], bytes: Buffer.from(m[3], m[2] ? 'base64' : 'utf8') });
      presets.push(preset);
      const n = uploads.length - 1;
      send(res, 200, JSON.stringify({ secure_url: `http://${req.headers.host}/img/${n}.jpg`, public_id: `fake/${n}` }), { 'Content-Type': 'application/json' });
    });
    return;
  }
  send(res, 404, 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`fake cloudinary on http://127.0.0.1:${PORT}`));
