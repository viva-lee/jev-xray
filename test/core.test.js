import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, JevError } from '../src/jev.js';
import { loadLensPack, makeAskLens, toApiQuestion } from '../src/lenses.js';
import { buildReport, scriptSafeJson } from '../src/report.js';
import { excerpt } from '../src/scan.js';
import { createSimulator } from '../src/simulate.js';
import { choiceConfidence, scoreConfidence } from '../src/util.js';
import '../web/treemap.js';
import '../web/color.js';

const { XTreemap, XColor } = globalThis;

test('default lens pack is valid and API questions carry no UI fields', async () => {
  const lenses = await loadLensPack();
  assert.ok(lenses.length >= 6);
  for (const lens of lenses) {
    const q = toApiQuestion(lens);
    assert.deepEqual(Object.keys(q).sort(), lens.criteria ? ['criteria', 'instructions', 'type'] : ['instructions', 'type']);
  }
  const role = lenses.find((l) => l.key === 'role');
  assert.ok(Object.keys(role.criteria).length <= 8, 'role must fit the 8-slot categorical palette');
});

test('ask lenses validate their input', () => {
  assert.equal(makeAskLens({ question: 'Touches the DB?' }).type, 'noul');
  assert.equal(makeAskLens({ question: 'How messy?', type: 'score' }).criteria.length, 5);
  assert.throws(() => makeAskLens({ question: '  ' }));
  assert.throws(() => makeAskLens({ question: 'Team?', type: 'choice', options: ['only one'] }));
  const choice = makeAskLens({ question: 'Team?', type: 'choice', options: ['web', 'api', 'web'] });
  assert.deepEqual(Object.keys(choice.criteria), ['web', 'api']);
});

test('confidence formulas match the TypeSafe docs examples', () => {
  assert.ok(Math.abs(choiceConfidence([0.6, 0.3, 0.1]) - 0.4) < 1e-9);
  assert.ok(Math.abs(scoreConfidence([0, 0.57, 0.43]) - 0.355) < 0.01);
});

test('simulator returns answers in the exact Jev shapes', async () => {
  const sim = createSimulator({ minLatency: 0, maxLatency: 1, rps: 1000 });
  const lenses = await loadLensPack();
  const res = await sim.systemOne({
    state: { path: 'src/auth/session.ts', language: 'TypeScript', content: 'export function verify(token) { if (!token) throw new Error("no"); return jwt.verify(token, secret); }' },
    questions: Object.fromEntries(lenses.map((l) => [l.key, toApiQuestion(l)])),
  });
  assert.equal(res.model, 'simulated');
  for (const lens of lenses) {
    const a = res.answers[lens.key];
    assert.equal(a.type, lens.type);
    if (a.type === 'noul') assert.ok(a.noul >= 0 && a.noul <= 1);
    if (a.type === 'choice') {
      assert.ok(Object.keys(lens.criteria).includes(a.choice));
      const sum = Object.values(a.probabilities).reduce((s, p) => s + p, 0);
      assert.ok(Math.abs(sum - 1) < 0.01);
    }
    if (a.type === 'score') assert.ok(a.score >= 0 && a.score <= lens.criteria.length - 1);
  }
  assert.ok(res.answers.security.noul > 0.5, 'jwt + secret should read as security-sensitive');
});

test('client retries on 429 and surfaces auth failures as fatal', async () => {
  let calls = 0;
  const ok = { model: 'jev-1.13.0', answers: { x: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10 } };
  const flaky = async () => {
    calls++;
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
    return new Response(JSON.stringify(ok), { status: 200 });
  };
  const client = new JevClient({ apiKey: 'k', fetchImpl: flaky, rps: 1000 });
  const res = await client.systemOne({ state: 's', questions: {} });
  assert.equal(calls, 2);
  assert.equal(res.answers.x.noul, 0.9);

  const denied = new JevClient({ apiKey: 'bad', fetchImpl: async () => new Response('no', { status: 401 }), rps: 1000 });
  await assert.rejects(denied.systemOne({ state: 's', questions: {} }), (err) => err instanceof JevError && err.fatal);
});

test('treemap tiles stay inside the frame and keep area proportions', () => {
  const files = [
    { id: 0, path: 'a.ts', dir: '', name: 'a.ts', tokens: 400 },
    { id: 1, path: 'src/b.ts', dir: 'src', name: 'b.ts', tokens: 200 },
    { id: 2, path: 'src/c.ts', dir: 'src', name: 'c.ts', tokens: 200 },
    { id: 3, path: 'src/deep/only/d.ts', dir: 'src/deep/only', name: 'd.ts', tokens: 100 },
  ];
  const tree = XTreemap.buildTree(files, (f) => f.tokens);
  assert.ok(tree.children.some((c) => c.name === 'src'));
  const src = tree.children.find((c) => c.name === 'src');
  assert.ok(src.children.some((c) => c.name === 'deep/only'), 'single-child chains collapse');

  const { tiles } = XTreemap.layout(tree, { x: 0, y: 0, w: 800, h: 500 }, { pad: 0, header: 0 });
  assert.equal(tiles.length, 4);
  for (const t of tiles) {
    assert.ok(t.x >= -1e-6 && t.y >= -1e-6 && t.x + t.w <= 800 + 1e-6 && t.y + t.h <= 500 + 1e-6);
  }
  const area = (id) => tiles.find((t) => t.file.id === id).w * tiles.find((t) => t.file.id === id).h;
  assert.ok(Math.abs(area(0) / area(1) - 2) < 1e-6);
});

test('diverging scale is gray at p = 0.5 and hits both poles', () => {
  assert.equal(XColor.diverging(0), XColor.PALETTE.no);
  assert.equal(XColor.diverging(0.5), XColor.PALETTE.unsure);
  assert.equal(XColor.diverging(1), XColor.PALETTE.yes);
});

test('reports cannot be broken out of by file paths', async () => {
  assert.equal(scriptSafeJson({ p: '</script><script>alert(1)</script>' }).includes('</script'), false);
  const html = await buildReport({ meta: { name: 'x' }, lenses: [], files: [{ id: 0, path: '</script>.ts' }], answers: {}, stats: {} });
  assert.equal((html.match(/<\/script>/g) || []).length, (html.match(/<script>/g) || []).length);
});

test('long files keep their head and tail', () => {
  const text = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
  const { text: out, truncated } = excerpt(text, 500);
  assert.ok(truncated);
  assert.ok(out.startsWith('line 0'));
  assert.ok(out.trimEnd().endsWith('line 3999'));
  assert.match(out, /lines omitted by jev-xray/);
});
