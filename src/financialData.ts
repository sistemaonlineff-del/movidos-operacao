import { normalizePartner, PARTNERS } from './dropOptions.js';

export type DataRow = Record<string, any>;
export const financialPartner = (row: DataRow) => row.logistics_partner || (PARTNERS.includes(normalizePartner(row.partner)) ? normalizePartner(row.partner) : PARTNERS[0]);
export const text = (value: unknown) => String(value ?? "").trim();
export const key = (value: unknown) =>
  text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ");
export const number = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = text(value).replace(/R\$\s*/g, "");
  const parsed = Number(
    raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw,
  );
  return Number.isFinite(parsed) ? parsed : 0;
};
export const round = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
export const money = (value: unknown) =>
  number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const decimal = (value: unknown) =>
  number(value).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const date = (value: unknown) => {
  if (!value) return "—";
  const parsed = new Date(`${text(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleDateString("pt-BR");
};
export const periodOrder = (label: string) =>
  Number(label.match(/^\s*(\d+)/)?.[1] ?? 0);
export function lossEditorValues(row: DataRow, periods: DataRow[]): DataRow {
  const period = periods.find(candidate => candidate.id === row.financial_period_id);
  const received = row.received_at ? new Date(row.received_at) : null;
  const localDate = received && Number.isFinite(received.getTime())
    ? `${received.getFullYear()}-${String(received.getMonth() + 1).padStart(2, "0")}-${String(received.getDate()).padStart(2, "0")}T${String(received.getHours()).padStart(2, "0")}:${String(received.getMinutes()).padStart(2, "0")}:${String(received.getSeconds()).padStart(2, "0")}`
    : "";
  return { ...row, period_label: row.period_label ?? period?.label ?? "", partner: row.partner ?? period?.partner ?? "", received_at: localDate, amount: row.amount ?? 0 };
}
export function lossEventPayload(draft: DataRow, original: DataRow | null, periods: DataRow[], drops: DataRow[]) {
  const initial = lossEditorValues(original ?? {}, periods);
  const payload: DataRow = {};
  for (const field of ["period_label", "partner", "drop_name_snapshot", "waybill", "label_code", "bag_code", "status", "seller", "observation"]) {
    payload[field] = original && text(draft[field]) === text(initial[field]) ? original[field] ?? null : text(draft[field]) || null;
  }
  if (!original && ["period_label", "partner", "drop_name_snapshot", "status"].some(field => !text(draft[field]))) {
    throw new Error("Preencha período, parceiro, DROP e status.");
  }
  const rawAmount = text(draft.amount);
  const amount = Number(rawAmount.includes(",") ? rawAmount.replace(/\./g, "").replace(",", ".") : rawAmount);
  if (!rawAmount || !Number.isFinite(amount) || Math.abs(amount) >= 1e12) throw new Error("Informe um valor de extravio válido.");
  payload.amount = round(amount);
  if (original && text(draft.received_at) === text(initial.received_at)) {
    payload.received_at = original.received_at ?? null;
  } else {
    const received = text(draft.received_at) ? new Date(draft.received_at) : null;
    if (received && !Number.isFinite(received.getTime())) throw new Error("Informe uma data de recebimento válida.");
    payload.received_at = received?.toISOString() ?? null;
  }
  const samePeriod = original && key(draft.period_label) === key(initial.period_label) && key(draft.partner) === key(initial.partner);
  if (samePeriod) {
    payload.financial_period_id = original.financial_period_id ?? null;
  } else {
    const matches = periods.filter(period => key(period.label) === key(draft.period_label) && key(period.partner) === key(draft.partner));
    if (matches.length !== 1) throw new Error("Selecione período e parceiro de um fechamento existente, sem vínculos ambíguos.");
    payload.financial_period_id = matches[0].id;
    payload.period_label = matches[0].label;
    payload.partner = matches[0].partner;
  }
  if (original && key(draft.drop_name_snapshot) === key(initial.drop_name_snapshot) && key(draft.partner) === key(initial.partner)) {
    payload.drop_id = original.drop_id ?? null;
  } else {
    const period = periods.find(candidate => candidate.id === payload.financial_period_id);
    const partner = period ? financialPartner(period) : financialPartner(draft);
    const matches = drops.filter(drop => key(drop.name) === key(draft.drop_name_snapshot) && key(normalizePartner(drop.partner)) === key(partner));
    if (matches.length > 1) throw new Error("Há mais de um cadastro para este DROP e parceiro. Confira o vínculo antes de salvar.");
    payload.drop_id = matches[0]?.id ?? null;
  }
  return payload;
}
export function notes(value: unknown): DataRow {
  try {
    const result = JSON.parse(text(value) || "{}");
    return result && typeof result === "object" && !Array.isArray(result)
      ? result
      : {};
  } catch {
    return {};
  }
}
export function lossClass(status: unknown) {
  const normalized = key(status).replace(/[–—]/g, "-");
  const type = /PUDO|W2D/.test(normalized)
    ? "w2d"
    : normalized.includes("D2D")
      ? "d2d"
      : "other";
  const assumed = [
    "D2D MISSING - NAO COBREI",
    "PUDO MISSING - NAO COBREI",
  ].includes(normalized);
  const deducted = ["D2D MISSING", "PUDO MISSING"].includes(normalized);
  // Older files also contain explicitly waived/partially waived occurrences.
  const waived = /NAO (COBREI|DESCONTEI)/.test(normalized);
  return { type, assumed, deducted, chargeable: !waived };
}
export function splitLosses(rows: DataRow[]) {
  const result = { w2d: 0, d2d: 0, other: 0, loss: 0, deducted: 0, assumed: 0 };
  for (const row of rows) {
    const category = lossClass(row.status),
      amount = number(row.amount);
    result.loss += amount;
    result[category.type as "w2d" | "d2d" | "other"] += amount;
    if (category.deducted) result.deducted += amount;
    if (category.assumed) result.assumed += amount;
  }
  return Object.fromEntries(
    Object.entries(result).map(([field, value]) => [field, round(value)]),
  ) as typeof result;
}
export function lossesFor(row: DataRow, losses: DataRow[], periods: DataRow[]) {
  const periodById = new Map(periods.map((period) => [period.id, period]));
  return losses.filter((loss) => {
    const period = periodById.get(loss.financial_period_id);
    const samePeriod =
      row.periodId && loss.financial_period_id
        ? row.periodId === loss.financial_period_id
        : key(row.period) === key(loss.period_label ?? period?.label) &&
          key(row.partner) === key(loss.partner ?? period?.partner);
    return samePeriod && key(row.drop) === key(loss.drop_name_snapshot);
  });
}
export function buildDetails(
  history: DataRow[],
  items: DataRow[],
  losses: DataRow[],
  periods: DataRow[],
  drops: DataRow[] = [],
) {
  const byId = new Map(periods.map((row) => [row.id, row]));
  const used = new Set<string>();
  const reserved = new Set(
    history
      .map((row) => notes(row.observation).movidosClosing?.sourceItemId)
      .filter(Boolean),
  );
  const itemById = new Map(items.map((item) => [item.id, item]));
  const itemGroups = new Map<string, DataRow[]>();
  const lossGroups = new Map<string, DataRow[]>(),
    labelLossGroups = new Map<string, DataRow[]>(),
    unlinkedLossGroups = new Map<string, DataRow[]>();
  const add = (map: Map<string, DataRow[]>, identity: string, row: DataRow) => {
    const group = map.get(identity);
    if (group) group.push(row);
    else map.set(identity, [row]);
  };
  for (const item of items)
    if (!reserved.has(item.id))
      add(
        itemGroups,
        `${item.financial_period_id}|${key(item.drop_name_snapshot)}`,
        item,
      );
  for (const loss of losses) {
    if (!lossClass(loss.status).chargeable) continue;
    const period = byId.get(loss.financial_period_id);
    const labelIdentity = `${key(loss.period_label ?? period?.label)}|${key(loss.partner ?? period?.partner)}|${key(loss.drop_name_snapshot)}`;
    add(labelLossGroups, labelIdentity, loss);
    if (loss.financial_period_id)
      add(
        lossGroups,
        `${loss.financial_period_id}|${key(loss.drop_name_snapshot)}`,
        loss,
      );
    else add(unlinkedLossGroups, labelIdentity, loss);
  }
  const registrations = new Map<string, { row: DataRow; index: number }>();
  drops.forEach((row, index) => {
    const identity = `${key(row.name)}|${key(row.partner)}`;
    if (!registrations.has(identity))
      registrations.set(identity, { row, index });
  });
  const source = history
    .map((row) => {
      const meta = notes(row.observation).movidosClosing ?? {};
      const candidate = meta.sourceItemId
        ? itemById.get(meta.sourceItemId)
        : itemGroups
            .get(`${row.financial_period_id}|${key(row.drop_name_snapshot)}`)
            ?.shift();
      const item = candidate && !used.has(candidate.id) ? candidate : undefined;
      if (item) used.add(item.id);
      return { row, item, history: true, meta };
    })
    .concat(
      items
        .filter((row) => !used.has(row.id))
        .map((row) => ({ row, item: row, history: false, meta: {} })),
    );
  const groupKey = (entry: (typeof source)[number]) =>
    `${entry.row.financial_period_id}|${key(entry.row.drop_name_snapshot)}`;
  const grouped = new Map<string, typeof source>();
  source.forEach((entry) =>
    grouped.set(groupKey(entry), [
      ...(grouped.get(groupKey(entry)) ?? []),
      entry,
    ]),
  );
  return source
    .map((source) => {
      const { row, meta } = source,
        period = byId.get(row.financial_period_id);
      const identity = {
        periodId: row.financial_period_id,
        period: row.period_label ?? period?.label ?? "Sem período",
        partner: financialPartner({ ...period, ...row }),
        referenceCnpj: period?.reference_cnpj || "MOVIDOS",
        drop: row.drop_name_snapshot ?? "",
      };
      const exact = registrations.get(
          `${key(identity.drop)}|${key(identity.partner)}`,
        ),
        fallback = registrations.get(`${key(identity.drop)}|`);
      const registration =
        exact && (!fallback || exact.index < fallback.index)
          ? exact.row
          : fallback?.row;
      const labelIdentity = `${key(identity.period)}|${key(row.partner ?? period?.partner)}|${key(identity.drop)}`;
      const related = identity.periodId
        ? [
            ...(lossGroups.get(`${identity.periodId}|${key(identity.drop)}`) ??
              []),
            ...(unlinkedLossGroups.get(labelIdentity) ?? []),
          ]
        : (labelLossGroups.get(labelIdentity) ?? []);
      const split = splitLosses(related);
      const siblings = grouped.get(groupKey(source)) ?? [source];
      const totalPackages = siblings.reduce(
        (sum, entry) =>
          sum +
          number(
            entry.history
              ? entry.row.package_quantity
              : entry.row.quantity_packages,
          ),
        0,
      );
      // Old history has only the total per row. Allocate a shared occurrence once,
      // using recorded loss proportions; imported/edited explicit splits take precedence.
      const weights = siblings.map((entry) =>
        entry.history
          ? number(entry.row.loss_amount)
          : split.loss *
            (totalPackages
              ? number(entry.row.quantity_packages) / totalPackages
              : 1 / siblings.length),
      );
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      const position = siblings.indexOf(source);
      const before = weights
        .slice(0, position)
        .reduce((sum, value) => sum + value, 0);
      const allocate = (amount: number) =>
        siblings.length === 1
          ? amount
          : totalWeight
            ? round(
                round((amount * (before + weights[position])) / totalWeight) -
                  round((amount * before) / totalWeight),
              )
            : 0;
      const rowSplit = {
        w2d: allocate(split.w2d),
        d2d: allocate(split.d2d),
        loss: allocate(split.loss),
      };
      const packages = number(
          source.history ? row.package_quantity : row.quantity_packages,
        ),
        unit = number(source.history ? row.amount : row.unit_value);
      const subtotal =
        source.history && row.subtotal != null
          ? number(row.subtotal)
          : round(packages * unit);
      const loss =
        source.history && row.loss_amount != null
          ? number(row.loss_amount)
          : rowSplit.loss;
      const reimbursement = number(row.reimbursement);
      return {
        ...identity,
        id: row.id,
        source: source.history ? "history" : "item",
        sourceItemId: source.item?.id,
        raw: row,
        packages,
        unit,
        subtotal,
        w2d: number(meta.w2d ?? rowSplit.w2d),
        d2d: number(meta.d2d ?? rowSplit.d2d),
        loss,
        reimbursement,
        splitAllocated:
          siblings.length > 1 &&
          meta.w2d == null &&
          meta.d2d == null &&
          (split.w2d !== 0 || split.d2d !== 0),
        receivable:
          source.history && row.total_receivable != null
            ? number(row.total_receivable)
            : round(subtotal - loss + reimbursement),
        packageType: text(meta.packageType),
        responsible: row.responsible || period?.responsible || (!PARTNERS.includes(normalizePartner(row.partner ?? period?.partner)) ? text(row.partner ?? period?.partner) : "") || registration?.responsible || "",
        email: row.email ?? registration?.email ?? "",
        dropId: row.drop_id ?? registration?.id ?? null,
        paymentDate: row.paid_at ?? period?.payment_date ?? "",
        pix: row.pix_key ?? registration?.pix_key ?? "",
        pixHolderName:
          row.pix_holder_name ?? registration?.pix_holder_name ?? "",
        document: row.cnpj ?? registration?.cnpj ?? registration?.cpf ?? "",
      };
    })
    .sort(
      (a, b) =>
        periodOrder(a.period) - periodOrder(b.period) ||
        a.partner.localeCompare(b.partner) ||
        a.drop.localeCompare(b.drop),
    );
}
export function paymentTotalTarget(periods: DataRow[], views: DataRow[], label: string, partner: string) {
  const selected = periods.filter(period => period.label === label && financialPartner(period) === partner);
  if (!selected.length) return null;
  if (selected.length === 1) return { table: "financial_periods", record: selected[0] };
  const view = views.find(view => view.id === selected[0].financial_view_id);
  if (!view || selected.some(period => period.financial_view_id !== view.id || period.net_amount != null) ||
      periods.some(period => period.financial_view_id === view.id && (period.label !== label || financialPartner(period) !== partner))) return null;
  return { table: "financial_views", record: view };
}

export function buildTotals(
  details: DataRow[],
  losses: DataRow[],
  periods: DataRow[],
  views: DataRow[],
  periodFilter = "",
  partnerFilter = "",
) {
  const labels = [
    ...new Set(
      [
        ...periods.map((row) => row.label),
        ...details.map((row) => row.period),
        ...losses.map((row) => row.period_label),
      ].filter(Boolean),
    ),
  ];
  return labels
    .filter((label) => !periodFilter || label === periodFilter)
    .sort((a, b) => periodOrder(a) - periodOrder(b))
    .flatMap((label) => {
      const matchingPeriods = periods.filter(
        (period) =>
          period.label === label &&
          (!partnerFilter || financialPartner(period) === partnerFilter),
      );
      const matchingDetails = details.filter(
        (row) =>
          row.period === label &&
          (!partnerFilter || row.partner === partnerFilter),
      );
      const ids = new Set(matchingPeriods.map((period) => period.id));
      const matchingLosses = losses.filter((loss) =>
        loss.financial_period_id
          ? ids.has(loss.financial_period_id)
          : loss.period_label === label &&
            (!partnerFilter || financialPartner(loss) === partnerFilter),
      );
      if (
        !matchingPeriods.length &&
        !matchingDetails.length &&
        !matchingLosses.length
      )
        return [];
      const split = splitLosses(matchingLosses.filter(loss => {
        const category = lossClass(loss.status);
        return category.deducted || category.assumed;
      }));
      const selectedViews = views.filter((view) =>
        matchingPeriods.some((period) => period.financial_view_id === view.id),
      );
      const metadata = selectedViews
        .filter(view => !partnerFilter || periods.filter(period => period.financial_view_id === view.id).every(period => financialPartner(period) === partnerFilter))
        .map(view => notes(view.notes));
      const summaries = metadata.map((meta) => meta.summary).filter(Boolean);
      const sum = (rows: DataRow[], field: string) =>
        round(rows.reduce((total, row) => total + number(row[field]), 0));
      const reimbursement = metadata.some((meta) => meta.reimbursement != null)
        ? sum(
            metadata.map((meta) => ({
              value: meta.reimbursement ?? meta.summary?.reimbursement,
            })),
            "value",
          )
        : summaries.some(summary => summary.reimbursement != null)
          ? sum(summaries, "reimbursement")
          : sum(matchingDetails, "reimbursement");
      const hasNet =
        matchingPeriods.length > 0 &&
        matchingPeriods.every((period) => period.net_amount != null);
      const hasSummaryNet = summaries.length > 0 && summaries.every(summary => summary.invoice != null);
      const net = hasNet ? sum(matchingPeriods, "net_amount") : hasSummaryNet ? sum(summaries, "invoice") : null;
      const totalLoss = round(split.w2d + split.d2d);
      const gross = net === null ? null : round(net + totalLoss);
      const payable = sum(matchingDetails, "receivable");
      const periodDates = matchingPeriods.map(row => row.payment_date).filter(Boolean);
      const summaryDates = summaries.map(row => row.paymentDate).filter(Boolean);
      const dates = [
        ...new Set(
          (hasNet && periodDates.length ? periodDates : summaryDates.length ? summaryDates : periodDates.length ? periodDates : matchingDetails.map(row => row.paymentDate))
            .filter(Boolean)
            .map((value) => text(value).slice(0, 10)),
        ),
      ];
      return [
        {
          period: label,
          gross,
          w2d: split.w2d,
          d2d: split.d2d,
          loss: totalLoss,
          reimbursement,
          net,
          payable,
          deducted: split.deducted,
          assumed: split.assumed,
          companyPayment: net === null ? null : round(net - payable),
          paymentDate: dates.join(", "),
          missingNet: net === null,
        },
      ];
    });
}
