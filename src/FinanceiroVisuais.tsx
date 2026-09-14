import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase";
import {
  buildDetails,
  buildTotals,
  DataRow,
  date,
  key,
  money,
  notes,
  number,
  periodOrder,
  round,
  text,
} from "./financialData";
import { readFinancialRows as allRows } from "./financialStore";
import CnabUpload from "./CnabUpload";
import ClosingEmails from "./ClosingEmails";

type Kind = "total" | "details" | "losses" | "cnab";
const options = (values: unknown[]) =>
  [...new Set(values.map(text).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
const sum = (rows: DataRow[], field: string) =>
  round(rows.reduce((total, row) => total + number(row[field]), 0));
const totalColumns = [
  ["gross", "Valor bruto a receber"],
  ["w2d", "Subtotal extravio W2D"],
  ["d2d", "Subtotal extravio D2D"],
  ["loss", "Total de extravios"],
  ["reimbursement", "Reembolso erro iMile"],
  ["net", "Total líquido a receber"],
  ["payable", "Valor total que será pago para os DROPs"],
  ["deducted", "Extravio efetivamente descontado dos DROPs"],
  ["assumed", "Prejuízo que eu assumi e não descontei dos DROPs"],
  ["companyPayment", "Pagamento para Talita e Jorge"],
];
const detailFields = [
  ["period", "Período", "text"],
  ["drop", "DROP", "text"],
  ["partner", "Parceiro", "text"],
  ["packageType", "Tipo pacote", "text"],
  ["packages", "Total pacote", "number"],
  ["unit", "Valor acordado", "number"],
  ["subtotal", "Subtotal", "number"],
  ["w2d", "Extravio W2D", "number"],
  ["d2d", "Extravio D2D", "number"],
  ["loss", "Total extravio", "number"],
  ["reimbursement", "Reembolso iMile", "number"],
  ["receivable", "Total a receber", "number"],
  ["paymentDate", "Data pagamento", "date"],
  ["pix", "PIX", "text"],
];
const cnabFields = [
  ["drop", "DROP", "text"],
  ["responsible", "RESPONSÁVEL", "text"],
  ["receivable", "TOTAL DROP", "number"],
  ["pix", "PIX", "text"],
  ["paymentDate", "DATA PAGAMENTO", "date"],
  ["document", "CPF/CNPJ", "text"],
];

export default function FinanceiroVisuais({ kind }: { kind: Kind }) {
  return kind === "cnab" ? (
    <CnabUpload />
  ) : (
    <FinanceiroVisualPage kind={kind} />
  );
}

function FinanceiroVisualPage({ kind }: { kind: Kind }) {
  const [periods, setPeriods] = useState<DataRow[]>([]),
    [views, setViews] = useState<DataRow[]>([]),
    [history, setHistory] = useState<DataRow[]>([]),
    [items, setItems] = useState<DataRow[]>([]),
    [losses, setLosses] = useState<DataRow[]>([]),
    [drops, setDrops] = useState<DataRow[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [periodFilter, setPeriodFilter] = useState(""),
    [partnerFilter, setPartnerFilter] = useState(""),
    [dropFilter, setDropFilter] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [observationFilter, setObservationFilter] = useState("");
  const [editing, setEditing] = useState<DataRow | null>(null),
    [editingLoss, setEditingLoss] = useState<DataRow | null>(null),
    [saving, setSaving] = useState(false),
    [editError, setEditError] = useState(""),
    [generating, setGenerating] = useState(false),
    [generatingCnab, setGeneratingCnab] = useState(false);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [p, v, h, i, l, d] = await Promise.all(
        [
          "financial_periods",
          "financial_views",
          "financial_payment_history",
          "financial_drop_items",
          "loss_events",
          "drops",
        ].map(allRows),
      );
      setPeriods(p);
      setViews(v);
      setHistory(h);
      setItems(i);
      setLosses(l);
      setDrops(d);
    } catch (caught) {
      setError(
        text((caught as Error).message) ||
          "Não foi possível carregar os dados financeiros.",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    setEditing(null);
    setEditingLoss(null);
    setDropFilter("");
    setStatusFilter("");
    setObservationFilter("");
  }, [kind]);
  const periodById = useMemo(
    () => new Map(periods.map((row) => [row.id, row])),
    [periods],
  );
  const details = useMemo(
    () => buildDetails(history, items, losses, periods, drops),
    [history, items, losses, periods, drops],
  );
  const filteredDetails = useMemo(
    () =>
      details.filter(
        (row) =>
          (!periodFilter || row.period === periodFilter) &&
          (!partnerFilter || row.partner === partnerFilter) &&
          (!dropFilter || key(row.drop) === dropFilter),
      ),
    [details, periodFilter, partnerFilter, dropFilter],
  );
  const filteredLosses = useMemo(
    () =>
      losses
        .filter((row) => {
          const period = periodById.get(row.financial_period_id);
          return (
            (!periodFilter ||
              (row.period_label ?? period?.label) === periodFilter) &&
            (!partnerFilter ||
              (row.partner ?? period?.partner) === partnerFilter) &&
            (!dropFilter || key(row.drop_name_snapshot) === dropFilter) &&
            (!statusFilter || row.status === statusFilter) &&
            (!observationFilter ||
              key(row.observation).includes(key(observationFilter)))
          );
        })
        .sort((a, b) => text(b.received_at).localeCompare(text(a.received_at))),
    [
      losses,
      periodById,
      periodFilter,
      partnerFilter,
      dropFilter,
      statusFilter,
      observationFilter,
    ],
  );
  const totals = useMemo(
    () =>
      buildTotals(details, losses, periods, views, periodFilter, partnerFilter),
    [details, losses, periods, views, periodFilter, partnerFilter],
  );
  const periodOptions = options([
    ...periods.map((row) => row.label),
    ...details.map((row) => row.period),
    ...losses.map((row) => row.period_label),
  ]).sort((a, b) => periodOrder(a) - periodOrder(b));
  const partnerOptions = options([
    ...periods.map((row) => row.partner),
    ...details.map((row) => row.partner),
    ...losses.map((row) => row.partner),
  ]);
  const dropOptions = options([
    ...details.map((row) => row.drop),
    ...losses.map((row) => row.drop_name_snapshot),
  ]).reduce(
    (all, drop) => (all.has(key(drop)) ? all : all.set(key(drop), drop)),
    new Map<string, string>(),
  );
  const report = async (rows: DataRow[]) => {
    setGenerating(true);
    setError("");
    try {
      await (
        await import("./financialReport")
      ).downloadClosingPdf(rows, losses, periods);
      setMessage("Relatório de fechamento gerado.");
    } catch (caught) {
      setError(
        (caught as Error).message || "Não foi possível gerar o relatório.",
      );
    } finally {
      setGenerating(false);
    }
  };
  const cnab = async () => {
    setGeneratingCnab(true);
    setError("");
    setMessage("");
    try {
      if (!periodFilter || !partnerFilter)
        throw new Error(
          "Selecione um período e um parceiro antes de gerar o CNAB.",
        );
      const count = (await import("./cnabInter")).downloadCnabInter(
        filteredDetails,
      );
      setMessage(`CNAB gerado com ${count} pagamento(s).`);
    } catch (caught) {
      setError((caught as Error).message || "Não foi possível gerar o CNAB.");
    } finally {
      setGeneratingCnab(false);
    }
  };
  const saveDetail = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !supabase) return;
    setSaving(true);
    setEditError("");
    try {
      if (
        ![editing.period, editing.partner, editing.drop].every((value) =>
          text(value),
        )
      )
        throw new Error("Informe período, parceiro e DROP.");
      if (
        !Number.isInteger(number(editing.packages)) ||
        number(editing.packages) < 0
      )
        throw new Error(
          "A quantidade de pacotes deve ser um inteiro positivo ou zero.",
        );
      const originalPeriod = periodById.get(editing.periodId);
      let period = periods.find(
        (row) =>
          row.label === text(editing.period) &&
          row.partner === text(editing.partner) &&
          row.financial_view_id === originalPeriod?.financial_view_id,
      );
      if (!period) {
        const result = await supabase
          .from("financial_periods")
          .insert({
            label: text(editing.period),
            partner: text(editing.partner),
            financial_view_id: originalPeriod?.financial_view_id ?? null,
            status: "aberto",
          })
          .select()
          .single();
        if (result.error) throw result.error;
        period = result.data;
      }
      const previous = notes(editing.raw.observation);
      const observation = JSON.stringify({
        ...previous,
        originalObservation:
          previous.originalObservation ??
          (Object.keys(previous).length ? undefined : editing.raw.observation),
        movidosClosing: {
          ...previous.movidosClosing,
          sourceItemId: editing.sourceItemId,
          packageType: text(editing.packageType),
          w2d: number(editing.w2d),
          d2d: number(editing.d2d),
        },
      });
      const payload = {
        financial_period_id: period!.id,
        period_label: text(editing.period),
        partner: text(editing.partner),
        drop_name_snapshot: text(editing.drop),
        responsible: text(editing.responsible) || null,
        package_quantity: number(editing.packages),
        amount: number(editing.unit),
        subtotal: number(editing.subtotal),
        loss_amount: number(editing.loss),
        reimbursement: number(editing.reimbursement),
        total_receivable: number(editing.receivable),
        paid_at: editing.paymentDate
          ? `${text(editing.paymentDate).slice(0, 10)}T12:00:00-03:00`
          : null,
        pix_key: text(editing.pix) || null,
        observation,
      };
      const result =
        editing.source === "history"
          ? await supabase
              .from("financial_payment_history")
              .update(payload)
              .eq("id", editing.id)
              .select("id")
              .single()
          : await supabase
              .from("financial_payment_history")
              .insert(payload)
              .select("id")
              .single();
      if (result.error) throw result.error;
      setEditing(null);
      setMessage("Fechamento atualizado.");
      await load();
    } catch (caught) {
      setEditError(
        (caught as Error).message || "Não foi possível salvar o fechamento.",
      );
    } finally {
      setSaving(false);
    }
  };
  const saveLoss = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingLoss || !supabase) return;
    setSaving(true);
    setEditError("");
    try {
      const { error } = await supabase
        .from("loss_events")
        .update({
          amount: number(editingLoss.amount),
          observation: editingLoss.observation || null,
        })
        .eq("id", editingLoss.id)
        .select("id")
        .single();
      if (error) throw error;
      setEditingLoss(null);
      setMessage("Extravio atualizado.");
      await load();
    } catch (caught) {
      setEditError(
        (caught as Error).message || "Não foi possível salvar o extravio.",
      );
    } finally {
      setSaving(false);
    }
  };
  const changeDetail = (field: string, value: string) =>
    setEditing((previous) => {
      if (!previous) return previous;
      const next = { ...previous, [field]: value };
      if (field === "packages" || field === "unit")
        next.subtotal = round(number(next.packages) * number(next.unit));
      if (field === "w2d" || field === "d2d")
        next.loss = round(
          number(previous.loss) + number(value) - number(previous[field]),
        );
      if (
        [
          "packages",
          "unit",
          "subtotal",
          "w2d",
          "d2d",
          "loss",
          "reimbursement",
        ].includes(field)
      )
        next.receivable = round(
          number(next.subtotal) -
            number(next.loss) +
            number(next.reimbursement),
        );
      return next;
    });
  const title =
    kind === "total"
      ? "Pagamento Total"
      : kind === "details"
        ? "Pagamento Detalhes"
        : kind === "cnab"
          ? "Gerar CNAB"
          : "Extravios";
  return (
    <section className="finance-visual-page">
      <section className="card visual-heading">
        <div>
          <p className="eyebrow">FINANCEIRO</p>
          <h2>{title}</h2>
          <p>
            {kind === "total"
              ? "Consolidado por período e pagamento para Talita e Jorge."
              : kind === "details"
                ? "Fechamento por DROP com valores, extravios e total a receber."
                : kind === "cnab"
                  ? "Confira os pagamentos antes de gerar o arquivo. Selecione um período e um parceiro."
                  : "Ocorrências de extravio e total dos filtros selecionados."}
          </p>
        </div>
        <div className="financial-actions">
          {kind === "details" && (
            <button
              className="secondary"
              disabled={loading || generating || !filteredDetails.length}
              onClick={() => void report(filteredDetails)}
            >
              {generating ? "Gerando PDF…" : "Gerar relatório de fechamento"}
            </button>
          )}
          {kind === "cnab" && (
            <button
              className="secondary"
              disabled={loading || generatingCnab || !filteredDetails.length}
              onClick={() => void cnab()}
            >
              {generatingCnab ? "Gerando CNAB…" : "Gerar CNAB"}
            </button>
          )}
          <button
            className="secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Atualizando…" : "Atualizar dados"}
          </button>
        </div>
      </section>
      <section className="card visual-filters">
        <Filter
          label="Período"
          value={periodFilter}
          set={setPeriodFilter}
          values={periodOptions}
          all="Todos os períodos"
        />
        <Filter
          label="Parceiro"
          value={partnerFilter}
          set={setPartnerFilter}
          values={partnerOptions}
          all="Todos os parceiros"
        />
        {kind !== "total" && (
          <label>
            DROP
            <select
              aria-label="DROP"
              value={dropFilter}
              onChange={(event) => setDropFilter(event.target.value)}
            >
              <option value="">Todos os drops</option>
              {[...dropOptions].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "losses" && (
          <>
            <Filter
              label="Status"
              value={statusFilter}
              set={setStatusFilter}
              values={options(losses.map((row) => row.status))}
              all="Todos os status"
            />
            <label>
              Observações
              <input
                value={observationFilter}
                onChange={(event) => setObservationFilter(event.target.value)}
                placeholder="Buscar nas observações"
              />
            </label>
          </>
        )}
        {(periodFilter ||
          partnerFilter ||
          dropFilter ||
          statusFilter ||
          observationFilter) && (
          <button
            className="secondary"
            onClick={() => {
              setPeriodFilter("");
              setPartnerFilter("");
              setDropFilter("");
              setStatusFilter("");
              setObservationFilter("");
            }}
          >
            Limpar filtros
          </button>
        )}
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="form-message">
          {message}
        </p>
      )}
      {loading ? (
        <section className="card empty">Carregando dados da base…</section>
      ) : error && !periods.length ? null : kind === "total" ? (
        <PaymentTotal rows={totals} />
      ) : kind === "details" ? (
        <PaymentDetails
          rows={filteredDetails}
          onEdit={(row) => {
            setEditError("");
            setEditing({
              ...row,
              paymentDate: text(row.paymentDate).slice(0, 10),
            });
          }}
          onReport={(row) => void report([row])}
          generating={generating}
        />
      ) : kind === "cnab" ? (
        <CnabDetails rows={filteredDetails} />
      ) : (
        <Losses
          rows={filteredLosses}
          periodById={periodById}
          onEdit={(row) => {
            setEditError("");
            setEditingLoss({ ...row });
          }}
        />
      )}
      {kind === "details" && (
        <ClosingEmails
          rows={filteredDetails}
          losses={losses}
          periods={periods}
          period={periodFilter}
          partner={partnerFilter}
        />
      )}
      {editing && (
        <Editor
          title="Editar fechamento"
          onClose={() => !saving && setEditing(null)}
          onSubmit={saveDetail}
          saving={saving}
          error={editError}
        >
          <div className="form-grid">
            {[...detailFields, ["responsible", "Responsável", "text"]].map(
              ([field, label, type]) => (
                <label key={field}>
                  {label}
                  <input
                    autoFocus={field === "period"}
                    required={
                      ["period", "drop", "partner"].includes(field) ||
                      type === "number"
                    }
                    type={type}
                    step={field === "packages" ? "1" : "0.01"}
                    min={field === "packages" ? 0 : undefined}
                    value={editing[field] ?? ""}
                    onChange={(event) =>
                      changeDetail(field, event.target.value)
                    }
                  />
                </label>
              ),
            )}
          </div>
          <p className="financial-hint">
            Quantidade e valor acordado recalculam o subtotal. Extravios e
            reembolso recalculam o total a receber. Você também pode ajustar os
            totais manualmente.
          </p>
        </Editor>
      )}
      {editingLoss && (
        <Editor
          title="Editar extravio"
          onClose={() => !saving && setEditingLoss(null)}
          onSubmit={saveLoss}
          saving={saving}
          error={editError}
        >
          <div className="form-grid">
            <label>
              Valor do extravio
              <input
                autoFocus
                type="number"
                step="0.01"
                required
                value={editingLoss.amount}
                onChange={(event) =>
                  setEditingLoss({ ...editingLoss, amount: event.target.value })
                }
              />
            </label>
            <label>
              Observações
              <textarea
                value={editingLoss.observation ?? ""}
                onChange={(event) =>
                  setEditingLoss({
                    ...editingLoss,
                    observation: event.target.value,
                  })
                }
              />
            </label>
          </div>
        </Editor>
      )}
    </section>
  );
}
function Filter({
  label,
  value,
  set,
  values,
  all,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  values: string[];
  all: string;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => set(event.target.value)}
      >
        <option value="">{all}</option>
        {values.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}
function Editor({
  title,
  children,
  onClose,
  onSubmit,
  saving,
  error,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  saving: boolean;
  error: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="financial-editor"
      aria-labelledby="financial-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form onSubmit={onSubmit}>
        <div className="modal-title">
          <h2 id="financial-editor-title">{title}</h2>
          <button
            type="button"
            disabled={saving}
            aria-label="Fechar edição"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <fieldset disabled={saving}>{children}</fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={onClose}>
            Cancelar
          </button>
          <button className="primary compact" disabled={saving}>
            {saving ? "Salvando…" : "Salvar alterações"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function PaymentTotal({ rows }: { rows: DataRow[] }) {
  return (
    <section className="card">
      {rows.some((row) => row.estimated) && (
        <p className="financial-hint">
          Períodos sem valor de nota importado usam a estimativa de R$ 0,25 por
          pacote, descontados os extravios. O filtro por parceiro mostra apenas
          sua parcela estimada.
        </p>
      )}
      <p className="financial-hint">
        Pagamento para Talita e Jorge = total líquido a receber − pagamento aos
        drops + reembolso erro iMile.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Período</th>
              {totalColumns.map(([field, title]) => (
                <th key={field}>{title}</th>
              ))}
              <th>Data do pagamento</th>
            </tr>
          </thead>
          <tbody>
            <tr className="financial-totals">
              <th scope="row">Total filtrado</th>
              {totalColumns.map(([field]) => (
                <td key={field}>{money(sum(rows, field))}</td>
              ))}
              <td />
            </tr>
            {rows.map((row) => (
              <tr key={row.period}>
                <td>
                  <strong>{row.period}</strong>
                  {row.estimated && (
                    <small className="table-subtitle">Receita estimada</small>
                  )}
                </td>
                {totalColumns.map(([field]) => (
                  <td
                    key={field}
                    className={
                      ["loss", "assumed"].includes(field) ||
                      number(row[field]) < 0
                        ? "loss-value"
                        : field === "companyPayment"
                          ? "positive-value"
                          : ""
                    }
                  >
                    {money(row[field])}
                  </td>
                ))}
                <td>
                  {row.paymentDate
                    ? row.paymentDate.split(", ").map(date).join(", ")
                    : "—"}
                </td>
              </tr>
            ))}
            {!rows.length && <EmptyRow columns={12} />}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function PaymentDetails({
  rows,
  onEdit,
  onReport,
  generating,
}: {
  rows: DataRow[];
  onEdit: (row: DataRow) => void;
  onReport: (row: DataRow) => void;
  generating: boolean;
}) {
  return (
    <section className="card">
      {rows.some((row) => row.splitAllocated) && (
        <p className="financial-hint">
          Extravios W2D e D2D de um mesmo drop e período foram rateados entre
          suas linhas. Os totais de fechamento permanecem os registrados; a
          divisão pode ser ajustada em Editar.
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {detailFields.map(([field, title]) => (
                <th key={field}>{title}</th>
              ))}
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            <tr className="financial-totals">
              <th scope="row" colSpan={4}>
                Total filtrado · {rows.length} registro(s)
              </th>
              <td>{sum(rows, "packages").toLocaleString("pt-BR")}</td>
              <td aria-label="Valor unitário não totalizado">—</td>
              {[
                "subtotal",
                "w2d",
                "d2d",
                "loss",
                "reimbursement",
                "receivable",
              ].map((field) => (
                <td key={field}>{money(sum(rows, field))}</td>
              ))}
              <td colSpan={3} />
            </tr>
            {rows.map((row) => (
              <tr key={`${row.source}-${row.id}`}>
                {detailFields.map(([field, , type]) => (
                  <td
                    key={field}
                    className={
                      field === "loss"
                        ? "loss-value"
                        : field === "receivable"
                          ? "positive-value"
                          : ""
                    }
                  >
                    {field === "drop" ? (
                      <>
                        <strong>{row.drop}</strong>
                        {row.responsible && (
                          <small className="table-subtitle">
                            {row.responsible}
                          </small>
                        )}
                      </>
                    ) : field === "packages" ? (
                      row.packages.toLocaleString("pt-BR")
                    ) : type === "number" ? (
                      money(row[field])
                    ) : type === "date" ? (
                      date(row[field])
                    ) : (
                      row[field] || "—"
                    )}
                  </td>
                ))}
                <td>
                  <div className="financial-actions">
                    <button
                      className="table-action"
                      onClick={() => onEdit(row)}
                    >
                      Editar
                    </button>
                    <button
                      className="table-action"
                      disabled={generating}
                      onClick={() => onReport(row)}
                    >
                      Gerar PDF
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <EmptyRow columns={15} />}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function CnabDetails({ rows }: { rows: DataRow[] }) {
  return (
    <section className="card">
      <div className="table-wrap">
        <table className="cnab-table">
          <thead>
            <tr>
              {cnabFields.map(([field, title]) => (
                <th key={field}>{title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.source}-${row.id}`}>
                {cnabFields.map(([field, , type]) => (
                  <td key={field}>
                    {type === "number"
                      ? money(row[field])
                      : type === "date"
                        ? date(row[field])
                        : row[field] || "—"}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && <EmptyRow columns={6} />}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function Losses({
  rows,
  periodById,
  onEdit,
}: {
  rows: DataRow[];
  periodById: Map<string, DataRow>;
  onEdit: (row: DataRow) => void;
}) {
  return (
    <section className="card">
      <div className="financial-loss-total" role="status">
        <span>{rows.length} extravio(s) nos filtros selecionados</span>
        <strong>Total: {money(sum(rows, "amount"))}</strong>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {[
                "Período",
                "Scan station / DROP",
                "Waybill nº",
                "Código da etiqueta",
                "Saca",
                "Status",
                "Seller",
                "Recebimento",
                "Valor",
                "Observações",
                "Ação",
              ].map((title) => (
                <th key={title}>{title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const period = periodById.get(row.financial_period_id);
              return (
                <tr key={row.id}>
                  <td>{row.period_label ?? period?.label ?? "—"}</td>
                  <td>
                    <strong>{row.drop_name_snapshot ?? "—"}</strong>
                    <small className="table-subtitle">
                      {row.partner ?? period?.partner ?? ""}
                    </small>
                  </td>
                  {[
                    "waybill",
                    "label_code",
                    "bag_code",
                    "status",
                    "seller",
                  ].map((field) => (
                    <td key={field}>{row[field] || "—"}</td>
                  ))}
                  <td>
                    {row.received_at
                      ? new Date(row.received_at).toLocaleString("pt-BR")
                      : "—"}
                  </td>
                  <td className="loss-value">{money(row.amount)}</td>
                  <td>{row.observation || "—"}</td>
                  <td>
                    <button
                      className="table-action"
                      onClick={() => onEdit(row)}
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              );
            })}
            {!rows.length && <EmptyRow columns={11} />}
          </tbody>
          <tfoot>
            <tr className="financial-totals">
              <th scope="row" colSpan={8}>
                Total filtrado
              </th>
              <td>{money(sum(rows, "amount"))}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
function EmptyRow({ columns }: { columns: number }) {
  return (
    <tr>
      <td colSpan={columns} className="empty">
        Nenhum registro encontrado para os filtros selecionados.
      </td>
    </tr>
  );
}
