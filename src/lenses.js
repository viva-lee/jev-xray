import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACK = fileURLToPath(new URL('../lenses/default.json', import.meta.url));

const MAX_CHOICE_OPTIONS = 255;
const MAX_SCORE_LEVELS = 10;

export const GENERIC_SCORE_LEVELS = [
  'Not at all.',
  'Slightly.',
  'Moderately.',
  'Strongly.',
  'Extremely.',
];

export function validateLens(lens) {
  if (!lens.key || !/^[a-z][a-z0-9_]*$/i.test(lens.key)) throw new Error(`Lens key "${lens.key}" must be an identifier.`);
  if (!['noul', 'choice', 'score'].includes(lens.type)) throw new Error(`Lens "${lens.key}" has unknown type "${lens.type}".`);
  if (!lens.instructions) throw new Error(`Lens "${lens.key}" needs instructions.`);
  if (lens.type === 'choice') {
    const n = Object.keys(lens.criteria || {}).length;
    if (n < 2 || n > MAX_CHOICE_OPTIONS) throw new Error(`Choice lens "${lens.key}" needs 2-${MAX_CHOICE_OPTIONS} options.`);
  }
  if (lens.type === 'score') {
    const n = (lens.criteria || []).length;
    if (n < 2 || n > MAX_SCORE_LEVELS) throw new Error(`Score lens "${lens.key}" needs 2-${MAX_SCORE_LEVELS} levels.`);
  }
  return lens;
}

export async function loadLensPack(file = DEFAULT_PACK) {
  const pack = JSON.parse(await fs.readFile(file, 'utf8'));
  return pack.lenses.map((l) => validateLens({ group: 'built-in', ...l }));
}

// Only the fields the API understands; label/hint/group stay local.
export function toApiQuestion(lens) {
  const q = { type: lens.type, instructions: lens.instructions };
  if (lens.criteria) q.criteria = lens.criteria;
  return q;
}

let askCounter = 0;

// Turn a free-form question typed into the UI or CLI into a lens.
export function makeAskLens({ question, type = 'noul', options = [] }) {
  const text = String(question || '').trim();
  if (!text) throw new Error('Question is empty.');
  if (text.length > 600) throw new Error('Question is too long (600 characters max).');
  askCounter++;
  const lens = {
    key: `ask_${askCounter}`,
    label: text.length > 42 ? `${text.slice(0, 40)}…` : text,
    hint: text,
    group: 'asked',
    type,
  };
  if (type === 'noul') {
    lens.instructions = `About the file at \`path\` with \`content\`: ${text}`;
  } else if (type === 'score') {
    lens.instructions = `About the file at \`path\` with \`content\`: ${text} Rate how strongly this holds.`;
    lens.criteria = GENERIC_SCORE_LEVELS;
  } else if (type === 'choice') {
    const opts = [...new Set(options.map((o) => String(o).trim()).filter(Boolean))];
    if (opts.length < 2) throw new Error('A choice question needs at least two options.');
    lens.instructions = `About the file at \`path\` with \`content\`: ${text}`;
    lens.criteria = Object.fromEntries(opts.map((o) => [o, o]));
  } else {
    throw new Error(`Unknown question type "${type}".`);
  }
  return validateLens(lens);
}
