import { validateState } from './domain';
import type { FinancialState } from './domain.ts';

export function readBackup(input: unknown): FinancialState {
  const wrapped = input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'data');
  if (wrapped) {
    const envelope = input as Record<string, unknown>;
    if (!Number.isSafeInteger(envelope.revision) || Number(envelope.revision) < 0 || typeof envelope.updatedAt !== 'string') {
      throw new Error('Envelope de exportacao invalido.');
    }
  }
  const data = wrapped ? (input as Record<string, unknown>).data : input;
  validateState(data);
  return data;
}