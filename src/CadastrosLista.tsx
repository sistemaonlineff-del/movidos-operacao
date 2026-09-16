import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "./lib/supabase";
import { DROP_STATUSES, normalizePartner, normalizeZone, statusTone } from "./dropOptions";
import { useAccess } from "./access";
import "./cadastros-lista.css";

type DropRow = {
  id: string;
  legacy_id: number | null;
  status: string;
  name: string;
  partner: string | null;
  responsible: string | null;
  phone: string | null;
  address: string | null;
  zone: string | null;
  is_active: boolean;
  deactivated_reason: string | null;
};
const PAGE_SIZE = 50;
const columns = "id,legacy_id,status,name,partner,responsible,phone,address,zone,is_active,deactivated_reason";
type Filters = {
  status: string;
  partner: string;
  zone: string;
  query: string;
  page: number;
};
const requests = new Map<string, Promise<{ rows: DropRow[]; count: number }>>();

function readPage(filters: Filters, kind = "drop_off") {
  const identity = JSON.stringify(filters);
  const pending = requests.get(identity);
  if (pending) return pending;
  const request = (async () => {
    if (!supabase) throw new Error("Não foi possível conectar ao sistema.");
    let query = supabase.from("drops").select(columns, { count: "exact" });
    query = kind === "last_mile" ? query.eq("registration_type", "last_mile") : query.or("registration_type.is.null,registration_type.eq.drop_off");
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.partner) query = query.eq("partner", filters.partner);
    if (filters.zone) query = query.eq("zone", filters.zone);
    // Quote PostgREST values so punctuation cannot become another filter expression.
    const term = filters.query
      .trim()
      .replace(/[%*]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    if (term) {
      const terms = [
        "name",
        "partner",
        "responsible",
        "address",
        "municipality",
        "zone",
      ].map((field) => `${field}.ilike."*${term}*"`);
      if (/^\d{1,15}$/.test(term)) terms.push(`legacy_id.eq.${Number(term)}`);
      query = query.or(terms.join(","));
    }
    const { data, count, error } = await query
      .order("legacy_id", { ascending: false, nullsFirst: false })
      .order("id")
      .range(filters.page * PAGE_SIZE, (filters.page + 1) * PAGE_SIZE - 1);
    if (error) throw error;
    return { rows: (data ?? []) as DropRow[], count: count ?? 0 };
  })();
  requests.set(identity, request);
  void request
    .finally(() => {
      if (requests.get(identity) === request) requests.delete(identity);
    })
    .catch(() => {});
  return request;
}
function applyFilters(query: any, filters: Filters) {
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.partner) query = query.eq("partner", filters.partner);
  if (filters.zone) query = query.eq("zone", filters.zone);
  const term = filters.query
    .trim()
    .replace(/[%*]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  if (term) {
    const terms = [
      "name",
      "partner",
      "responsible",
      "address",
      "municipality",
      "zone",
    ].map((field) => `${field}.ilike."*${term}*"`);
    if (/^\d{1,15}$/.test(term)) terms.push(`legacy_id.eq.${Number(term)}`);
    query = query.or(terms.join(","));
  }
  return query;
}
async function readAllForExport(filters: Filters, allStatuses = false) {
  if (!supabase) throw new Error("Não foi possível conectar ao sistema.");
  const result: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const base = supabase.from("drops").select("*");
    const query = (allStatuses ? base : applyFilters(base, filters))
      .order("legacy_id", { ascending: false, nullsFirst: false })
      .order("id")
      .range(from, from + 999);
    const { data, error } = await query;
    if (error) throw error;
    result.push(...(data ?? []));
    if ((data ?? []).length < 1000) return result;
  }
}
let optionsRequest:
  | Promise<{ partners: string[]; zones: string[] }>
  | undefined;
