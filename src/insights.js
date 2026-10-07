// Composite lenses and rankings computed in code from Jev's answers.
// Mirrors the composite lenses in web/app.js.

import { noulConfidence } from './util.js';

export function level01(answer, lens) {
  if (!answer) return null;
  if (answer.type === 'noul') return answer.noul;
  if (answer.type === 'score') return answer.score / Math.max(1, lens.criteria.length - 1);
  return null;
}

// Hotspot: where a bug is likely (complex, often changed) and costly (blast radius).
export function hotspots(snapshot) {
  const lens = Object.fromEntries(snapshot.lenses.map((l) => [l.key, l]));
  const maxChurn = Math.max(0, ...snapshot.files.map((f) => f.churn || 0));
  return snapshot.files.map((f) => {
    const a = snapshot.answers[f.id] || {};
    const blast = level01(a.blast_radius, lens.blast_radius);
    const complexity = level01(a.complexity, lens.complexity);
    if (blast == null || complexity == null) return { file: f, value: null };
    const churn = maxChurn > 0 ? 0.25 + 0.75 * (Math.log1p(f.churn || 0) / Math.log1p(maxChurn)) : null;
    const value = churn == null ? Math.sqrt(blast * complexity) : Math.cbrt(blast * complexity * churn);
    return { file: f, value };
  });
}

export function confidenceOf(answer) {
  if (!answer) return null;
  return answer.type === 'noul' ? noulConfidence(answer.noul) : answer.confidence;
}

export function topBy(snapshot, lensKey, n = 8) {
  const lens = snapshot.lenses.find((l) => l.key === lensKey);
  if (!lens) return [];
  return snapshot.files
    .map((f) => ({ file: f, answer: snapshot.answers[f.id]?.[lensKey] }))
    .filter((r) => r.answer)
    .map((r) => ({ ...r, value: lens.type === 'choice' ? r.answer.probabilities[r.answer.choice] : level01(r.answer, lens) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}
