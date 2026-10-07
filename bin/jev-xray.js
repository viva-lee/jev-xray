#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Engine } from '../src/engine.js';
import { hotspots, topBy } from '../src/insights.js';
import { JevClient } from '../src/jev.js';
import { loadLensPack } from '../src/lenses.js';
import { writeReport } from '../src/report.js';
import { scanRepo } from '../src/scan.js';
import { startServer } from '../src/server.js';
import { createSimulator } from '../src/simulate.js';
import { formatInt, formatTokens, formatUsd } from '../src/util.js';

const VERSION = '0.1.0';

const HELP = `
jev-xray: ask every file in a repo a typed question at once, then see the answers as a map.

Usage
  jev-xray [path]                       X-ray a repo with the default lenses and open the live map
  jev-xray ask "<question>" [path]      Ask one yes/no question of every file; print the ranking

Options
  --simulate            No API calls: a heuristic stand-in answers, for trying the UI (clearly labelled)
  --type <t>            For ask: noul (yes/no, default), score, or choice
  --options <a,b,c>     For ask --type choice: the options
  --lenses <file>       Use a custom lens pack (JSON, see lenses/default.json)
  --model <id>          Jev model id (default: jev-latest)
  --max-files <n>       Judge at most n files (default: 1500)
  --max-tokens <n>      Excerpt cap per file in tokens (default: 3000)
  --rps <n>             Requests per second (default: 18; the API allows 20)
  --top <n>             Rows per section in the terminal summary (default: 8)
  --out <file.html>     Where to write the self-contained report (default: .jev-xray/xray.html)
  --json <file>         Also write the raw snapshot as JSON
  --port <n>            Port for the live map (default: 4242)
  --ui / --no-ui        Serve the live map (default: on for scans, off for ask)
  --no-open             Do not open a browser
  --no-cache            Ignore cached answers
  -h, --help            Show this help
  -v, --version         Show the version

Environment
  TYPESAFE_API_KEY      Your Jev API key (console.typesafe.ai)
`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  pink: paint('38;5;205'),
  blue: paint('38;5;75'),
  amber: paint('38;5;214'),
  green: paint('38;5;78'),
  dim: paint('2'),
  bold: paint('1'),
};

function bar(value, width = 18) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  return c.pink('█'.repeat(filled)) + c.dim('░'.repeat(width - filled));
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // printing the URL is enough
  }
}

function progressLine(s) {
  const width = 26;
  const done = s.total ? s.judged / s.total : 0;
  const filled = Math.round(done * width);
  const rate = s.elapsed > 0 ? s.requests / s.elapsed : 0;
  return `${c.pink('▕' + '█'.repeat(filled))}${c.dim('░'.repeat(width - filled) + '▏')} ` +
    `${formatInt(s.judged)}/${formatInt(s.total)} files · ${formatInt(s.decisions)} decisions · ` +
    `${formatTokens(s.inputTokens)} tok · ${formatUsd(s.costUsd)} · ${rate.toFixed(1)} req/s`;
}

function printSection(title, rows, fmt) {
  if (!rows.length) return;
  console.log(`\n  ${c.bold(title)}`);
  for (const r of rows) console.log(`  ${fmt(r)}`);
}

function printSummary(snapshot, top) {
  const hot = hotspots(snapshot).filter((h) => h.value != null).sort((a, b) => b.value - a.value).slice(0, top);
  printSection('Hotspots  ' + c.dim('blast radius × complexity' + (snapshot.meta.isGit ? ' × churn' : '')), hot,
    (h) => `${bar(h.value)} ${h.value.toFixed(2)}  ${h.file.path}${h.file.churn ? c.dim(`  ${h.file.churn} commits`) : ''}`);
  const row = (r) => `${bar(r.value)} ${r.value.toFixed(2)}  ${r.file.path}`;
  const yes = (key) => topBy(snapshot, key, top).filter((r) => r.value >= 0.5);
  const DEFAULT = ['role', 'blast_radius', 'complexity', 'security', 'debt', 'needs_tests', 'start_here', 'legacy'];
  printSection('Security-sensitive', yes('security'), row);
  printSection('Start here', yes('start_here'), row);
  printSection('Deserves tests', yes('needs_tests'), row);

  // Custom lens packs: one section per lens.
  for (const lens of snapshot.lenses.filter((l) => !DEFAULT.includes(l.key))) {
    if (lens.type === 'choice') {
      const counts = {};
      for (const a of Object.values(snapshot.answers)) if (a[lens.key]) counts[a[lens.key].choice] = (counts[a[lens.key].choice] || 0) + 1;
      const total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
      printSection(lens.label, Object.entries(counts).sort((a, b) => b[1] - a[1]),
        ([option, n]) => `${bar(n / total)} ${String(n).padStart(4)}  ${option}`);
    } else {
      const rows = topBy(snapshot, lens.key, top);
      printSection(lens.label, lens.type === 'noul' ? rows.filter((r) => r.value >= 0.5) : rows, row);
    }
  }
}

