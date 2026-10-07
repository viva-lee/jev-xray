#!/usr/bin/env node
// Records the README media from a running `jev-xray` server: a hero GIF of a
// scan lighting up, a question being asked, and a line-level drill-down, plus
// still screenshots. Drives headless Chrome over the DevTools protocol with
// Node's built-in WebSocket, then stitches frames with ffmpeg.
//
//   node bin/jev-xray.js <repo> --no-open --port 4310 &   # start it first
//   node scripts/capture.mjs --url http://localhost:4310/ --out docs/media

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:4310/' },
    out: { type: 'string', default: 'docs/media' },
    chrome: { type: 'string', default: process.env.CHROME_PATH || defaultChrome() },
    width: { type: 'string', default: '1600' },
    height: { type: 'string', default: '1000' },
    ask: { type: 'string', default: 'Does this file parse or set HTTP cookies?' },
    lens: { type: 'string', default: 'security' },
    file: { type: 'string', default: '' },
    'gif-width': { type: 'string', default: '960' },
  },
});

function defaultChrome() {
  if (process.platform === 'win32') return 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return 'google-chrome';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = Number(o.width);
const H = Number(o.height);
const outDir = path.resolve(o.out);
const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-frames-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-chrome-'));
await fs.mkdir(outDir, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(o.chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  .then((r) => r.result?.value);

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        };
        return;
      }
    } catch {
      // chrome still starting
    }
    await sleep(200);
  }
  throw new Error('Could not reach Chrome DevTools.');
}

let frame = 0;
async function shot(file) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(file, Buffer.from(data, 'base64'));
}
async function record(ms, fps = 8) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t0 = Date.now();
    await shot(path.join(framesDir, `f${String(frame++).padStart(4, '0')}.png`));
    await sleep(Math.max(0, 1000 / fps - (Date.now() - t0)));
  }
}
async function still(name) {
  await sleep(700);
  await shot(path.join(outDir, name));
  console.log(`  still → ${name}`);
}
const clickLens = (k) => evaluate(`document.querySelector('.lens[data-key=${JSON.stringify(k)}]')?.click(); true`);

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${o.url}#lens=${o.lens}` });
  await sleep(900);

  console.log('  recording scan…');
  await record(7500);
  for (const k of ['role', 'hotspot', o.lens]) {
    await clickLens(k);
    await record(1100);
  }

  console.log('  recording ask…');
  await evaluate(`(() => {
    const input = document.getElementById('ask-input');
    input.value = ${JSON.stringify(o.ask)};
    document.querySelector('.seg button[data-type="noul"]').click();
    return true;
  })()`);
  await record(700);
  await evaluate(`document.getElementById('ask-form').requestSubmit(); true`);
  await record(6500);

  console.log('  recording drill-down…');
  const picked = await evaluate(`(() => {
    const want = ${JSON.stringify(o.file)};
    const rows = [...document.querySelectorAll('#toplist li')];
    const row = (want && rows.find((li) => li.title === want)) || rows[0];
    row?.click();
    return row?.title || null;
  })()`);
  await record(1200);
  await evaluate(`document.querySelector('.insp-actions .btn.primary')?.click(); true`);
  await record(3500);
  console.log(`  drilled into ${picked}`);
  await still('lines.png');
  await evaluate(`document.getElementById('lines-modal').hidden = true; true`);

  await still('ask.png');
  for (const k of ['role', 'hotspot', o.lens]) {
    await clickLens(k);
    await still(`${k}.png`);
  }
} finally {
  ws?.close();
  chrome.kill();
}

console.log(`  ${frame} frames → hero.gif`);
const gifW = Number(o['gif-width']);
const palette = path.join(framesDir, 'palette.png');
const input = ['-framerate', '8', '-i', path.join(framesDir, 'f%04d.png')];
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input,
  '-vf', `scale=${gifW}:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff`, palette]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-i', palette,
  '-lavfi', `scale=${gifW}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`,
  path.join(outDir, 'hero.gif')]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input,
  '-vf', `scale=${gifW}:-2:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-crf', '24', '-movflags', '+faststart',
  path.join(outDir, 'hero.mp4')]);
const { size } = await fs.stat(path.join(outDir, 'hero.gif'));
console.log(`  hero.gif ${(size / 1e6).toFixed(1)} MB · hero.mp4 written`);
await fs.rm(framesDir, { recursive: true, force: true });
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
