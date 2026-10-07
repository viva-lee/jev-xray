import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JEV_PRICE_PER_MTOK } from './jev.js';
import { makeAskLens, toApiQuestion } from './lenses.js';
import { readFullFile } from './scan.js';
import { percentile, seededRandom, sha1 } from './util.js';

const LINE_WINDOW = 250; // Choice questions allow 255 options; leave headroom.
const MAX_LINES = 2000;

// Answers are stored without fields the lens definition already carries.
function compact(answer) {
  const { legend, ...rest } = answer;
  return rest;
}

class AnswerCache {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.dirty = false;
    this.timer = null;
  }

  async load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const [k, v] of Object.entries(data)) this.map.set(k, v);
    } catch {
      // first run
    }
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    if (!this.file) return;
    this.map.set(key, value);
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1500);
  }

  async flush() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(path.join(path.dirname(this.file), '.gitignore'), '*\n');
    await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.map)));
  }
}

export class Engine extends EventEmitter {
  constructor({ scan, lenses, decider, cacheFile = null }) {
    super();
    this.scan = scan;
    this.lenses = lenses;
    this.decider = decider;
    this.cache = new AnswerCache(decider.simulated ? null : cacheFile);
    this.answers = new Map(scan.files.map((f) => [f.id, {}]));
    this.resolvedModel = null;
    this.fatal = null;
    this.stats = {
      requests: 0,
      cachedFiles: 0,
      inputTokens: 0,
      decisions: 0,
      errors: 0,
      latencies: [],
      startedAt: null,
      finishedAt: null,
      running: 0,
    };
    this.statsTimer = null;
  }

  async init() {
    await this.cache.load();
  }

  lens(key) {
    return this.lenses.find((l) => l.key === key);
  }

  cacheKey(file, lens) {
    return sha1(`${this.decider.label}|${JSON.stringify(toApiQuestion(lens))}|${file.hash}`);
  }

  summary() {
    const s = this.stats;
    const lat = s.latencies;
    const elapsed = ((s.finishedAt || Date.now()) - (s.startedAt || Date.now())) / 1000;
    return {
      requests: s.requests,
      cachedFiles: s.cachedFiles,
      inputTokens: s.inputTokens,
      decisions: s.decisions,
      errors: s.errors,
      costUsd: (s.inputTokens / 1e6) * JEV_PRICE_PER_MTOK,
      p50: percentile(lat, 0.5),
      p95: percentile(lat, 0.95),
      elapsed,
      running: s.running > 0,
      judged: [...this.answers.values()].filter((a) => Object.keys(a).length > 0).length,
      total: this.scan.files.length,
      model: this.resolvedModel || this.decider.label,
      simulated: Boolean(this.decider.simulated),
    };
  }

