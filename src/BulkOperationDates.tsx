import { useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import { useAccess } from "./access";
import { operationDateFields, operationDatesPlan, type OperationDateChanges, type OperationDatesRow } from "./cadastrosOperationDates";

export default function BulkOperationDates({ rows, onClose }: { rows: OperationDatesRow[]; onClose: (attempted: boolean) => void }) {
  const { can } = useAccess();
  const dialog = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [changes, setChanges] = useState<OperationDateChanges>({ operation_started_at: "" });
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  let plan: ReturnType<typeof operationDatesPlan> = [];
  let validation = "";
  try { plan = operationDatesPlan(rows, changes, onlyEmpty); }
  catch (caught) { validation = caught instanceof Error ? caught.message : "Não foi possível validar as datas."; }
  const affected = plan.filter(entry => Object.keys(entry.payload).length);
  const close = () => { if (!savingRef.current) onClose(attempted); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current || attempted) return;
    setError("");
    if (!can("cadastros_edit")) { setError("Sem permissão para editar cadastros."); return; }
    if (!supabase) { setError("Não foi possível conectar ao sistema."); return; }
    if (validation || !affected.length || !confirmed) { setError(validation || "Confira as alterações e confirme o lote."); return; }
    savingRef.current = true;
    setSaving(true);
    setAttempted(true);
    let completed = 0;
    let current = "";
    try {
      for (const { row, payload } of affected) {
        current = `${row.name || "Sem nome"} (ID ${row.legacy_id ?? row.id})`;
        // Compare the version shown in the preview, not a freshly fetched version.
        const result = await supabase.from("drops").update(payload).eq("id", row.id).eq("updated_at", row.updated_at)
          .select("id,operation_started_at,operation_ended_at").single();
        if (result.error) throw new Error(result.error.code === "PGRST116" ? "O cadastro mudou ou está indisponível para edição. Atualize a lista." : result.error.message);
        if (result.data?.id !== row.id || operationDateFields.some(([field]) => field in payload && result.data[field] !== payload[field])) {
          throw new Error("O banco não confirmou as datas. O cadastro pode ter mudado ou sua permissão pode ter sido revogada.");
        }
        completed++;
        setMessage(`${completed} de ${affected.length} cadastro(s) atualizado(s).`);
      }
      setMessage(`${completed} cadastro(s) atualizado(s) com sucesso. ${rows.length - affected.length} sem alteração.`);
    } catch (caught) {
      setError(`${completed} de ${affected.length} gravações confirmadas. Lote interrompido em ${current}: ${caught instanceof Error ? caught.message : "Falha ao salvar."} Feche e confira a lista antes de selecionar novamente; a última tentativa pode ter sido gravada. As gravações anteriores não foram desfeitas.`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const date = (value: string | null) => value ? value.split("-").reverse().join("/") : "Em branco";
  return (
    <dialog ref={dialog} className="bulk-operation-dates" aria-labelledby="bulk-dates-title" onCancel={event => { event.preventDefault(); close(); }}>
      <form onSubmit={event => void save(event)}>
        <h2 id="bulk-dates-title">Alterar datas em massa</h2>
        <p>{rows.length} cadastro(s) selecionado(s). As datas são da operação, não do fechamento. Para quem continua operando, não marque o fim.</p>
        <fieldset disabled={saving || attempted}>
          {operationDateFields.map(([field, label]) => (
            <div className="bulk-date-field" key={field}>
              <label><input type="checkbox" checked={field in changes} onChange={event => {
                setChanges(previous => { const next = { ...previous }; if (event.target.checked) next[field] = ""; else delete next[field]; return next; });
                setConfirmed(false);
              }} />Alterar {label.toLowerCase()}</label>
              <input aria-label={label} type="date" required={field in changes} disabled={!(field in changes)} value={changes[field] ?? ""} onChange={event => { setChanges(previous => ({ ...previous, [field]: event.target.value })); setConfirmed(false); }} />
            </div>
          ))}
          <label><input type="checkbox" checked={onlyEmpty} onChange={event => { setOnlyEmpty(event.target.checked); setConfirmed(false); }} />Preencher somente datas vazias</label>
          {!onlyEmpty && <p className="error">As datas já preenchidas nos campos marcados serão substituídas.</p>}
        </fieldset>
        {validation && <p role="alert" className="error">{validation}</p>}
        {!validation && <>
          <p>{affected.length} cadastro(s) serão alterados; {rows.length - affected.length} permanecerão iguais.</p>
          <div className="table-wrap">
            <table aria-label="Prévia das datas">
              <thead><tr><th>ID / Drop</th><th>Parceiro / Responsável</th><th>Início: atual → novo</th><th>Fim: atual → novo</th></tr></thead>
              <tbody>{plan.map(({ row, start, end }) => <tr key={row.id}>
                <td>{row.legacy_id ?? row.id} · {row.name || "Sem nome"}</td>
                <td>{row.partner || "—"} · {row.responsible || "—"}</td>
                <td>{date(row.operation_started_at)} → {date(start)}</td>
                <td>{date(row.operation_ended_at)} → {date(end)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </>}
        <label className="bulk-dates-confirm"><input type="checkbox" disabled={saving || attempted || !!validation || !affected.length} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confirmo aplicar as datas aos {affected.length} cadastros indicados na prévia</label>
        {message && <p role="status">{message}</p>}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="bulk-dates-actions">
          <button type="button" className="secondary" disabled={saving} onClick={close}>{attempted ? "Fechar e atualizar lista" : "Cancelar"}</button>
          <button type="submit" className="primary" disabled={saving || attempted || !confirmed || !!validation || !affected.length || !can("cadastros_edit")}>{saving ? "Salvando…" : `Aplicar em ${affected.length} cadastros`}</button>
        </div>
      </form>
    </dialog>
  );
}
