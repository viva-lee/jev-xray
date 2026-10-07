import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const WEB = (name) => fileURLToPath(new URL(`../web/${name}`, import.meta.url));
export const WEB_SCRIPTS = ['color.js', 'treemap.js', 'app.js'];

// JSON that is safe to drop inside a <script> element. (U+2028/2029 are legal
// in JS string literals since ES2019, so only `<` needs escaping.)
export function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// One self-contained HTML file: styles, scripts and data inlined, no server.
export async function buildReport(snapshot) {
  const [html, css, ...scripts] = await Promise.all([
    fs.readFile(WEB('index.html'), 'utf8'),
    fs.readFile(WEB('app.css'), 'utf8'),
    ...WEB_SCRIPTS.map((s) => fs.readFile(WEB(s), 'utf8')),
  ]);
  const inlineScripts = scripts
    .map((src) => `<script>\n${src.replace(/<\/script/gi, '<\\/script')}\n</script>`)
    .join('\n');
  return html
    .replace('<link rel="stylesheet" href="app.css">', () => `<style>\n${css}\n</style>`)
    .replace(/<!-- scripts -->[\s\S]*<!-- \/scripts -->/, () =>
      `<script>window.__XRAY__ = ${scriptSafeJson(snapshot)};</script>\n${inlineScripts}`);
}

export async function writeReport(snapshot, outFile) {
  await fs.writeFile(outFile, await buildReport(snapshot));
  return outFile;
}