function readOptions() {
  if (optionsRequest) return optionsRequest;
  const request = (async () => {
    if (!supabase) throw new Error("Não foi possível conectar ao sistema.");
    const partners = new Set<string>(),
      zones = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("drops")
        .select("partner,zone")
        .order("id")
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.partner) partners.add(normalizePartner(row.partner));
        if (row.zone) zones.add(normalizeZone(row.zone));
      }
      if ((data ?? []).length < 1000) break;
    }
    return { partners: [...partners].sort(), zones: [...zones].sort() };
  })();
  optionsRequest = request;
  void request
    .finally(() => {
      if (optionsRequest === request) optionsRequest = undefined;
    })
    .catch(() => {});
  return request;
}

export default function CadastrosLista({ kind = "drop_off" }: { kind?: "drop_off" | "last_mile" }) {
  const navigate = useNavigate();
  const { can } = useAccess();
  const [filters, setFilters] = useState<Filters>({
    status: "ATIVO",
    partner: "",
    zone: "",
    query: "",
    page: 0,
  });
  const [search, setSearch] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<DropRow[]>([]),
    [count, setCount] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [exporting, setExporting] = useState(false);
  const [options, setOptions] = useState({
      partners: [] as string[],
      zones: [] as string[],
    }),
    [optionsError, setOptionsError] = useState("");
  useEffect(() => {
    const timeout = setTimeout(
      () =>
        setFilters((current) =>
          current.query === search
            ? current
            : { ...current, query: search, page: 0 },
        ),
      250,
    );
    return () => clearTimeout(timeout);
  }, [search]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setRows([]);
    readPage(filters, kind)
      .then((result) => {
        if (!current) return;
        const lastPage = Math.max(0, Math.ceil(result.count / PAGE_SIZE) - 1);
        if (filters.page > lastPage) {
          setFilters((value) => ({ ...value, page: lastPage }));
          return;
        }
        setRows(result.rows);
        setCount(result.count);
        setLoading(false);
      })
      .catch((caught) => {
        if (current) {
          setError(caught.message || "Não foi possível carregar os cadastros.");
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [filters, refresh, kind]);
  useEffect(() => {
    let current = true;
    setOptionsError("");
    readOptions()
      .then((value) => {
        if (current) setOptions(value);
      })
      .catch((caught) => {
        if (current)
          setOptionsError(
            caught.message || "Não foi possível carregar os filtros.",
          );
      });
    return () => {
      current = false;
    };
  }, [refresh]);
  const change = (field: "status" | "partner" | "zone", value: string) =>
    setFilters((current) => ({ ...current, [field]: value, page: 0 }));
  const deactivate = async (drop: DropRow) => {
    if (!supabase) return;
    const reason = window.prompt(`Informe obrigatoriamente o motivo para desativar ${drop.name}:`)?.trim();
    if (!reason) { setError("A observação é obrigatória. O cadastro não foi desativado."); return; }
    setError("");
    const { data: auth } = await supabase.auth.getUser();
    const excludedStatus = DROP_STATUSES.find((status) => status.includes("EXCLU")) ?? "EXCLUÍDO";
    const payload = { is_active: false, status: excludedStatus, deactivated_reason: reason, deactivated_at: new Date().toISOString(), deactivated_by: auth.user?.id ?? null };
    const { error: updateError } = await supabase.from("drops").update(payload).eq("id", drop.id);
    if (updateError) { setError(updateError.message); return; }
    await supabase.from("audit_logs").insert({ user_id: auth.user?.id ?? null, action: "desativado", entity_type: "drop", entity_id: drop.id, details: { reason } });
    setRefresh((value) => value + 1);
  };
  const exportRows = async (allStatuses = false) => {
    setExporting(true);
    setError("");
    try {
      const all = await readAllForExport(filters, allStatuses);
      const rows = all.map((drop) => ({
        ID: drop.legacy_id ?? "",
        Status: drop.status ?? "",
        DROP: drop.name ?? "",
        Parceiro: drop.partner ?? "",
        Responsável: drop.responsible ?? "",
        Telefone: drop.phone ?? "",
        "Telefone alternativo": drop.alternate_phone ?? "",
        Email: drop.email ?? "",
        Zona: drop.zone ?? "",
        Logradouro: drop.address ?? "",
        Número: drop.address_number ?? "",
        Complemento: drop.complement ?? "",
        Bairro: drop.neighborhood ?? "",
        CEP: drop.postal_code ?? "",
        Município: drop.municipality ?? "",
        UF: drop.state ?? "",
        CPF: drop.cpf ?? "",
        CNPJ: drop.cnpj ?? "",
        "Nome empresarial": drop.legal_name ?? "",
        "Nome fantasia": drop.trade_name ?? "",
        "Chave PIX": drop.pix_key ?? "",
        "Nome PIX": drop.pix_holder_name ?? "",
        "Tamanho (m²)": drop.size_sqm ?? "",
        "Endereço CNPJ": drop.company_address ?? "",
        "Número CNPJ": drop.company_address_number ?? "",
        "Complemento CNPJ": drop.company_complement ?? "",
        "Bairro CNPJ": drop.company_neighborhood ?? "",
        "CEP CNPJ": drop.company_postal_code ?? "",
        "Cidade CNPJ": drop.company_municipality ?? "",
        "UF CNPJ": drop.company_state ?? "",
        "Inscrição estadual": drop.state_registration ?? "",
        Latitude: drop.latitude ?? "",
        Longitude: drop.longitude ?? "",
        "Abertura semanal": drop.weekday_opening_time ?? "",
        "Fechamento semanal": drop.weekday_closing_time ?? "",
        "Abertura sábado": drop.saturday_opening_time ?? "",
        "Fechamento sábado": drop.saturday_closing_time ?? "",
        "Bipagem semanal": drop.weekday_scan_time ?? "",
        "Bipagem sábado": drop.saturday_scan_time ?? "",
        Anotações: drop.notes ?? "",
        "Motivo do distrato": drop.termination_reason ?? "",
        "Data da assinatura": drop.signed_at ?? "",
        "Data do distrato": drop.terminated_at ?? "",
        "Data do cadastro": drop.created_at ?? "",
        "Última atualização": drop.updated_at ?? "",
        Ativo: drop.is_active === false ? "NÃO" : "SIM",
        "Motivo da desativação": drop.deactivated_reason ?? "",
        "Data da desativação": drop.deactivated_at ?? "",
      }));
      await (
        await import("./excelDownload")
      ).downloadExcel(
        allStatuses
          ? "todos-cadastros-movidos.xlsx"
          : "cadastros-filtrados-movidos.xlsx",
        "Cadastros",
        rows,
      );
    } catch (caught) {
      setError(
        (caught as Error).message || "Não foi possível gerar o arquivo Excel.",
      );
    } finally {
      setExporting(false);
    }
  };
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  return (
    <div className="cadastros-list-page">
      <section className="card filter-card">
        <div className="filter-title">
          <div>
            <p className="eyebrow">FILTROS</p>
            <h2>Localize um cadastro</h2>
          </div>
          <button
            className="secondary"
            onClick={() => {
              setSearch("");
              setFilters({
                status: "",
                partner: "",
                zone: "",
                query: "",
                page: 0,
              });
            }}
          >
            Limpar filtros
          </button>
        </div>
        <div className="filter-grid">
          <label>
            Busca
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="ID, DROP, responsável ou zona…"
            />
          </label>
          <label>
            Status
            <select
              aria-label="Status"
              value={filters.status}
              onChange={(event) => change("status", event.target.value)}
            >
              <option value="">Todos</option>
              {DROP_STATUSES.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
          </label>
          <label>
            Parceiro
            <select
              aria-label="Parceiro"
              value={filters.partner}
              onChange={(event) => change("partner", event.target.value)}
            >
              <option value="">Todos</option>
              {options.partners.map((partner) => (
                <option key={partner}>{partner}</option>
              ))}
            </select>
          </label>
          <label>
            Zona
            <select
              aria-label="Zona"
              value={filters.zone}
              onChange={(event) => change("zone", event.target.value)}
            >
              <option value="">Todas</option>
              {options.zones.map((zone) => (
                <option key={zone}>{zone}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {(error || optionsError) && (
        <p role="alert" className="error">
          {error || optionsError}
        </p>
      )}
      <section className="toolbar">
        <p className="result-count" role="status">
          {loading
            ? "Carregando…"
            : error
              ? "Não foi possível atualizar a lista."
              : `${count.toLocaleString("pt-BR")} cadastro(s) encontrado(s)`}
        </p>
        <div>
          <button
            className="secondary"
            disabled={loading || exporting}
            onClick={() => void exportRows()}
          >
            {exporting ? "Gerando Excel…" : "Baixar filtrados"}
          </button>
          <button
            className="secondary"
            disabled={loading || exporting}
            onClick={() => void exportRows(true)}
          >
            Baixar todos em Excel
          </button>
          <button
            className="secondary"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Atualizar
          </button>
          <button
            className="primary compact"
            onClick={() => navigate(kind === "last_mile" ? "/cadastros/last-mile/novo" : "/cadastros/novo")}
          >
            + Novo cadastro
          </button>
        </div>
      </section>
      <section className="card">
        <div className="table-wrap">
          <table aria-busy={loading}>
            <thead>
              <tr>
                {[
                  "ID",
                  "Status",
                  "Drop",
                  "Parceiro",
                  "Responsável",
                  "Telefone",
                  "Zona",
                  "Ações",
                ].map((title) => (
                  <th key={title}>{title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((drop) => (
                <tr key={drop.id} className={`${drop.is_active === false ? "inactive-record " : ""}cadastro-row`} title={drop.is_active === false ? drop.deactivated_reason || "Cadastro desativado" : "Clique para abrir o cadastro"} onClick={() => navigate(`/cadastros/novo?edit=${drop.id}`)}>
                  <td>{drop.legacy_id ?? "—"}</td>
                  <td>
                    <span className={`pill status-${statusTone(drop.status)}`}>
                      {drop.status}
                    </span>
                  </td>
                  <td>
                    <strong>{drop.name}</strong>
                    {drop.is_active === false && <small className="table-subtitle">Motivo: {drop.deactivated_reason || "Não informado"}</small>}
                  </td>
                  <td>{drop.partner || "—"}</td>
                  <td>{drop.responsible || "—"}</td>
                  <td>
                    <Phone value={drop.phone} />
                  </td>
                  <td>{drop.zone || "—"}</td>
                  <td>
                    <button
                      className="table-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(`/cadastros/novo?edit=${drop.id}`)
                      }}
                    >
                      Editar
                    </button>
                    {can("cadastros_delete") && drop.is_active !== false && <button className="danger-action" onClick={(event) => { event.stopPropagation(); void deactivate(drop) }}>Desativar</button>}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={8} className="empty">
                    {loading
                      ? "Carregando cadastros…"
                      : error
                        ? "Tente atualizar a lista novamente."
                        : "Nenhum cadastro encontrado para os filtros selecionados."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <nav className="cadastros-pagination" aria-label="Páginas de cadastros">
          <span>
            {loading
              ? "Carregando…"
              : count
                ? `${filters.page * PAGE_SIZE + 1}–${Math.min((filters.page + 1) * PAGE_SIZE, count)} de ${count.toLocaleString("pt-BR")}`
                : "0 cadastros"}
          </span>
          <div>
            <button
              disabled={loading || filters.page === 0}
              onClick={() =>
                setFilters((current) => ({
                  ...current,
                  page: current.page - 1,
                }))
              }
            >
              Anterior
            </button>
            <span>
              Página {filters.page + 1} de {pages}
            </span>
            <button
              disabled={loading || filters.page + 1 >= pages}
              onClick={() =>
                setFilters((current) => ({
                  ...current,
                  page: current.page + 1,
                }))
              }
            >
              Próxima
            </button>
          </div>
        </nav>
      </section>
    </div>
  );
}
function Phone({ value }: { value: string | null }) {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length < 10 ? (
    <>{value || "—"}</>
  ) : (
    <a
      className="cadastro-phone"
      href={`https://wa.me/${digits.length <= 11 ? "55" : ""}${digits}`}
      target="_blank"
      rel="noopener noreferrer"
      title="Abrir conversa no WhatsApp"
    >
      {value}
      <img
        src="/brand/whatsapp.svg"
        alt="WhatsApp"
        width={18}
        height={18}
        loading="lazy"
      />
    </a>
  );
}
