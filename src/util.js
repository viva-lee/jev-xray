import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

// Rough token estimate for budgeting before the API reports real usage.
export function estimateTokens(text) {
  return Math.ceil(text.length / 3.7);
}

// Deterministic PRNG seeded from a string, so simulated runs are stable.
export function seededRandom(seed) {
  let a = parseInt(sha1(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

// Confidence formulas from docs.typesafe.ai/confidence.
export function choiceConfidence(probabilities) {
  const n = probabilities.length;
  if (n < 2) return 1;
  return clamp((Math.max(...probabilities) - 1 / n) / (1 - 1 / n), 0, 1);
}

export function scoreConfidence(probabilities) {
  const n = probabilities.length;
  const m = probabilities.indexOf(Math.max(...probabilities));
  const spread = probabilities.reduce((s, p, i) => s + p * Math.abs(i - m), 0);
  let even = 0;
  for (let i = 0; i < n; i++) even += Math.abs(i - (n - 1) / 2);
  even /= n;
  return even === 0 ? 1 : clamp(1 - spread / even, 0, 1);
}

export function noulConfidence(p) {
  return Math.abs(2 * p - 1);
}

const LANGS = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript (JSX)',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript (TSX)',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift', c: 'C', h: 'C header', cc: 'C++', cpp: 'C++', hpp: 'C++ header', cs: 'C#',
  php: 'PHP', scala: 'Scala', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', clj: 'Clojure',
  hs: 'Haskell', ml: 'OCaml', lua: 'Lua', r: 'R', jl: 'Julia', dart: 'Dart', zig: 'Zig',
  sol: 'Solidity', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', html: 'HTML', css: 'CSS',
  scss: 'SCSS', sass: 'Sass', less: 'Less', sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL',
  proto: 'Protobuf', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell',
  md: 'Markdown', mdx: 'MDX', rst: 'reStructuredText', txt: 'Text', json: 'JSON',
  jsonc: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', ini: 'INI', xml: 'XML',
  tf: 'Terraform', nix: 'Nix', dockerfile: 'Dockerfile', makefile: 'Makefile',
};

export function languageOf(filePath) {
  const base = filePath.split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'Dockerfile';
  if (base === 'makefile') return 'Makefile';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return LANGS[ext] || (ext ? ext.toUpperCase() : 'Text');
}

export function formatInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

export function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatUsd(n) {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
