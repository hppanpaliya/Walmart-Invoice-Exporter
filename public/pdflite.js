/**
 * pdflite.js — minimal, dependency-free PDF 1.4 generator.
 *
 * Loaded via <script> tag (no modules); exposes a single global `PdfLite`.
 * Supports US-Letter pages, text in Helvetica / Helvetica-Bold (built-in
 * PDF base fonts, WinAnsi encoding) and stroked lines.
 *
 * Coordinate convention for callers: y is measured from the TOP of the
 * page and converted internally to PDF's bottom-up coordinate space.
 *
 * Usage:
 *   const doc = PdfLite.createDocument();
 *   doc.addPage();
 *   doc.text('Invoice', 72, 72, { size: 14, bold: true });
 *   doc.text('$12.34', 540, 100, { size: 10, align: 'right' });
 *   doc.line(72, 110, 540, 110);
 *   const bytes = doc.build(); // Uint8Array of a complete PDF file
 */
var PdfLite = (() => {
  'use strict';

  const PAGE_WIDTH = 612; // US Letter, points
  const PAGE_HEIGHT = 792;
  const DEFAULT_CHAR_WIDTH = 556; // fallback for chars outside ASCII 32..126

  // Helvetica AFM glyph widths (thousandths of font size) for chars 32..126.
  const HELVETICA_WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
  ];

  // Helvetica-Bold AFM glyph widths for chars 32..126.
  const HELVETICA_BOLD_WIDTHS = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
  ];

  // Unicode code points outside Latin-1 that WinAnsi encodes in 0x80..0x9F.
  const WINANSI_EXTRA = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
    0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
    0x017e: 0x9e, 0x0178: 0x9f
  };

  // Format a number for the content stream (max 2 decimals).
  const fmt = (n) => String(Math.round(n * 100) / 100);

  // Map one Unicode code point to a WinAnsi byte, or 63 ('?') if unmappable.
  const toWinAnsiByte = (cp) => {
    if (cp >= 32 && cp <= 126) return cp;
    if (cp >= 0xa0 && cp <= 0xff) return cp; // Latin-1 block matches WinAnsi
    if (WINANSI_EXTRA[cp] !== undefined) return WINANSI_EXTRA[cp];
    return 63; // '?'
  };

  // Convert a JS string to an escaped PDF literal-string body (ASCII-safe:
  // backslash/parens are escaped, bytes above 126 become octal escapes).
  const escapePdfString = (str) => {
    let out = '';
    for (const ch of String(str)) {
      const byte = toWinAnsiByte(ch.codePointAt(0));
      if (byte === 0x5c) out += '\\\\';
      else if (byte === 0x28) out += '\\(';
      else if (byte === 0x29) out += '\\)';
      else if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte);
      else out += '\\' + byte.toString(8).padStart(3, '0');
    }
    return out;
  };

  /**
   * Estimate the rendered width of a string in points using the real
   * Helvetica / Helvetica-Bold AFM width tables (ASCII 32..126; any other
   * character counts as 556/1000 em). Useful for right-aligned columns.
   *
   * @param {string} str - Text to measure.
   * @param {number} size - Font size in points.
   * @param {boolean} [bold] - Measure with Helvetica-Bold widths.
   * @returns {number} Width in points.
   */
  const textWidth = (str, size, bold) => {
    const widths = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
    let units = 0;
    for (const ch of String(str)) {
      const cp = ch.codePointAt(0);
      units += (cp >= 32 && cp <= 126) ? widths[cp - 32] : DEFAULT_CHAR_WIDTH;
    }
    return (units * size) / 1000;
  };

  /**
   * Create a new PDF document builder.
   *
   * @returns {{addPage: Function, text: Function, line: Function, build: Function}}
   */
  const createDocument = () => {
    const pages = []; // each entry: array of content-stream operation strings
    let current = null;

    const ensurePage = () => {
      if (!current) builder.addPage();
    };

    const builder = {
      /**
       * Start a new US-Letter page (612 x 792 pt). Subsequent text/line
       * calls draw onto this page.
       *
       * @returns {object} The builder (chainable).
       */
      addPage() {
        current = [];
        pages.push(current);
        return builder;
      },

      /**
       * Draw a single line of text.
       *
       * @param {string} str - Text to draw (WinAnsi-encodable chars; others become '?').
       * @param {number} x - X position in points (meaning depends on align).
       * @param {number} y - Baseline position in points, measured from the TOP of the page.
       * @param {object} [options]
       * @param {number} [options.size=10] - Font size in points.
       * @param {boolean} [options.bold=false] - Use Helvetica-Bold.
       * @param {'left'|'right'|'center'} [options.align='left'] - Without maxWidth,
       *   'right' treats x as the right edge and 'center' as the midpoint. With
       *   maxWidth, text is aligned inside the box [x, x + maxWidth].
       * @param {number} [options.maxWidth] - Width of the alignment box in points.
       * @returns {object} The builder (chainable).
       */
      text(str, x, y, options = {}) {
        ensurePage();
        const { size = 10, bold = false, align = 'left', maxWidth } = options;
        const w = textWidth(str, size, bold);
        let drawX = x;
        if (align === 'right') {
          drawX = maxWidth !== undefined ? x + maxWidth - w : x - w;
        } else if (align === 'center') {
          drawX = maxWidth !== undefined ? x + (maxWidth - w) / 2 : x - w / 2;
        }
        const font = bold ? '/F2' : '/F1';
        const py = PAGE_HEIGHT - y;
        current.push(
          `BT ${font} ${fmt(size)} Tf ${fmt(drawX)} ${fmt(py)} Td ` +
          `(${escapePdfString(str)}) Tj ET`
        );
        return builder;
      },

      /**
       * Draw a stroked line between two points.
       *
       * @param {number} x1 - Start x in points.
       * @param {number} y1 - Start y in points, from the TOP of the page.
       * @param {number} x2 - End x in points.
       * @param {number} y2 - End y in points, from the TOP of the page.
       * @param {object} [options]
       * @param {number} [options.width=0.5] - Stroke width in points.
       * @returns {object} The builder (chainable).
       */
      line(x1, y1, x2, y2, options = {}) {
        ensurePage();
        const { width = 0.5 } = options;
        current.push(
          `${fmt(width)} w ` +
          `${fmt(x1)} ${fmt(PAGE_HEIGHT - y1)} m ` +
          `${fmt(x2)} ${fmt(PAGE_HEIGHT - y2)} l S`
        );
        return builder;
      },

      /**
       * Serialize the document to a complete PDF 1.4 file.
       *
       * Object layout: 1 = Catalog, 2 = Pages tree, 3 = /F1 Helvetica,
       * 4 = /F2 Helvetica-Bold, then one Page + one content stream per page.
       *
       * @returns {Uint8Array} The PDF file bytes.
       */
      build() {
        if (pages.length === 0) builder.addPage();

        const firstPageObj = 5; // objects 1-4 are catalog, pages tree, fonts
        const pageObjNums = pages.map((_, i) => firstPageObj + i * 2);

        // bodies[i] is the body of object number i + 1 (without obj/endobj).
        const bodies = [
          '<< /Type /Catalog /Pages 2 0 R >>',
          `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] ` +
            `/Count ${pages.length} >>`,
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ' +
            '/Encoding /WinAnsiEncoding >>',
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold ' +
            '/Encoding /WinAnsiEncoding >>'
        ];

        pages.forEach((ops, i) => {
          const contentObjNum = firstPageObj + i * 2 + 1;
          bodies.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
            '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> ' +
            `/Contents ${contentObjNum} 0 R >>`
          );
          const stream = ops.join('\n');
          // Stream data is ASCII-only (escapePdfString guarantees it), so
          // string length equals byte length.
          bodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
        });

        // Assemble the file. Everything below is Latin-1-safe, so string
        // indices equal byte offsets — required for a correct xref table.
        let pdf = '%PDF-1.4\n%âãÏÓ\n';
        const offsets = [0]; // offsets[n] = byte offset of object n
        bodies.forEach((body, idx) => {
          offsets.push(pdf.length);
          pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
        });

        const xrefStart = pdf.length;
        const objCount = bodies.length + 1; // + the free object 0
        pdf += `xref\n0 ${objCount}\n`;
        pdf += '0000000000 65535 f \n';
        for (let n = 1; n < objCount; n++) {
          pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
        }
        pdf += `trailer\n<< /Size ${objCount} /Root 1 0 R >>\n`;
        pdf += `startxref\n${xrefStart}\n%%EOF\n`;

        const bytes = new Uint8Array(pdf.length);
        for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
        return bytes;
      }
    };

    return builder;
  };

  return { createDocument, textWidth, PAGE_WIDTH, PAGE_HEIGHT };
})();
