/**
 * `npm test`: run every tests/**\/*.test.js with node --test, and fail when there is none.
 * Tests are kept local and are not published, so on a fresh clone this must not report a pass.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function testFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter(f => f.endsWith('.test.js'))
    .map(f => join(dir, f))
    .sort();
}

const files = testFiles('tests');
if (files.length === 0) {
  console.error('No test files found under tests/. Tests are kept local and are not published in this repository.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
