// Refreshes src/psl-data.js from the official Public Suffix List. Run: npm run update-psl
import { writeFileSync } from 'node:fs';

const res = await fetch('https://publicsuffix.org/list/public_suffix_list.dat');
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const rules = (await res.text())
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s/)[0])
  .filter((line) => line && !line.startsWith('//'));
const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  new URL('../src/psl-data.js', import.meta.url),
  `// Generated from https://publicsuffix.org/list/public_suffix_list.dat (${date}); rules only.\n` +
    `(function (root) {\n  (root.VD = root.VD || {}).pslRules = ${JSON.stringify(rules.join('\n'))}.split("\\n");\n})(globalThis);\n`,
);
console.log(`Saved ${rules.length} rules`);