  emitStats(force = false) {
    if (force) {
      clearTimeout(this.statsTimer);
      this.statsTimer = null;
      this.emit('stats', this.summary());
      return;
    }
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.emit('stats', this.summary());
    }, 200);
  }

  recordUsage(res) {
    this.stats.requests++;
    this.stats.inputTokens += res.usage?.input_tokens || 0;
    this.stats.latencies.push(res.latencyMs);
    if (this.stats.latencies.length > 2000) this.stats.latencies.shift();
    if (res.model && !this.resolvedModel) this.resolvedModel = res.model;
  }

  async judgeFile(file, lenses) {
    const store = this.answers.get(file.id);
    const fresh = {};
    const missing = [];
    for (const lens of lenses) {
      const hit = this.cache.get(this.cacheKey(file, lens));
      if (hit) fresh[lens.key] = hit;
      else missing.push(lens);
    }

    let latencyMs = 0;
    let inputTokens = 0;
    if (missing.length) {
      const res = await this.decider.systemOne({
        state: { path: file.path, language: file.lang, content: file.content },
        questions: Object.fromEntries(missing.map((l) => [l.key, toApiQuestion(l)])),
      });
      this.recordUsage(res);
      latencyMs = res.latencyMs;
      inputTokens = res.usage?.input_tokens || 0;
      for (const lens of missing) {
        const answer = res.answers?.[lens.key];
        if (!answer) continue;
        fresh[lens.key] = compact(answer);
        this.cache.set(this.cacheKey(file, lens), fresh[lens.key]);
      }
    } else {
      this.stats.cachedFiles++;
    }

    Object.assign(store, fresh);
    this.stats.decisions += Object.keys(fresh).length;
    this.emit('answer', { fileId: file.id, answers: fresh, latencyMs, inputTokens, cached: missing.length === 0 });
    this.emitStats();
  }

  // Judge every file against `lenses`, a bounded pool at a time. Files go in a
  // shuffled order so the map lights up everywhere at once instead of sweeping.
  async run(lenses) {
    if (this.fatal) throw this.fatal;
    const order = [...this.scan.files];
    const rand = seededRandom(lenses.map((l) => l.key).join(','));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    this.stats.running++;
    this.stats.startedAt ??= Date.now();
    this.stats.finishedAt = null;
    this.emit('status', { phase: 'running', lenses: lenses.map((l) => l.key) });

    let next = 0;
    const worker = async () => {
      while (next < order.length && !this.fatal) {
        const file = order[next++];
        try {
          await this.judgeFile(file, lenses);
        } catch (err) {
          if (err.fatal) {
            this.fatal = err;
            this.emit('fatal', { message: err.message });
            return;
          }
          this.stats.errors++;
          this.emit('fileError', { fileId: file.id, message: err.message });
        }
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));

    this.stats.running--;
    if (this.stats.running === 0) this.stats.finishedAt = Date.now();
    await this.cache.flush();
    this.emitStats(true);
    this.emit('status', { phase: this.stats.running ? 'running' : 'idle' });
    if (this.fatal) throw this.fatal;
  }

  async runScan() {
    return this.run(this.lenses.filter((l) => l.group === 'built-in'));
  }

  // Add a free-form question as a new lens and judge every file against it.
  ask(spec) {
    const lens = makeAskLens(spec);
    this.lenses.push(lens);
    this.emit('lens', { lens });
    const done = this.run([lens]).catch((err) => this.emit('fatal', { message: err.message }));
    return { lens, done };
  }

  // Line-level drill-down, after the "line-by-line search" cookbook: tag every
  // line with an id, ask a choice over the ids plus a noul for whether any line
  // answers at all. Long files are split into windows judged in parallel.
  async findLines(fileId, lensKey) {
    const file = this.scan.files[fileId];
    const lens = this.lens(lensKey);
    if (!file || !lens) throw new Error('Unknown file or lens.');

    let text;
    try {
      text = await readFullFile(this.scan.root, file.path);
    } catch {
      text = file.content;
    }
    const all = text.split(/\r?\n/);
    const lines = all.slice(0, MAX_LINES);
    // The excerpt state has no `content` or `path` fields, so drop those references.
    const plain = lens.instructions
      .replace(/^About the file at `path` with `content`: /, '')
      .replace(/`content`/g, 'the code')
      .replace(/the file at `path`/g, 'this file')
      .replace(/`path`/g, 'this file');
    const question = lens.type === 'noul' ? plain : `Evidence for this judgment: ${plain}`;

    const windows = [];
    for (let from = 0; from < lines.length; from += LINE_WINDOW) windows.push(from);

    const started = performance.now();
    const results = await Promise.all(windows.map(async (from) => {
      const slice = lines.slice(from, from + LINE_WINDOW);
      const ids = slice.map((_, i) => `L${String(from + i + 1).padStart(4, '0')}`);
      const res = await this.decider.systemOne({
        state: {
          path: file.path,
          question,
          excerpt: slice.map((l, i) => `${ids[i]}| ${l.slice(0, 240)}`).join('\n'),
        },
        questions: {
          where: {
            type: 'choice',
            instructions: 'Which line in `excerpt` is the strongest evidence for `question`?',
            criteria: Object.fromEntries(ids.map((id, i) => [id, `Line ${from + i + 1}`])),
          },
          exists: {
            type: 'noul',
            instructions: '`excerpt` contains at least one line that is clear evidence for `question`.',
          },
        },
      });
      this.recordUsage(res);
      return { from, ids, res };
    }));
    this.emitStats(true);

    const scores = new Array(lines.length).fill(0);
    const windowInfo = [];
    let inputTokens = 0;
    for (const { from, ids, res } of results) {
      const exists = res.answers?.exists?.noul ?? 0;
      const probs = res.answers?.where?.probabilities || {};
      ids.forEach((id, i) => (scores[from + i] = exists * (probs[id] || 0)));
      windowInfo.push({ from: from + 1, to: from + ids.length, exists });
      inputTokens += res.usage?.input_tokens || 0;
    }

    return {
      fileId,
      lensKey,
      path: file.path,
      question,
      lines: lines.map((t, i) => ({ n: i + 1, text: t, score: scores[i] })),
      windows: windowInfo,
      clipped: all.length > MAX_LINES,
      inputTokens,
      latencyMs: performance.now() - started,
    };
  }

  snapshot() {
    return {
      meta: {
        name: this.scan.name,
        isGit: this.scan.isGit,
        model: this.resolvedModel || this.decider.label,
        simulated: Boolean(this.decider.simulated),
        generatedAt: new Date().toISOString(),
        pricePerMTok: JEV_PRICE_PER_MTOK,
      },
      lenses: this.lenses,
      files: this.scan.files.map(({ content, hash, ...meta }) => meta),
      answers: Object.fromEntries(this.answers),
      stats: this.summary(),
    };
  }
}
