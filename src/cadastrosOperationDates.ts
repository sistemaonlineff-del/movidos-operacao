export type OperationDatesRow = {
  id: string;
  legacy_id: number | null;
  name: string;
  responsible: string | null;
  partner: string | null;
  operation_started_at: string | null;
  operation_ended_at: string | null;
  updated_at: string;
};

export const operationDateFields = [
  ["operation_started_at", "Início da operação"],
  ["operation_ended_at", "Fim da operação"],
] as const;
export type OperationDateField = typeof operationDateFields[number][0];
export type OperationDateChanges = Partial<Record<OperationDateField, string>>;

export function operationDatesPlan(rows: OperationDatesRow[], changes: OperationDateChanges, onlyEmpty: boolean) {
  if (!rows.length) throw new Error("Selecione pelo menos um cadastro.");
  if (!operationDateFields.some(([field]) => field in changes)) throw new Error("Marque pelo menos uma data para alterar.");
  for (const [field, label] of operationDateFields) {
    if (!(field in changes)) continue;
    const value = changes[field] ?? "";
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000") || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error(`Informe uma data válida em ${label}.`);
    }
  }
  return rows.map(row => {
    if (!row.id || !row.updated_at) throw new Error("Atualize a lista antes de editar: cadastro sem versão.");
    const payload: OperationDateChanges = {};
    for (const [field] of operationDateFields) {
      if (field in changes && (!onlyEmpty || !row[field]) && row[field] !== changes[field]) payload[field] = changes[field];
    }
    const start = payload.operation_started_at ?? row.operation_started_at;
    const end = payload.operation_ended_at ?? row.operation_ended_at;
    if (Object.keys(payload).length && start && end && end < start) {
      throw new Error(`O fim da operação não pode ser anterior ao início: ${row.name || "Sem nome"} (ID ${row.legacy_id ?? row.id}).`);
    }
    return { row, payload, start, end };
  });
}
