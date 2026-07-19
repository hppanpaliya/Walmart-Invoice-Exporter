/**
 * CommonJS re-export of the original download-capture helper (see
 * tests/helpers/capture-downloads.js), mirroring helpers/sandbox.js: ported
 * tests keep using the exact same proven implementation and only change how
 * they import it.
 */
'use strict';

module.exports = require('../../tests/helpers/capture-downloads.js');
