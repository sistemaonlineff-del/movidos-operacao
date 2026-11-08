import Papa from 'papaparse';
import { parseDate, parseMoney, suggestedClassification, transactionKey } from './domain';
import type { FinancialState, Transaction } from './domain.ts';

export type ImportPreview = { rows: Transaction[]; duplicates: number; errors: string[]; total: number };
export function previewStatement(text: string, state: FinancialState, source: string): ImportPreview {
  const candidates = [';', ',', '\t'].map(delimiter => Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: false, delimiter }));
  const score = (result: typeof candidates[number]) => result.data.filter(row => row.length === 4 && (/^\d{2}\/\d{2}\/\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(row[0].trim()) || /data/i.test(row[0]))).length;
  const parsed = candidates.sort((left, right) => score(right) - score(left))[0];
  const result: ImportPreview = { rows: [], duplicates: 0, errors: [], total: 0 };
  if (parsed.errors.some(error => error.type === 'Quotes')) result.errors.push('Aspas invalidas no CSV.');
  const seen = new Set(state.transactions.map(transactionKey));
  let start = 6;
  const header = parsed.data.findIndex(row => /data/i.test(row[0] ?? '') && /descri|hist[oó]rico/i.test(row[1] ?? '') && /valor/i.test(row[2] ?? ''));
  if (header >= 0) start = header + 1;
  if (parsed.data.length <= start) result.errors.push('Extrato sem lancamentos. Esperado Data;Descricao;Valor;Saldo ou dados a partir da linha 7.');
  for (let index = start; index < parsed.data.length; index++) {
    const row = parsed.data[index];
    if (row.every(value => !value.trim())) continue;
    try {
      if (row.length < 4 || row.slice(4).some(value => value.trim())) throw new Error('Esperadas quatro colunas: data, descricao, valor, saldo.');
      const date = parseDate(row[0]);
      const description = row[1].trim();
      if (!description) throw new Error('Descricao obrigatoria.');
      const amount = parseMoney(row[2]);
      const balance = row[3].trim() ? parseMoney(row[3]) : null;
      const item: Transaction = { id: crypto.randomUUID(), date, description, amount, balance, ...suggestedClassification(description, state.transferNames), sourceRow: index + 1, source, order: index - start };
      const key = transactionKey(item);
      if (seen.has(key)) result.duplicates++;
      else { seen.add(key); result.rows.push(item); result.total += amount; }
    } catch (error) { result.errors.push(`Linha ${index + 1}: ${error instanceof Error ? error.message : 'Dados invalidos.'}`); }
  }
  return result;
}

export function mergeStatement(state: FinancialState, preview: ImportPreview): FinancialState {
  if (preview.errors.length) throw new Error('Corrija as linhas invalidas antes de importar.');
  const seen = new Set(state.transactions.map(transactionKey));
  if (preview.rows.some(item => seen.has(transactionKey(item)))) throw new Error('A base mudou desde a previa; importe o arquivo novamente.');
  return { ...state, transactions: [...preview.rows, ...state.transactions].sort((left, right) => right.date.localeCompare(left.date) || left.order - right.order) };
}

export function csvExport(rows: Record<string, unknown>[]): string {
  return '\uFEFF' + Papa.unparse(rows, { delimiter: ';', newline: '\r\n', escapeFormulae: true });
}