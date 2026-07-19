/**
 * tests-vitest/ is the incremental Vitest port of the node:test suites in
 * tests/. Ported tests share the exact same proven VM-sandbox helper — this
 * file is just a thin CommonJS re-export so ports only change their `test`
 * import, nothing else.
 */
'use strict';

module.exports = require('../../tests/helpers/sandbox.js');
