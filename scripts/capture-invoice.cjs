'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { anonymizeInvoice, MAX_CAPTURE_BYTES } = require('./lib/anonymize-invoice.cjs');

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/capture-invoice.cjs PRIVATE_INPUT.html ANONYMIZED_OUTPUT.html');
  if (path.resolve(input) === path.resolve(output)) throw new Error('Input and output must be different files');
  if (fs.statSync(input).size > MAX_CAPTURE_BYTES) throw new Error('Capture exceeds 8 MiB');
  const html = await anonymizeInvoice(fs.readFileSync(input, 'utf8'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Exclusive creation prevents accidentally overwriting an existing capture.
  fs.writeFileSync(output, html, { flag: 'wx', mode: 0o600 });
  console.log(`Anonymized fixture saved to ${path.resolve(output)}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
