'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadPdfLite() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'pdflite.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(code, context, { filename: 'pdflite.js' });
  assert.ok(context.PdfLite, 'PdfLite global should be defined after loading');
  return context.PdfLite;
}

function buildSampleDoc(PdfLite) {
  const doc = PdfLite.createDocument();
  doc.addPage();
  doc.text('Invoice #123', 72, 72, { size: 14, bold: true });
  doc.text('Total (USD)', 72, 100);
  doc.text('$1,234.56', 340, 100, { size: 10, align: 'right', maxWidth: 200 });
  doc.text('café × 2', 72, 120);
  doc.line(72, 130, 540, 130);
  doc.addPage();
  doc.text('Page two', 72, 72, { size: 10, align: 'center', maxWidth: 200 });
  doc.line(72, 90, 540, 90, { width: 1 });
  return doc.build();
}

test('build() produces a structurally valid 2-page PDF', () => {
  const PdfLite = loadPdfLite();
  const bytes = buildSampleDoc(PdfLite);

  // instanceof fails across vm realms, so compare the internal tag instead.
  assert.strictEqual(Object.prototype.toString.call(bytes), '[object Uint8Array]',
    'build() should return a Uint8Array');
  const str = Buffer.from(bytes).toString('latin1');

  assert.ok(str.startsWith('%PDF-1.4'), 'file should start with %PDF-1.4');
  assert.match(str.trimEnd(), /%%EOF$/, 'file should end with %%EOF');
  assert.ok(str.includes('/Type /Catalog'), 'should contain a catalog object');
  assert.ok(str.includes('/Count 2'), 'pages tree should count 2 pages');
  assert.ok(str.includes('Helvetica'), 'should reference Helvetica');
  assert.ok(str.includes('Helvetica-Bold'), 'should reference Helvetica-Bold');
  assert.ok(str.includes('Total \\(USD\\)'), 'parens should be escaped in strings');
});

test('xref table offsets point at the correct object headers', () => {
  const PdfLite = loadPdfLite();
  const bytes = buildSampleDoc(PdfLite);
  const str = Buffer.from(bytes).toString('latin1');

  // Find the real xref section (not the "startxref" keyword).
  const xrefIdx = str.lastIndexOf('\nxref\n');
  assert.ok(xrefIdx > 0, 'xref section should exist');
  const xrefOffset = xrefIdx + 1; // skip the leading newline

  // startxref must point at the xref keyword.
  const startxrefMatch = str.match(/startxref\n(\d+)\n%%EOF/);
  assert.ok(startxrefMatch, 'startxref should be present');
  assert.strictEqual(Number(startxrefMatch[1]), xrefOffset,
    'startxref should point at the xref section');

  // Parse the subsection header: "0 N".
  const lines = str.slice(xrefOffset).split('\n');
  assert.strictEqual(lines[0], 'xref');
  const [start, count] = lines[1].split(' ').map(Number);
  assert.strictEqual(start, 0, 'xref subsection should start at object 0');
  assert.ok(count > 4, 'should have catalog, pages, fonts and page objects');

  // Object 0 is the free-list head; objects 1..count-1 must be in-use and
  // their offsets must land exactly on "N 0 obj".
  assert.match(lines[2], /^0000000000 65535 f\s*$/, 'object 0 should be free');
  for (let n = 1; n < count; n++) {
    const entry = lines[2 + n];
    const m = entry.match(/^(\d{10}) (\d{5}) n\s*$/);
    assert.ok(m, `xref entry for object ${n} should be an in-use entry: "${entry}"`);
    const offset = parseInt(m[1], 10);
    const header = `${n} 0 obj`;
    assert.strictEqual(str.slice(offset, offset + header.length), header,
      `xref offset ${offset} for object ${n} should point at "${header}"`);
  }
});

test('textWidth returns plausible Helvetica widths', () => {
  const PdfLite = loadPdfLite();
  const w = PdfLite.textWidth('Hello', 10, false);
  assert.ok(w > 15 && w < 40, `textWidth('Hello', 10) should be plausible, got ${w}`);
  const wb = PdfLite.textWidth('Hello', 10, true);
  assert.ok(wb > w, 'bold text should measure wider than regular');
  assert.ok(PdfLite.textWidth('', 10, false) === 0, 'empty string has zero width');
});