function printStats(s) {
  const verb = s.simulated ? c.amber('SIMULATED') + c.dim(' (heuristics, no Jev calls)') : c.pink(s.model);
  console.log(`\n  ${verb}  ${formatInt(s.requests)} requests · ${formatInt(s.decisions)} decisions · ` +
    `${formatTokens(s.inputTokens)} input tokens · ${formatUsd(s.costUsd)}${s.simulated ? c.dim(' (est. at Jev pricing)') : ''} · ` +
    `p50 ${Math.round(s.p50)}ms · ${s.elapsed.toFixed(1)}s` +
    (s.cachedFiles ? c.dim(` · ${s.cachedFiles} files from cache`) : '') +
    (s.errors ? c.amber(` · ${s.errors} errors`) : ''));
}

async function main() {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      simulate: { type: 'boolean' },
      type: { type: 'string', default: 'noul' },
      options: { type: 'string' },
      lenses: { type: 'string' },
      model: { type: 'string', default: 'jev-latest' },
      'max-files': { type: 'string', default: '1500' },
      'max-tokens': { type: 'string', default: '3000' },
      rps: { type: 'string', default: '18' },
      top: { type: 'string', default: '8' },
      out: { type: 'string' },
      json: { type: 'string' },
      port: { type: 'string', default: '4242' },
      ui: { type: 'boolean' },
      'no-ui': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      'no-cache': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (o.help) return console.log(HELP);
  if (o.version) return console.log(VERSION);

  const askMode = positionals[0] === 'ask';
  if (askMode && !positionals[1]) throw new Error('Usage: jev-xray ask "<question>" [path]');
  const question = askMode ? positionals[1] : null;
  const root = path.resolve((askMode ? positionals[2] : positionals[0]) || '.');
  const ui = o['no-ui'] ? false : o.ui ?? !askMode;

  if (!o.simulate && !process.env.TYPESAFE_API_KEY) {
    console.error(`\n  ${c.pink('No TYPESAFE_API_KEY set.')}\n` +
      `  Get a key at https://console.typesafe.ai, then: ${c.bold('export TYPESAFE_API_KEY=...')}\n` +
      `  Or explore the UI with heuristic stand-in answers: ${c.bold('jev-xray --simulate')}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  ${c.pink('JEV // X-RAY')} ${c.dim('v' + VERSION)}  ${root}`);
  const scan = await scanRepo(root, {
    maxFiles: Number(o['max-files']),
    maxTokens: Number(o['max-tokens']),
    onWarn: (m) => console.log(`  ${c.amber('!')} ${m}`),
  });
  if (!scan.files.length) throw new Error('No text files found to judge.');
  const tokens = scan.files.reduce((s, f) => s + Math.min(f.tokens, Number(o['max-tokens'])), 0);
  console.log(`  ${formatInt(scan.files.length)} files · ~${formatTokens(tokens)} tokens of code${scan.isGit ? ' · git history found' : ''}`);

  const lenses = askMode ? [] : await loadLensPack(o.lenses);
  const decider = o.simulate
    ? createSimulator()
    : new JevClient({ model: o.model, rps: Number(o.rps), concurrency: 24 });
  const workDir = path.join(scan.root, '.jev-xray');
  const engine = new Engine({
    scan,
    lenses,
    decider,
    cacheFile: o['no-cache'] ? null : path.join(workDir, `cache-${o.model.replace(/[^\w.-]/g, '_')}.json`),
  });
  await engine.init();

  if (ui) {
    const { url } = await startServer(engine, { port: Number(o.port) });
    console.log(`  live map → ${c.bold(url)}`);
    if (!o['no-open']) openBrowser(url);
  }

  const showProgress = process.stdout.isTTY;
  engine.on('stats', (s) => showProgress && process.stdout.write(`\r  ${progressLine(s)}\x1b[K`));
  engine.on('fatal', ({ message }) => console.error(`\n  ${c.pink('✖')} ${message}`));

  console.log('');
  if (askMode) {
    const { done } = engine.ask({ question, type: o.type, options: (o.options || '').split(',') });
    await done;
  } else {
    await engine.runScan();
  }
  if (showProgress) process.stdout.write('\n');

  const snapshot = engine.snapshot();
  if (askMode) {
    const lens = snapshot.lenses[snapshot.lenses.length - 1];
    const rows = topBy(snapshot, lens.key, Number(o.top));
    printSection(`“${question}”`, rows, (r) => {
      const label = lens.type === 'choice' ? c.blue(r.answer.choice.padEnd(10)) + ' ' : '';
      return `${bar(r.value)} ${r.value.toFixed(2)}  ${label}${r.file.path}`;
    });
  } else {
    printSummary(snapshot, Number(o.top));
  }
  printStats(snapshot.stats);

  const outFile = path.resolve(o.out || path.join(workDir, 'xray.html'));
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  if (outFile.startsWith(workDir)) await fs.writeFile(path.join(workDir, '.gitignore'), '*\n');
  await writeReport(snapshot, outFile);
  console.log(`  report → ${outFile}`);
  if (o.json) {
    await fs.writeFile(path.resolve(o.json), JSON.stringify(snapshot, null, 1));
    console.log(`  json   → ${path.resolve(o.json)}`);
  }

  if (ui) console.log(`\n  ${c.dim('Map stays live: ask new questions in the browser. Ctrl+C to quit.')}`);
  else process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error(`\n  ${c.pink('✖')} ${err.message}`);
  process.exit(1);
});
