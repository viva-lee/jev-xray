// A stand-in decider for exploring the UI without an API key.
//
// It returns answers in exactly the shape Jev returns, but they come from
// path and keyword heuristics, not from a model. Every run made with it is
// labelled SIMULATED in the terminal, the UI and exported reports.

import { Limiter } from './jev.js';
import {
  choiceConfidence, clamp, estimateTokens, scoreConfidence, seededRandom, sleep, softmax,
} from './util.js';

const STOP = new Set(('the a an and or of to in on for with without from by is are be this that these those it its ' +
  'file files code content path does do into about any all as at which what when how who whose there their than then ' +
  'has have had not only also very more most some such can could would should will may might strongly holds rate ' +
  'judging main itself own').split(' '));

// Longer words are more specific, so they weigh more ("cookies" > "http").
function keywords(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [])]
    .filter((w) => !STOP.has(w))
    .map((w) => ({ stem: w.slice(0, 5), weight: w.length - 2 }));
}

function overlap(words, text) {
  if (!words.length) return 0;
  const hay = String(text).toLowerCase();
  let hit = 0;
  let total = 0;
  for (const { stem, weight } of words) {
    total += weight;
    if (hay.includes(stem)) hit += weight;
  }
  return hit / total;
}

function features(state) {
  const p = String(state.path || '').toLowerCase();
  const c = String(state.content || '');
  const lines = c.split('\n');
  const branches = (c.match(/\b(if|else|for|while|switch|case|catch|elif|except|match)\b|&&|\|\||\?\s/g) || []).length;
  const maxIndent = lines.reduce((m, l) => Math.max(m, (l.match(/^\s*/)[0].replace(/\t/g, '    ').length)), 0);
  const todos = (c.match(/\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b/g) || []).length;
  const commented = lines.filter((l) => /^\s*(\/\/|#)\s*[\w$.]+\s*[(=;{]/.test(l)).length;
  const security = (c.match(/\b(auth\w*|token|password|passwd|secret|credential|crypto\w*|jwt|oauth|csrf|xss|sanitiz\w*|escape\w*|hmac|signature|cipher|encrypt\w*|decrypt\w*|session|cookie|permission\w*|role|bcrypt|hash|nonce|verify|cors)\b/gi) || []).length;
  const legacy = (c.match(/\b(deprecated|legacy|obsolete|no longer|unused|old api|compat\w*)\b/gi) || []).length;
  return { p, c, lines: lines.length, branches, density: branches / Math.max(1, lines.length), maxIndent, todos, commented, security, legacy };
}

const ROLE_RULES = [
  ['tests', /(^|\/)(tests?|__tests__|spec|specs|fixtures?|mocks?|benchmarks?|e2e)(\/|$)|[._-](test|spec|bench)\.[a-z]+$|^test_|_test\.[a-z]+$/],
  ['docs', /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|examples?|guides?)(\/|$)|changelog|license/],
  ['infra', /(^|\/)(\.github|\.circleci|scripts?|tools?|ci|deploy|docker|k8s|helm|terraform)(\/|$)|dockerfile|makefile|\.(ya?ml|toml|ini|cfg|conf|lock)$|(^|\/)[^/]*\.config\.[a-z]+$|(^|\/)(package|tsconfig|jsconfig|deno|bunfig|biome|eslint[^/]*|prettier[^/]*)\.json$|^\.[a-z]+rc/],
  ['ui', /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$|(^|\/)(components?|pages|views|ui|layouts?|styles?|client|frontend|jsx|dom)(\/|$)/],
  ['data', /(^|\/)(db|database|models?|schemas?|migrations?|repositor(y|ies)|store|stores|cache|storage|prisma|orm|sql|dao)(\/|$)|\.(sql|prisma|graphql|proto)$/],
  ['api', /(^|\/)(api|routes?|handlers?|controllers?|server|cli|cmd|bin|adapters?|endpoints?|rpc)(\/|$)|(^|\/)(main|server|app|cli)\.[a-z]+$/],
  ['util', /(^|\/)(utils?|helpers?|lib\/utils?|types?|constants?|common|shared)(\/|$)|\.d\.ts$|(^|\/)(types?|constants?|utils?|helpers?)\.[a-z]+$/],
];

function roleLogits(f, options, rand) {
  const matched = ROLE_RULES.find(([, re]) => re.test(f.p))?.[0] || 'core';
  return options.map((opt) => (opt === matched ? 3.2 : 0) + rand() * 1.1 + (opt === 'core' ? 0.4 : 0));
}

const ROLE_WEIGHT = { core: 0.65, api: 0.7, ui: 0.4, data: 0.75, util: 0.45, infra: 0.35, tests: 0.12, docs: 0.05 };

function level01(f, key) {
  const role = ROLE_RULES.find(([, re]) => re.test(f.p))?.[0] || 'core';
  const size = clamp(Math.log10(Math.max(10, f.lines)) / 3.3, 0, 1);
  const complexity = clamp(0.45 * size + 2.2 * f.density + 0.25 * clamp(f.maxIndent / 24, 0, 1), 0, 1);
  switch (key) {
    case 'complexity':
      return role === 'docs' ? 0.05 : complexity;
    case 'blast_radius':
      return clamp(0.15 + 0.6 * (ROLE_WEIGHT[role] ?? 0.5) + 0.2 * complexity + 0.25 * clamp(f.security / 6, 0, 1), 0, 1);
    case 'debt':
      return role === 'docs' ? 0.08 : clamp(0.1 + 0.18 * Math.min(4, f.todos) + 0.05 * Math.min(6, f.commented) + 0.35 * complexity * size, 0, 1);
    default:
      return clamp(0.25 + 0.5 * complexity, 0, 1);
  }
}

function noulProbability(f, key, instructions, rand) {
  const role = ROLE_RULES.find(([, re]) => re.test(f.p))?.[0] || 'core';
  let z;
  switch (key) {
    case 'security':
      z = -2.6 + 0.55 * Math.min(8, f.security) - (role === 'docs' || role === 'tests' ? 1.5 : 0);
      break;
    case 'needs_tests':
      z = -1.8 + 14 * f.density + 0.6 * Math.log10(Math.max(10, f.lines)) - (['tests', 'docs', 'infra'].includes(role) ? 4 : 0);
      break;
    case 'start_here': {
      const depth = f.p.split('/').length - 1;
      const entry = /(^|\/)(readme|index|main|app|server|mod|lib|core|cli|contributing|architecture)\.[a-z]+$/.test(f.p);
      z = -3.2 + (entry ? 3.4 : 0) + (depth <= 1 ? 1.2 : depth === 2 ? 0.4 : -0.4) - (role === 'tests' ? 2 : 0);
      break;
    }
    case 'legacy':
      z = -3.4 + 1.1 * Math.min(4, f.legacy) + 0.25 * Math.min(8, f.commented);
      break;
    default:
      z = -3.4 + 9.8 * overlap(keywords(instructions), `${f.p}\n${f.c}`) ** 1.4;
  }
  return clamp(1 / (1 + Math.exp(-(z + (rand() - 0.5) * 0.9))), 0.005, 0.995);
}

function scoreAnswer(criteria, t, rand) {
  const n = criteria.length;
  const center = t * (n - 1);
  const width = 0.45 + rand() * 0.5;
  const probs = criteria.map((_, i) => Math.exp(-((i - center) ** 2) / (2 * width * width)));
  const sum = probs.reduce((a, b) => a + b, 0);
  const norm = probs.map((p) => p / sum);
  return {
    type: 'score',
    score: norm.reduce((s, p, i) => s + p * i, 0),
    legend: Object.fromEntries(criteria.map((c, i) => [String(i), c])),
    probabilities: Object.fromEntries(norm.map((p, i) => [String(i), round(p)])),
    confidence: round(scoreConfidence(norm)),
  };
}

function choiceAnswer(options, logits) {
  const probs = softmax(logits);
  const best = probs.indexOf(Math.max(...probs));
  return {
    type: 'choice',
    choice: options[best],
    probabilities: Object.fromEntries(options.map((o, i) => [o, round(probs[i])])),
    confidence: round(choiceConfidence(probs)),
  };
}

const round = (x) => Math.round(x * 1000) / 1000;

// Line-level search requests (see engine.findLines) carry an `excerpt` of
// tagged lines; score each line by keyword overlap with the question.
function lineSearch(state, questions, rand) {
  const words = keywords(state.question);
  const rows = String(state.excerpt).split('\n');
  const answers = {};
  const options = Object.keys(questions.where.criteria);
  const byId = new Map(rows.map((r) => [r.slice(0, r.indexOf('|')), r.slice(r.indexOf('|') + 1)]));
  const logits = options.map((id) => 9 * overlap(words, byId.get(id) || '') + rand() * 0.3);
  answers.where = choiceAnswer(options, logits);
  const best = Math.max(...logits);
  answers.exists = { type: 'noul', noul: round(clamp(1 / (1 + Math.exp(-(best - 2.2))), 0.01, 0.99)) };
  return answers;
}

export function createSimulator({ minLatency = 60, maxLatency = 320, rps = 30, concurrency = 24 } = {}) {
  // Paced like the real API so the live view streams the same way.
  const limiter = new Limiter({ rps, concurrency });
  return {
    label: 'simulated',
    simulated: true,
    async systemOne({ state, questions }) {
      const seed = `${state.path}|${Object.keys(questions).join(',')}|${String(state.content || state.excerpt || '').length}`;
      const rand = seededRandom(seed);
      const latencyMs = minLatency + rand() * (maxLatency - minLatency);
      await limiter.acquire();
      await sleep(latencyMs);
      limiter.release();

      let answers;
      if (state.excerpt !== undefined && questions.where) {
        answers = lineSearch(state, questions, rand);
      } else {
        const f = features(state);
        answers = {};
        for (const [key, q] of Object.entries(questions)) {
          if (q.type === 'choice') {
            const options = Object.keys(q.criteria);
            const logits = key === 'role'
              ? roleLogits(f, options, rand)
              : options.map((o) => 6 * overlap(keywords(`${o} ${q.criteria[o]}`), `${f.p}\n${f.c}`) + rand() * 1.2);
            answers[key] = choiceAnswer(options, logits);
          } else if (q.type === 'score') {
            const t = ['blast_radius', 'complexity', 'debt'].includes(key)
              ? level01(f, key)
              : clamp(1.6 * overlap(keywords(q.instructions), `${f.p}\n${f.c}`) + 0.1 * rand(), 0, 1);
            answers[key] = scoreAnswer(q.criteria, clamp(t + (rand() - 0.5) * 0.18, 0, 1), rand);
          } else {
            answers[key] = { type: 'noul', noul: round(noulProbability(f, key, q.instructions, rand)) };
          }
        }
      }
      const inputTokens = estimateTokens(JSON.stringify(state)) + estimateTokens(JSON.stringify(questions));
      return { model: 'simulated', answers, usage: { input_tokens: inputTokens, output_tokens: 0 }, latencyMs };
    },
  };
}
