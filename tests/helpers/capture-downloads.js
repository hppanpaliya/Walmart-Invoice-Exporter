/**
 * Captures the file(s) a sandboxed export converter "downloads" via
 * utils.js's downloadWorkbook()/downloadTextFile() (window.URL.createObjectURL
 * + an anchor click), so tests can inspect exactly what would have been
 * saved to disk.
 *
 * Why this exists: Node's real `URL.createObjectURL` (available since
 * Node 16.7) only accepts a real `Blob` instance, but tests/helpers/sandbox.js
 * stubs `Blob` with a plain constructor so it can run without DOM APIs. That
 * stub is never `instanceof` the host's real Blob, so the real
 * `URL.createObjectURL` throws. This module replaces window.URL with a
 * trivial in-memory map instead, keyed by a fake blob: URL, and records
 * every {filename, blob} pair as downloads happen (in call order).
 */
'use strict';

/**
 * Patch a loaded sandbox (see tests/helpers/sandbox.js) so downloads are
 * captured instead of attempted for real. Call once per sandbox, before
 * invoking any convert-or-download function.
 * @param {Object} sandbox - Sandbox returned by loadSandbox()
 * @returns {Array<{filename: string, blob: {parts: Array, opts: Object}}>}
 *   Live array; grows as downloads happen, in call order.
 */
function captureDownloads(sandbox) {
  const downloads = [];
  const blobsByUrl = new Map();
  let counter = 0;

  sandbox.window.URL = {
    createObjectURL(blob) {
      const url = `blob:mock-${++counter}`;
      blobsByUrl.set(url, blob);
      return url;
    },
    revokeObjectURL(url) {
      blobsByUrl.delete(url);
    },
  };

  const body = sandbox.document.body;
  const originalAppendChild = body.appendChild.bind(body);
  body.appendChild = (child) => {
    if (child && child.download && child.href && blobsByUrl.has(child.href)) {
      downloads.push({ filename: child.download, blob: blobsByUrl.get(child.href) });
    }
    return originalAppendChild(child);
  };

  return downloads;
}

/** Concatenate a captured blob's parts into a single Buffer (binary downloads, e.g. xlsx). */
function blobBuffer(blob) {
  const parts = (blob && blob.parts) || [];
  return Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
}

/** Concatenate a captured blob's parts into a single UTF-8 string (text downloads: csv/json/html). */
function blobText(blob) {
  const parts = (blob && blob.parts) || [];
  return parts.map((part) => (typeof part === 'string' ? part : Buffer.from(part).toString('utf8'))).join('');
}

module.exports = { captureDownloads, blobBuffer, blobText };
