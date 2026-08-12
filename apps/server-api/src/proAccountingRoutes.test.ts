import assert from 'node:assert/strict';
import test from 'node:test';
import { csvEscape } from './proAccountingRoutes.js';

test('DATEV CSV escaping protects semicolons, quotes, and line breaks', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('konto;gegenkonto'), '"konto;gegenkonto"');
  assert.equal(csvEscape('say "hello"'), '"say ""hello"""');
  assert.equal(csvEscape('line 1\nline 2'), '"line 1\nline 2"');
});
