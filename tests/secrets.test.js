import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const KEY_PATTERN = /sk-or-v1-[0-9a-f]{32,}/i;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function lines(text) {
  return text.split('\n').filter(Boolean);
}

/** Files on disk that are committed or could be committed: tracked plus untracked-not-ignored. */
function committableFiles() {
  const deleted = new Set(lines(git('ls-files', '--deleted')));
  return lines(git('ls-files', '--cached', '--others', '--exclude-standard')).filter(f => !deleted.has(f));
}

test('key pattern detects an OpenRouter-shaped key', () => {
  const fakeKey = 'sk-or-v1-' + '0123456789abcdef'.repeat(4);
  assert.match(`OPENROUTER_API_KEY=${fakeKey}`, KEY_PATTERN);
});

test('key pattern ignores the .env.example placeholder', () => {
  assert.doesNotMatch('OPENROUTER_API_KEY=sk-or-...', KEY_PATTERN);
});

test('no committable file contains an OpenRouter key', () => {
  const offenders = committableFiles().filter(f => KEY_PATTERN.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('.env, plan.md and issue.md are git-ignored', () => {
  const ignored = lines(git('check-ignore', '.env', 'plan.md', 'issue.md'));
  assert.deepEqual(ignored, ['.env', 'plan.md', 'issue.md']);
});
