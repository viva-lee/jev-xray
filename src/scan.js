import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens, languageOf, sha1 } from './util.js';

const exec = promisify(execFile);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output',
  'coverage', 'vendor', '__pycache__', '.venv', 'venv', 'target', '.turbo', '.cache',
  '.jev-xray', '.idea', '.vscode', '.gradle', 'bower_components', '.pytest_cache', '.mypy_cache',
]);

const SKIP_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock',
  'poetry.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'uv.lock', 'Pipfile.lock',
  '.DS_Store', 'Thumbs.db',
]);

const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|ico|icns|svg|bmp|tiff?|psd|mp[34]|mov|webm|wav|ogg|flac|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|war|pdf|docx?|xlsx?|pptx?|exe|dll|so|dylib|bin|o|a|class|pyc|wasm|map|lock|db|sqlite3?|parquet|npy|npz|pt|onnx|safetensors|snap)$/i;
const SKIP_MINIFIED = /\.min\.(js|css)$/i;

function isSkipped(rel) {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return true;
  const base = parts[parts.length - 1];
  return SKIP_NAMES.has(base) || SKIP_EXT.test(base) || SKIP_MINIFIED.test(base);
}

async function gitFiles(root) {
  const { stdout } = await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
}

async function walkFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  return out;
}

// Commit counts per file over a window: the "churn" half of a classic hotspot analysis.
async function gitChurn(root, since) {
  const churn = new Map();
  try {
    const { stdout } = await exec(
      'git',
      ['-C', root, 'log', `--since=${since}`, '--no-merges', '--name-only', '--relative', '--pretty=format:'],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    for (const line of stdout.split('\n')) {
      const file = line.trim();
      if (file) churn.set(file, (churn.get(file) || 0) + 1);
    }
  } catch {
    // Not fatal: hotspots fall back to blast radius x complexity.
  }
  return churn;
}

// Keep the head and the tail of long files. Jev degrades on long, distracting
// state, so a focused excerpt beats the whole file.
export function excerpt(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const budget = Math.floor(maxTokens * 3.7);
  const head = text.slice(0, Math.floor(budget * 0.7));
  const tail = text.slice(text.length - Math.floor(budget * 0.3));
  const omitted = text.slice(head.length, text.length - tail.length).split('\n').length;
  return {
    text: `${head}\n\n[... ${omitted} lines omitted by jev-xray ...]\n\n${tail}`,
    truncated: true,
  };
}

export async function scanRepo(root, opts = {}) {
  const {
    maxFiles = 1500,
    maxBytes = 512 * 1024,
    maxTokens = 3000,
    churnSince = '12 months ago',
    onWarn = () => {},
  } = opts;

  const absRoot = path.resolve(root);
  let isGit = true;
  let rels;
  try {
    rels = await gitFiles(absRoot);
  } catch {
    isGit = false;
    rels = await walkFiles(absRoot);
  }
  rels = rels.filter((r) => !isSkipped(r)).sort();

  const files = [];
  let skippedLarge = 0;
  let skippedBinary = 0;
  for (const rel of rels) {
    const full = path.join(absRoot, rel);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue; // listed by git but deleted in the working tree
    }
    if (!stat.isFile() || stat.size === 0) continue;
    if (stat.size > maxBytes) {
      skippedLarge++;
      continue;
    }
    const buf = await fs.readFile(full);
    if (buf.subarray(0, 8192).includes(0)) {
      skippedBinary++;
      continue;
    }
    const raw = buf.toString('utf8');
    const { text, truncated } = excerpt(raw, maxTokens);
    const slash = rel.lastIndexOf('/');
    files.push({
      path: rel,
      dir: slash === -1 ? '' : rel.slice(0, slash),
      name: slash === -1 ? rel : rel.slice(slash + 1),
      lang: languageOf(rel),
      bytes: stat.size,
      lines: raw.split('\n').length,
      tokens: estimateTokens(raw),
      hash: sha1(raw),
      content: text,
      truncated,
      churn: 0,
    });
  }

  if (files.length > maxFiles) {
    onWarn(`${files.length} files found; judging the ${maxFiles} largest (raise with --max-files).`);
    files.sort((a, b) => b.tokens - a.tokens);
    files.length = maxFiles;
    files.sort((a, b) => a.path.localeCompare(b.path));
  }
  if (skippedLarge) onWarn(`Skipped ${skippedLarge} files over ${Math.round(maxBytes / 1024)} KB.`);
  if (skippedBinary) onWarn(`Skipped ${skippedBinary} binary files.`);

  if (isGit) {
    const churn = await gitChurn(absRoot, churnSince);
    for (const f of files) f.churn = churn.get(f.path) || 0;
  }
  files.forEach((f, i) => (f.id = i));

  return { root: absRoot, name: path.basename(absRoot), isGit, files };
}

export async function readFullFile(root, rel) {
  return fs.readFile(path.join(root, rel), 'utf8');
}
