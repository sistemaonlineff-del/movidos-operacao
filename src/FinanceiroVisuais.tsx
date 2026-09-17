import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase";
import {
  buildDetails,
  buildTotals,
  financialPartner,
  DataRow,
  date,
  key,
  lossBatchPayloads,
  lossEditableFields,
  lossEditorValues,
  lossEventPayload,
  money,
  notes,
  number,
  periodOrder,
  paymentTotalTarget,
  paymentDetailFields as detailFields,
  round,
  text,
} from "./financialData";
import { readFinancialRows as allRows } from "./financialStore";
import CnabUpload from "./CnabUpload";
import ClosingEmails from "./ClosingEmails";
import { PARTNERS } from "./dropOptions";
import { useAccess } from "./access";

type Kind = "total" | "details" | "losses" | "cnab";
const options = (values: unknown[]) =>
  [...new Set(values.map(text).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true }),
  );
const referenceCnpjs = ["JOTA EXPRESS", "MOVIDOS", "BELLY"];
const lossColumns = [
  ["period", "Período"], ["drop", "Scan station / DROP"],
  ["waybill", "Waybill nº"], ["label_code", "Código da etiqueta"],
  ["bag_code", "Saca"], ["status", "Status"], ["seller", "Seller"],
  ["received_at", "Recebimento"], ["amount", "Valor"], ["observation", "Observações"],
];
const lossColumnValue = (row: DataRow, field: string, period?: DataRow) => {
  if (field === "period") return row.period_label ?? period?.label ?? "";
  if (field === "drop") return `${text(row.drop_name_snapshot)} ${text(row.partner ?? period?.partner)}`;
  if (field === "received_at") return row.received_at ? `${new Date(row.received_at).toLocaleString("pt-BR")} ${text(row.received_at)}` : "";
  if (field === "amount") return `${money(row.amount)} ${number(row.amount).toFixed(2)} ${number(row.amount).toFixed(2).replace(".", ",")}`;
  return text(row[field]);
};
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
  const { can, profile } = useAccess();
  const canEditTotal = profile?.is_active === true && can("financeiro_manage");
  const lossSaving = useRef(false);
  const lossOriginal = useRef<DataRow | null>(null);
  const lossInsertId = useRef("");
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
  const [lossColumnFilters, setLossColumnFilters] = useState<Record<string, string>>({});
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [selectedLossIds, setSelectedLossIds] = useState<Set<string>>(new Set());
  const [bulkLosses, setBulkLosses] = useState<DataRow[] | null>(null);
  const [bulkChanges, setBulkChanges] = useState<DataRow>({});
  const [bulkConfirmed, setBulkConfirmed] = useState(false);
  const [bulkAttempted, setBulkAttempted] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(0);
  const [editing, setEditing] = useState<DataRow | null>(null),
    [editingTotal, setEditingTotal] = useState<DataRow | null>(null),
    [editingLoss, setEditingLoss] = useState<DataRow | null>(null),
    [saving, setSaving] = useState(false),
    [editError, setEditError] = useState(""),
    [generating, setGenerating] = useState(false),
    [generatingCnab, setGeneratingCnab] = useState(false);
  const load = async () => {
    setLoading(true);
    setSelectedLossIds(new Set());
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
    setEditingTotal(null);
    setEditingLoss(null);
    setBulkLosses(null);
    setSelectedLossIds(new Set());
    setDropFilter("");
    setStatusFilter("");
    setObservationFilter("");
    setLossColumnFilters({});
    setDuplicatesOnly(false);
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
  const waybillCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of losses) {
      const waybill = key(row.waybill);
      if (waybill) counts.set(waybill, (counts.get(waybill) ?? 0) + 1);
    }
    return counts;
  }, [losses]);
  const filteredLosses = useMemo(
    () =>
      losses
        .filter((row) => {
          const period = periodById.get(row.financial_period_id);
          return (
            (!periodFilter ||
              (row.period_label ?? period?.label) === periodFilter) &&
            (!partnerFilter ||
              financialPartner({ ...period, ...row }) === partnerFilter) &&
            (!dropFilter || key(row.drop_name_snapshot) === dropFilter) &&
            (!statusFilter || row.status === statusFilter) &&
            (!observationFilter ||
              key(row.observation).includes(key(observationFilter))) &&
            (!duplicatesOnly || (waybillCounts.get(key(row.waybill)) ?? 0) > 1) &&
            Object.entries(lossColumnFilters).every(([field, value]) =>
              !key(value) || key(lossColumnValue(row, field, period)).includes(key(value)))
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
      lossColumnFilters,
      duplicatesOnly,
      waybillCounts,
    ],
  );
  const selectedLosses = filteredLosses.filter(row => selectedLossIds.has(row.id));
  useEffect(() => {
    const visible = new Set(filteredLosses.map(row => row.id));
    setSelectedLossIds(current => {
      const next = new Set([...current].filter(id => canEditTotal && visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [filteredLosses, canEditTotal]);
  const totals = useMemo(
    () =>
      buildTotals(details, losses, periods, views, periodFilter, partnerFilter)
        .sort((first, second) => periodOrder(second.period) - periodOrder(first.period) || second.period.localeCompare(first.period, "pt-BR", { numeric: true })),
    [details, losses, periods, views, periodFilter, partnerFilter],
  );
  const periodOptions = options([
    ...periods.map((row) => row.label),
    ...details.map((row) => row.period),
    ...losses.map((row) => row.period_label),
  ]).sort((first, second) => periodOrder(second) - periodOrder(first) || second.localeCompare(first, "pt-BR", { numeric: true }));
  const partnerOptions = PARTNERS;
  const dropOptions = options([
    ...details.map((row) => row.drop),
    ...losses.map((row) => row.drop_name_snapshot),
  ]).reduce(
    (all, drop) => (all.has(key(drop)) ? all : all.set(key(drop), drop)),
    new Map<string, string>(),
  );
  const report = async (rows: DataRow[], excel = false) => {
    setGenerating(true);
    setError("");
    try {
      if (excel) await (await import("./excelDownload")).downloadPaymentDetailsExcel(rows);
      else await (await import("./financialReport")).downloadClosingPdf(rows, losses, periods);
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
  const editTotal = (row: DataRow) => {
    if (!canEditTotal) return;
    const partners = options(periods.filter(period => period.label === row.period).map(financialPartner));
    const partner = partnerFilter || (partners.length === 1 ? partners[0] : "");
    if (!partner) { setError("Selecione um parceiro para editar o total deste período."); return; }
    const target = paymentTotalTarget(periods, views, row.period, partner);
    if (!target) { setError("Este total reúne origens sem um único registro editável. Confira os períodos importados antes de alterar o líquido."); return; }
    setError(""); setEditError("");
    setEditingTotal({ ...target, period: row.period, partner, net: row.net ?? "", paymentDate: row.paymentDate?.includes(",") ? "" : row.paymentDate || "" });
  };
  const saveTotal = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingTotal || !supabase || saving || !canEditTotal) return;
    setSaving(true); setEditError("");
    try {
      const net = Number(editingTotal.net);
      const paymentDate = text(editingTotal.paymentDate);
      if (!text(editingTotal.net) || !Number.isFinite(net) || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate) || new Date(`${paymentDate}T12:00:00Z`).toISOString().slice(0, 10) !== paymentDate) throw new Error("Informe um líquido válido e a data do pagamento.");
      const { table, record } = editingTotal;
      let payload: DataRow;
      if (table === "financial_views") {
        const previous = notes(record.notes);
        payload = { notes: JSON.stringify({ ...previous, originalNotes: previous.originalNotes ?? (Object.keys(previous).length ? undefined : record.notes), summary: { ...previous.summary, invoice: round(net), paymentDate } }) };
      } else payload = { net_amount: round(net), payment_date: paymentDate };
      let query = supabase.from(table).update(payload).eq("id", record.id).eq("is_active", true);
      for (const field of table === "financial_views" ? ["notes"] : ["net_amount", "payment_date"]) {
        query = record[field] == null ? query.is(field, null) : query.eq(field, record[field]);
      }
      const { data, error } = await query.select("id");
      if (error) throw error;
      if (data?.length !== 1) throw new Error("O registro mudou ou você não tem permissão. Atualize a página antes de tentar novamente.");
      setEditingTotal(null); setMessage("Total líquido e data do pagamento atualizados.");
      await load();
    } catch (caught) {
      setEditError((caught as Error).message || "Não foi possível salvar o pagamento total.");
    } finally { setSaving(false); }
  };
  const saveDetail = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !supabase) return;
    setSaving(true);
    setEditError("");
    try {
      if (
        ![editing.period, editing.partner, editing.referenceCnpj, editing.drop].every((value) =>
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
      let period = originalPeriod && originalPeriod.label === text(editing.period) && financialPartner(originalPeriod) === text(editing.partner) ? originalPeriod : periods.find(
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
            logistics_partner: text(editing.partner),
            reference_cnpj: text(editing.referenceCnpj),
            financial_view_id: originalPeriod?.financial_view_id ?? null,
            status: "aberto",
          })
          .select()
          .single();
        if (result.error) throw result.error;
        period = result.data;
      }
      if (period && period.reference_cnpj !== text(editing.referenceCnpj)) {
        const { data, error } = await supabase
          .from("financial_periods")
          .update({ reference_cnpj: text(editing.referenceCnpj) })
          .eq("id", period.id)
          .select()
          .single();
        if (error) throw error;
        period = data;
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
        logistics_partner: text(editing.partner),
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
  const openLoss = (row: DataRow | null) => {
    if (!canEditTotal) return;
    lossOriginal.current = row;
    lossInsertId.current = row ? "" : crypto.randomUUID();
    setEditError("");
    setEditingLoss(lossEditorValues(row ?? { period_label: periodFilter, partner: partnerFilter, drop_name_snapshot: dropOptions.get(dropFilter) ?? "", status: "", amount: 0 }, periods));
  };
  const saveLoss = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingLoss || !supabase || lossSaving.current) return;
    if (!canEditTotal) { setEditError("Você não tem permissão para gerenciar extravios."); return; }
    lossSaving.current = true;
    setSaving(true);
    setEditError("");
    try {
      const original = lossOriginal.current;
      const payload = lossEventPayload(editingLoss, original, periods, drops);
      let query;
      if (original) {
        query = supabase.from("loss_events").update(payload).eq("id", original.id).eq("is_active", true);
        if (original.updated_at) query = query.eq("updated_at", original.updated_at);
      } else {
        query = supabase.from("loss_events").insert({ ...payload, id: lossInsertId.current });
      }
      const result = await query.select("id").single();
      if (result.error?.code === "23505") throw new Error("Este envio já pode ter sido salvo. Feche e atualize os dados antes de tentar adicionar novamente.");
      if (result.error?.code === "PGRST116" || (!result.error && !result.data?.id)) throw new Error("O extravio foi alterado, ficou indisponível ou não pôde ser confirmado. Feche e atualize os dados antes de tentar novamente.");
      if (result.error) throw result.error;
      setEditingLoss(null);
      setMessage(original ? "Extravio atualizado." : "Extravio adicionado.");
      await load();
    } catch (caught) {
      setEditError(
        (caught as Error).message || "Não foi possível salvar o extravio.",
      );
    } finally {
      lossSaving.current = false;
      setSaving(false);
    }
  };
  const openBulkLosses = () => {
    if (!canEditTotal || !selectedLosses.length || lossSaving.current) return;
    setBulkLosses(selectedLosses.map(row => ({ ...row })));
    setBulkChanges({}); setBulkConfirmed(false); setBulkAttempted(false); setBulkProgress(0); setEditError("");
  };
  const saveBulkLosses = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !bulkLosses || lossSaving.current || bulkAttempted) return;
    if (!canEditTotal) { setEditError("Você não tem permissão para gerenciar extravios."); return; }
    if (!bulkConfirmed) { setEditError("Confirme a quantidade de extravios antes de aplicar."); return; }
    lossSaving.current = true; setSaving(true); setEditError("");
    let attempted = false, completed = 0;
    try {
      const plan = lossBatchPayloads(bulkLosses, bulkChanges, periods, drops);
      attempted = true; setBulkAttempted(true);
      for (const { original, payload } of plan) {
        const result = await supabase.from("loss_events").update(payload).eq("id", original.id).eq("is_active", true).eq("updated_at", original.updated_at).select("id").single();
        if (result.error?.code === "PGRST116" || (!result.error && result.data?.id !== original.id)) throw new Error("Um extravio foi alterado ou não está mais disponível.");
        if (result.error) throw result.error;
        completed++; setBulkProgress(completed);
      }
      setMessage(`${completed} extravio(s) atualizado(s) em massa.`);
    } catch (caught) {
      const reason = text((caught as Error).message) || "Não foi possível confirmar a gravação.";
      setEditError(attempted ? `${completed} de ${bulkLosses.length} gravações confirmadas. Lote interrompido: ${reason} Feche e confira os registros antes de selecionar novamente; a última tentativa pode ter sido gravada.` : reason);
    } finally {
      if (attempted) await load();
      lossSaving.current = false; setSaving(false);
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
          {kind === "losses" && canEditTotal && <button type="button" className="primary" disabled={loading || !!error || saving} onClick={() => openLoss(null)}><span aria-hidden="true">+</span> Adicionar extravio</button>}
          {kind === "details" && (
            <button
              className="secondary"
              disabled={loading || generating || !filteredDetails.length}
              onClick={() => void report(filteredDetails, true)}
            >
              {generating ? "Gerando Excel…" : "Baixar Excel do fechamento"}
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
            <label className="loss-duplicates-filter">
              <input type="checkbox" checked={duplicatesOnly} onChange={event => setDuplicatesOnly(event.target.checked)} />
              Somente Waybills duplicados
            </label>
          </>
        )}
        {(periodFilter ||
          partnerFilter ||
          dropFilter ||
          statusFilter ||
          observationFilter || duplicatesOnly || Object.values(lossColumnFilters).some(Boolean)) && (
          <button
            className="secondary"
            onClick={() => {
              setPeriodFilter("");
              setPartnerFilter("");
              setDropFilter("");
              setStatusFilter("");
              setObservationFilter("");
              setLossColumnFilters({});
              setDuplicatesOnly(false);
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
        <PaymentTotal rows={totals} onEdit={canEditTotal ? editTotal : undefined} />
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
          columnFilters={lossColumnFilters}
          onFilter={(field, value) => setLossColumnFilters(current => ({ ...current, [field]: value }))}
          waybillCounts={waybillCounts}
          selectedIds={selectedLossIds}
          onSelect={(id, checked) => setSelectedLossIds(current => {
            const next = new Set(current);
            if (checked) next.add(id); else next.delete(id);
            return next;
          })}
          onSelectAll={checked => setSelectedLossIds(new Set(checked ? filteredLosses.map(row => row.id) : []))}
          onBulkEdit={openBulkLosses}
          onEdit={canEditTotal ? openLoss : undefined}
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
      {editingTotal && (
        <Editor title="Editar pagamento total" onClose={() => !saving && setEditingTotal(null)} onSubmit={saveTotal} saving={saving} error={editError}>
          <p>{editingTotal.period} · {editingTotal.partner}</p>
          <div className="form-grid">
            <label>Total líquido a receber<input autoFocus required type="number" step="0.01" value={editingTotal.net} onChange={event => setEditingTotal({ ...editingTotal, net: event.target.value })} /></label>
            <label>Data do pagamento<input required type="date" value={editingTotal.paymentDate} onChange={event => setEditingTotal({ ...editingTotal, paymentDate: event.target.value })} /></label>
          </div>
        </Editor>
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
            {detailFields.map(
              ([field, label, type]) => (
                <label key={field}>
                  {label}
                  {type === "select" ? (
                    <select
                      required
                      value={editing[field] ?? ""}
                      onChange={(event) => changeDetail(field, event.target.value)}
                    >
                      <option value="">Selecionar</option>
                      {referenceCnpjs.map((value) => <option key={value}>{value}</option>)}
                    </select>
                  ) : (
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
                  )}
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
      {bulkLosses && (
        <Editor title="Editar extravios em massa" onClose={() => !lossSaving.current && setBulkLosses(null)} onSubmit={saveBulkLosses} saving={saving} error={editError}
          submitLabel={`Aplicar em ${bulkLosses.length} extravios`} submitDisabled={bulkAttempted || !bulkConfirmed || !Object.keys(bulkChanges).length || !canEditTotal} cancelLabel={bulkAttempted ? "Fechar" : "Cancelar"}>
          <p>{bulkLosses.length} extravio(s) selecionado(s)</p>
          <fieldset disabled={bulkAttempted} className="bulk-loss-fields">
            {lossEditableFields.map(([field, label, type]) => {
              const enabled = Object.prototype.hasOwnProperty.call(bulkChanges, field);
              const suggestions = field === "period_label" ? periodOptions : field === "partner" ? options([...PARTNERS, ...periods.map(row => row.partner)]) : field === "status" ? options(["PUDO Missing", "PUDO Missing - não cobrei", "D2D Missing", "D2D Missing - não cobrei", ...losses.map(row => row.status)]) : [];
              return <div key={field} className="bulk-loss-field">
                <label className="bulk-field-toggle"><input type="checkbox" checked={enabled} onChange={event => {
                  setBulkChanges(current => { const next = { ...current }; if (event.target.checked) next[field] = ""; else delete next[field]; return next; });
                  setBulkConfirmed(false); setEditError("");
                }} />Alterar {label}</label>
                {type === "textarea" ? <textarea aria-label={label} disabled={!enabled} value={bulkChanges[field] ?? ""} onChange={event => { setBulkChanges(current => ({ ...current, [field]: event.target.value })); setBulkConfirmed(false); setEditError(""); }} />
                  : <input aria-label={label} disabled={!enabled} type={type} step={type === "datetime-local" ? "1" : "0.01"} required={enabled && ["period_label", "partner", "amount"].includes(field)} list={suggestions.length ? `bulk-${field}` : undefined} value={bulkChanges[field] ?? ""} onChange={event => { setBulkChanges(current => ({ ...current, [field]: event.target.value })); setBulkConfirmed(false); setEditError(""); }} />}
                {suggestions.length > 0 && <datalist id={`bulk-${field}`}>{suggestions.map(value => <option key={value} value={value} />)}</datalist>}
              </div>;
            })}
            <label className="bulk-confirm"><input type="checkbox" checked={bulkConfirmed} onChange={event => setBulkConfirmed(event.target.checked)} />Confirmo aplicar os campos marcados aos {bulkLosses.length} extravios selecionados</label>
          </fieldset>
          {bulkAttempted && <p role="status">{bulkProgress} de {bulkLosses.length} gravações confirmadas.</p>}
        </Editor>
      )}
      {editingLoss && (
        <Editor
          title={lossOriginal.current ? "Editar extravio" : "Adicionar extravio"}
          onClose={() => !saving && setEditingLoss(null)}
          onSubmit={saveLoss}
          saving={saving}
          error={editError}
        >
          <div className="form-grid">
            {[["period_label", "Período", "loss-periods"], ["partner", "Parceiro", "loss-partners"], ["drop_name_snapshot", "Scan station / DROP", "loss-drops"], ["waybill", "Waybill nº", ""], ["label_code", "Código da etiqueta", ""], ["bag_code", "Saca", ""], ["status", "Status", "loss-statuses"], ["seller", "Seller", ""]].map(([field, label, list]) => (
              <label key={field}>{label}<input autoFocus={field === "period_label"} list={list || undefined} required={!lossOriginal.current && ["period_label", "partner", "drop_name_snapshot", "status"].includes(field)} value={editingLoss[field] ?? ""} onChange={event => setEditingLoss({ ...editingLoss, [field]: event.target.value })} /></label>
            ))}
            <datalist id="loss-periods">{periodOptions.map(value => <option key={value} value={value} />)}</datalist>
            <datalist id="loss-partners">{options([...PARTNERS, ...periods.filter(period => key(period.label) === key(editingLoss.period_label)).map(period => period.partner), editingLoss.partner]).map(value => <option key={value} value={value} />)}</datalist>
            <datalist id="loss-drops">{options([...drops.map(drop => drop.name), ...losses.map(loss => loss.drop_name_snapshot)]).map(value => <option key={value} value={value} />)}</datalist>
            <datalist id="loss-statuses">{options(["PUDO Missing", "PUDO Missing - não cobrei", "D2D Missing", "D2D Missing - não cobrei", ...losses.map(loss => loss.status)]).map(value => <option key={value} value={value} />)}</datalist>
            <label>Recebimento<input type="datetime-local" step="1" value={editingLoss.received_at} onChange={event => setEditingLoss({ ...editingLoss, received_at: event.target.value })} /></label>
            <label>
              Valor do extravio
              <input
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
                aria-label="Observações"
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
  submitLabel = "Salvar alterações",
  submitDisabled = false,
  cancelLabel = "Cancelar",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  saving: boolean;
  error: string;
  submitLabel?: string;
  submitDisabled?: boolean;
  cancelLabel?: string;
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
            {cancelLabel}
          </button>
          <button className="primary compact" disabled={saving || submitDisabled}>
            {saving ? "Salvando…" : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function PaymentTotal({ rows, onEdit }: { rows: DataRow[]; onEdit?: (row: DataRow) => void }) {
  return (
    <section className="card">
      {rows.some((row) => row.missingNet) && <p role="status" className="financial-hint">Total líquido pendente em um ou mais períodos.</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Período</th>
              {totalColumns.map(([field, title]) => (
                <th key={field} className={field === "net" ? "financial-net-column" : undefined}>{title}</th>
              ))}
              <th>Data do pagamento</th>
              {onEdit && <th>Ações</th>}
            </tr>
          </thead>
          <tbody>
            <tr className="financial-totals">
              <th scope="row">Total filtrado</th>
              {totalColumns.map(([field]) => (
                <td key={field} className={field === "net" ? "financial-net-column" : undefined}>{rows.some(row => row[field] == null) ? "—" : money(sum(rows, field))}</td>
              ))}
              <td />
              {onEdit && <td />}
            </tr>
            {rows.map((row) => (
              <tr key={row.period}>
                <td>
                  <strong>{row.period}</strong>
                  {row.missingNet && (
                    <small className="table-subtitle">Líquido não informado</small>
                  )}
                </td>
                {totalColumns.map(([field]) => (
                  <td
                    key={field}
                    className={`${field === "net" ? "financial-net-column " : ""}${
                      ["loss", "assumed"].includes(field) ||
                      number(row[field]) < 0
                        ? "loss-value"
                        : field === "companyPayment"
                          ? "positive-value"
                          : ""
                    }`}
                  >
                    {row[field] == null ? "—" : money(row[field])}
                  </td>
                ))}
                <td>
                  {row.paymentDate
                    ? row.paymentDate.split(", ").map(date).join(", ")
                    : "—"}
                </td>
                {onEdit && <td><button type="button" className="table-action" onClick={() => onEdit(row)} title={`Editar líquido e data de ${row.period}`}>Editar</button></td>}
              </tr>
            ))}
            {!rows.length && <EmptyRow columns={onEdit ? 13 : 12} />}
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
        <table className="payment-details-table">
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
              <th scope="row" colSpan={5}>
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
            {!rows.length && <EmptyRow columns={16} />}
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
  columnFilters,
  onFilter,
  waybillCounts,
  selectedIds,
  onSelect,
  onSelectAll,
  onBulkEdit,
  onEdit,
}: {
  rows: DataRow[];
  periodById: Map<string, DataRow>;
  columnFilters: Record<string, string>;
  onFilter: (field: string, value: string) => void;
  waybillCounts: Map<string, number>;
  selectedIds: Set<string>;
  onSelect: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onBulkEdit: () => void;
  onEdit?: (row: DataRow) => void;
}) {
  const selectedCount = rows.filter(row => selectedIds.has(row.id)).length;
  return (
    <section className="card financial-losses">
      <div className="financial-loss-total" role="status">
        <span>{rows.length} extravio(s) nos filtros selecionados</span>
        <strong>Total: {money(sum(rows, "amount"))}</strong>
      </div>
      {onEdit && <div className="financial-actions loss-selection-actions">
        <span role="status">{selectedCount} selecionado(s)</span>
        <button type="button" className="secondary" disabled={!selectedCount} onClick={onBulkEdit}>Editar selecionados</button>
        <button type="button" className="secondary" disabled={!selectedCount} onClick={() => onSelectAll(false)}>Limpar seleção</button>
      </div>}
      <div className="table-wrap">
        <table className="losses-table">
          <thead>
            <tr>
              {onEdit && <th className="loss-selection-cell" scope="col"><input type="checkbox" aria-label="Selecionar todos os extravios filtrados" disabled={!rows.length} checked={rows.length > 0 && selectedCount === rows.length} ref={element => { if (element) element.indeterminate = selectedCount > 0 && selectedCount < rows.length; }} onChange={event => onSelectAll(event.target.checked)} /></th>}
              {lossColumns.map(([field, title]) => (
                <th key={field} scope="col">
                  {title}
                  <input type="search" aria-label={`Filtrar ${title}`} placeholder="Filtrar" value={columnFilters[field] ?? ""} onChange={event => onFilter(field, event.target.value)} />
                </th>
              ))}
              <th scope="col">Ação</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const period = periodById.get(row.financial_period_id);
              const duplicateCount = waybillCounts.get(key(row.waybill)) ?? 0;
              return (
                <tr key={row.id}>
                  {onEdit && <td className="loss-selection-cell"><input type="checkbox" aria-label={`Selecionar extravio ${row.waybill || row.id} de ${row.drop_name_snapshot || "DROP não informado"}`} checked={selectedIds.has(row.id)} onChange={event => onSelect(row.id, event.target.checked)} /></td>}
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
                    <td key={field} className={field === "waybill" && duplicateCount > 1 ? "duplicate-waybill" : undefined}>
                      {row[field] || "—"}
                      {field === "waybill" && duplicateCount > 1 && <small className="table-subtitle" title={`${duplicateCount} ocorrências deste Waybill na base de extravios carregada`}>Duplicado ({duplicateCount})</small>}
                    </td>
                  ))}
                  <td>
                    {row.received_at
                      ? new Date(row.received_at).toLocaleString("pt-BR")
                      : "—"}
                  </td>
                  <td className="loss-value">{money(row.amount)}</td>
                  <td>{row.observation || "—"}</td>
                  <td>
                    {onEdit && <button
                      className="table-action"
                      onClick={() => onEdit(row)}
                    >
                      Editar
                    </button>}
                  </td>
                </tr>
              );
            })}
            {!rows.length && <EmptyRow columns={onEdit ? 12 : 11} />}
          </tbody>
          <tfoot>
            <tr className="financial-totals">
              <th scope="row" colSpan={onEdit ? 9 : 8}>
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
