import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from './helpers/batch-runner-fixture.mjs';

test('an explicit --parallel 1 keeps one worker', () => {
  const { stdout } = runBatch({ offers: 2, args: ['--parallel', '1'] });
  assert.match(stdout, /Parallel: 1 \|/);
});
