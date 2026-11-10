import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanSuggestion } from '../src/index.js';

test('keeps a short plain prediction', () => {
  assert.equal(cleanSuggestion('Run the tests again.'), 'Run the tests again.');
});

test('strips wrapping quotes and a user label', () => {
  assert.equal(cleanSuggestion('  "User: continue with the migration"  '), 'continue with the migration');
  assert.equal(cleanSuggestion('用户：先跑一下单测'), '先跑一下单测');
});

test('unwraps a fenced block', () => {
  assert.equal(cleanSuggestion('```text\nplease continue\n```'), 'please continue');
});

test('collapses newlines for the inline ghost', () => {
  assert.equal(cleanSuggestion('first line\n\nsecond line'), 'first line second line');
});

test('caps the suggestion without cutting a word when possible', () => {
  const result = cleanSuggestion('alpha beta gamma delta epsilon zeta', 22);
  assert.ok(result.length <= 22);
  assert.equal(result, 'alpha beta gamma');
});

test('empty model output stays empty', () => {
  assert.equal(cleanSuggestion('   \n\t'), '');
  assert.equal(cleanSuggestion(null), '');
});
