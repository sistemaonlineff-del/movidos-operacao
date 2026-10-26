export type RegistrationKind = "drop_off" | "last_mile";

export const CADASTRO_TEXT_FILTERS = [
  { field: "name", label: "Nome DROP" },
  { field: "responsible", label: "Responsável" },
  { field: "phone", label: "Telefone", numeric: true },
  { field: "cnpj", label: "CNPJ", numeric: true },
  { field: "address", label: "Logradouro" },
  { field: "address_number", label: "Número" },
  { field: "complement", label: "Complemento" },
  { field: "neighborhood", label: "Bairro" },
  { field: "municipality", label: "Município" },
  { field: "state", label: "UF" },
  { field: "postal_code", label: "CEP", numeric: true },
] as const;

type TextField = (typeof CADASTRO_TEXT_FILTERS)[number]["field"];
export type CadastroFilters = Record<TextField | "legacy_id" | "status" | "partner" | "zone" | "query", string> & { page: number };

export function createCadastroFilters(status = "ATIVO"): CadastroFilters {
  return {
    legacy_id: "", status, name: "", partner: "", responsible: "", phone: "",
    cnpj: "", address: "", address_number: "", complement: "", neighborhood: "",
    municipality: "", state: "", postal_code: "", zone: "", query: "", page: 0,
  };
}

type FilterQuery = {
  eq(column: string, value: string | number): unknown;
  ilike(column: string, pattern: string): unknown;
  filter(column: string, operator: string, value: string): unknown;
  or(expression: string): unknown;
};

function literalPattern(value: string) {
  return value.trim().replace(/[%*]/g, "").replace(/\\/g, "\\\\").replace(/_/g, "\\_");
}

function quoted(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function numericMaskPattern(value: string) {
  return value.replace(/\D/g, "").split("").join("[^0-9]*");
}

export function applyRegistrationKind(query: Pick<FilterQuery, "eq" | "or">, kind: RegistrationKind) {
  if (kind === "last_mile") query.eq("registration_type", "last_mile");
  else query.or("registration_type.is.null,registration_type.eq.drop_off");
  return query;
}

export function applyCadastroFilters(query: FilterQuery, filters: CadastroFilters, kind: RegistrationKind, allStatuses = false) {
  applyRegistrationKind(query, kind);
  if (filters.status && !allStatuses) query.eq("status", filters.status);
  if (filters.partner) query.eq("partner", filters.partner);
  if (filters.zone) query.eq("zone", filters.zone);
  const identifier = filters.legacy_id.trim();
  if (identifier) {
    if (/^\d{1,15}$/.test(identifier)) query.eq("legacy_id", Number(identifier));
    else {
      query.eq("legacy_id", -1);
      query.eq("legacy_id", -2);
    }
  }
  for (const { field } of CADASTRO_TEXT_FILTERS) {
    const value = filters[field].trim();
    if (!value) continue;
    if (["phone", "cnpj", "postal_code"].includes(field) && /\d/.test(value)) {
      query.filter(field, "match", numericMaskPattern(value));
    } else {
      const term = literalPattern(value);
      if (term) query.ilike(field, `%${term}%`);
    }
  }
  const term = literalPattern(filters.query);
  if (term) {
    const terms = ["name", "partner", "responsible", "address", "municipality", "zone"]
      .map((field) => `${field}.ilike.${quoted(`*${term}*`)}`);
    if (/^\d{1,15}$/.test(term)) terms.push(`legacy_id.eq.${Number(term)}`);
    if (/^[\d\s()+./-]+$/.test(filters.query.trim()) && /\d/.test(filters.query)) {
      for (const field of ["phone", "cnpj", "postal_code"]) {
        terms.push(`${field}.match.${quoted(numericMaskPattern(filters.query))}`);
      }
    }
    query.or(terms.join(","));
  }
  return query;
}