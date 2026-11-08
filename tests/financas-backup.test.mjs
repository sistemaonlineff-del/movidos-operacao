import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../src/financas/domain.ts';
import { readBackup } from '../src/financas/backup.ts';
test('restauracao aceita estado e envelope da fonte sem transformar valores ou revisao', () => {
  const data = emptyState();
  data.projection.opening = -12345;
  assert.equal(readBackup(data), data);
  assert.equal(readBackup({ revision: 72, data, updatedAt: '2026-11-08T12:00:00Z' }), data);
  assert.equal(readBackup(data).projection.opening, -12345);
});
test('restauracao rejeita envelope incompleto e payload invalido', () => {
  for (const data of [null, [], { data: emptyState() }, { revision: null, data: emptyState(), updatedAt: '' }, { revision: 0, data: {}, updatedAt: '' }, { ...emptyState(), schemaVersion: 2 }]) assert.throws(() => readBackup(data));
});