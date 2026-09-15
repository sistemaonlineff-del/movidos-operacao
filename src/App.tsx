// @ts-nocheck
import { FormEvent, Suspense, lazy, useEffect, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { hasSupabaseConfig, supabase } from "./lib/supabase";
import DashboardNotes from "./DashboardNotes";
import DropPhotos from "./DropPhotos";
import DropDocuments from "./DropDocuments";
import MunicipalityInput from "./MunicipalityInput";
const Financeiro = lazy(() => import("./Financeiro"));
const CnabUpload = lazy(() => import("./CnabUpload"));
const ContractTemplateManager = lazy(() => import("./ContractTemplateManager"));
const FinanceiroVisuais = lazy(() => import("./FinanceiroVisuais"));
const Funcionarios = lazy(() => import("./Funcionarios"));
const Configuracoes = lazy(() => import("./Configuracoes"));
const RouteManagement = lazy(() => import("./RouteManagement"));
const ReadyMessages = lazy(() => import("./ReadyMessages"));
const Documents = lazy(() => import("./Documents"));
import { AccessProvider, Guard, useAccess } from "./access";
import LabelReaderGate from "./LabelReaderGate";
import { PARTNERS, ZONES, normalizePartner, normalizeZone } from "./dropOptions";

const Lista = lazy(() => import("./CadastrosLista"));
const DropMap = lazy(() => import("./DropMap"));
const LastMileCadastro = lazy(() => import("./LastMileCadastro"));

type Drop = {
  id: string;
  legacy_id: number | null;
  name: string;
  status: string;
  partner: string | null;
  responsible: string | null;
  phone: string | null;
  address: string | null;
  municipality: string | null;
  state: string | null;
  zone: string | null;
  latitude: number | null;
  longitude: number | null;
  [key: string]: unknown;
};
type Values = Record<string, string>;
const statuses = [
  "INTERESSADO",
  "PICKUP - INTERESSADO",
  "AG. ASSINATURA",
  "CONTRATO ASSINADO",
  "ENVIADO - AG. APROVAÃƒâ€¡ÃƒÆ’O",
  "ATIVO",
  "ATIVO - AG. LOGIN",
  "ATIVO - AG. INSUMOS",
  "CONGELADO",
  "PROBLEMA",
  "EXCLUÃƒÂDO",
];
const ufs = [
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
];
const times = Array.from(
  { length: 48 },
  (_, i) =>
    `${String(Math.floor((i * 30) / 60)).padStart(2, "0")}:${String((i * 30) % 60).padStart(2, "0")}`,
);
const partners = PARTNERS;
const fields = [
  "status",
  "name",
  "partner",
  "responsible",
  "address",
  "address_number",
  "complement",
  "neighborhood",
  "postal_code",
  "municipality",
  "state",
  "phone",
  "alternate_phone",
  "email",
  "latitude",
  "longitude",
  "cpf",
  "monthly_value",
  "pix_key",
  "pix_holder_name",
  "zone",
  "cnpj",
  "state_registration",
  "legal_name",
  "trade_name",
  "company_address",
  "company_address_number",
  "company_complement",
  "company_neighborhood",
  "company_postal_code",
  "company_municipality",
  "company_state",
  "size_sqm",
  "weekday_opening_time",
  "weekday_closing_time",
  "saturday_opening_time",
  "saturday_closing_time",
  "weekday_scan_time",
  "saturday_scan_time",
  "signed_at",
  "terminated_at",
  "termination_reason",
  "notes",
];
const blank = (): Values =>
  Object.fromEntries(
    fields.map((k) => [k, k === "status" ? "INTERESSADO" : ""]),
  );
// O cadastro legado (VBA/Access) gravava horários como "08h00".  Normalizamos
// na leitura para que sejam selecionados corretamente e, ao salvar, permaneçam
// no formato único "08:00".
const normalizeTime = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "--") return "";
  const match = raw.match(/^(\d{1,2})\s*(?:h|:)\s*(\d{2})$/i);
  if (!match) return raw;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return raw;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};
const digits = (v: string) => v.replace(/\D/g, "");
const formatCep = (v: string) =>
  digits(v)
    .slice(0, 8)
    .replace(/(\d{5})(\d)/, "$1-$2");
const formatCpf = (v: string) =>
  digits(v)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
const formatCnpj = (v: string) =>
  digits(v)
    .slice(0, 14)
    .replace(/(\d{2})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1/$2")
    .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
const formatPhone = (v: string) => {
  const n = digits(v).slice(0, 11);
  return n.length <= 10
    ? n.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d{1,4})$/, "$1-$2")
    : n.replace(/(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d{1,4})$/, "$1-$2");
};
const formatMoney = (v: string) => {
  const n = digits(v);
  return n
    ? (Number(n) / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      })
    : "";
};
function Input({
  label,
  value,
  onChange,
  kind = "text",
  items,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  kind?: string;
  items?: string[];
}) {
  const change = (raw: string) => {
    if (kind === "number") onChange(digits(raw));
    else if (kind === "cep") onChange(formatCep(raw));
    else if (kind === "phone") onChange(formatPhone(raw));
    else if (kind === "cpf") onChange(formatCpf(raw));
    else if (kind === "cnpj") onChange(formatCnpj(raw));
    else if (kind === "money") onChange(formatMoney(raw));
    else if (kind === "coordinate")
      onChange(raw.replace(",", ".").replace(/[^0-9.-]/g, ""));
    else if (kind === "area")
      onChange(raw.replace(",", ".").replace(/[^0-9.]/g, ""));
    else onChange(kind === "email" ? raw : raw.toUpperCase());
  };
  return (
    <label>
      {label}
      {items ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Selecionar</option>
          {items.map((item) => <option key={item}>{item}</option>)}
        </select>
      ) : (
        <input
          type={kind === "email" ? "email" : "text"}
          value={value}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </label>
  );
}
function Select({
  label,
  value,
  set,
  items,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  items: string[];
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Selecionar</option>
        {items.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
    </label>
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [register, setRegister] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    const result = register
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) {
      setMessage(
        register && /database error saving new user/i.test(result.error.message)
          ? "O acesso foi criado. Confirme o e-mail e clique em Já tenho acesso."
          : result.error.message,
      );
      return;
    }
    if (register) {
      setMessage("Conta criada. Confirme seu e-mail e entre.");
      return;
    }
    onSuccess();
  };
  return (
    <main className="auth-page">
      <section className="auth-hero">
        <h1>Sistema Movidos</h1>
        <p>Gerenciamento de Dados</p>
      </section>
      <section className="auth-panel">
        <div className="brand-mark">
          <img src="/brand/movidos-fish.png" alt="Movidos" />
        </div>
        <h2>{register ? "Criar acesso" : "Sistema Movidos"}</h2>
        <p>Acesse sua conta.</p>
        <form onSubmit={submit}>
          <label>
            E-mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Senha
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </label>
          {message && <p className="form-message">{message}</p>}
          <button className="primary" disabled={!hasSupabaseConfig}>
            {register ? "Criar conta" : "Entrar no sistema"}
          </button>
        </form>
        <button
          className="link-button"
          onClick={() => {
            setRegister(!register);
            setMessage("");
          }}
        >
          {register ? "JÃ¡ tenho acesso" : "Primeiro acesso? Criar conta"}
        </button>
      </section>
    </main>
  );
}
function Layout({
  children,
  onExit,
}: {
  children: React.ReactNode;
  onExit: () => void;
}) {
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(loc.pathname.startsWith("/cadastros"));
  const title =
    loc.pathname === "/"
      ? "VisÃ£o geral"
      : loc.pathname === "/cadastros"
        ? "Cadastros"
        : loc.pathname === "/cadastros/novo"
          ? "Cadastro"
          : loc.pathname.slice(1);
  return (
    <div className="app">
      <aside>
        <div className="side-brand">
          <img
            className="side-logo"
            src="/brand/movidos-fish.png"
            alt="Movidos"
          />
          <span>
            SISTEMA
            <br />
            <small>MOVIDOS</small>
          </span>
        </div>
        <nav>
          <button
            className={loc.pathname === "/" ? "active" : ""}
            onClick={() => nav("/")}
          >
            VisÃ£o geral
          </button>
          <button
            className={
              loc.pathname.startsWith("/cadastros")
                ? "active nav-parent"
                : "nav-parent"
            }
            onClick={() => setOpen(!open)}
          >
            Cadastros <span>{open ? "âˆ’" : "+"}</span>
          </button>
          {open && (
            <div className="nav-submenu">
              <button
                className={loc.pathname === "/cadastros" ? "sub-active" : ""}
                onClick={() => nav("/cadastros")}
              >
                Ver cadastros
              </button>
              <button
                className={
                  loc.pathname === "/cadastros/novo" ? "sub-active" : ""
                }
                onClick={() => nav("/cadastros/novo")}
              >
                + Novo cadastro
              </button>
            </div>
          )}
          <button onClick={() => nav("/financeiro")}>Financeiro</button>
          <button onClick={() => nav("/funcionarios")}>Funcionários</button>
          <button onClick={() => nav("/documentos")}>Documentos</button>
        </nav>
        <div className="side-bottom">
          <button className="link-button" onClick={onExit}>
            Sair
          </button>
        </div>
      </aside>
      <main className="content">
        <header>
          <div>
            <p className="eyebrow">SISTEMA MOVIDOS</p>
            <h1>{title}</h1>
          </div>
        </header>
        <Suspense
          fallback={
            <section className="card" role="status">
              Carregando...
            </section>
          }
        >
          {children}
        </Suspense>
      </main>
    </div>
  );
}
function useDrops() {
  const [drops, setDrops] = useState<Drop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = async () => {
    if (!supabase) return;
    setLoading(true);
    setError("");
    const all: Drop[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("drops")
        .select("id,name,status,municipality,state,latitude,longitude,is_active")
        .eq("is_active", true)
        .order("legacy_id", { ascending: false, nullsFirst: false })
        .range(from, from + 999);
      if (error) {
        setError(error.message);
        break;
      }
      const page = (data ?? []) as Drop[];
      all.push(...page);
      if (page.length < 1000) break;
    }
    setDrops(all);
    setLoading(false);
  };
  useEffect(() => {
    void refresh();
  }, []);
  return { drops, loading, error, refresh };
}
function Home() {
  const { drops, loading, error } = useDrops();
  const active = drops.filter((d) => d.status.startsWith("ATIVO")).length;
  return (
    <>
      <section className="metric-grid">
        <article className="metric">
          <span>Drops cadastrados</span>
          <strong>{loading ? "â€¦" : drops.length}</strong>
        </article>
        <article className="metric green">
          <span>Ativos</span>
          <strong>{loading ? "â€¦" : active}</strong>
        </article>
        <article className="metric yellow">
          <span>Em andamento</span>
          <strong>
            {loading
              ? "â€¦"
              : drops.filter(
                  (d) =>
                    d.status.includes("INTERESSADO") ||
                    d.status === "AG. ASSINATURA",
                ).length}
          </strong>
        </article>
        <article className="metric red">
          <span>Problemas / congelados</span>
          <strong>
            {loading
              ? "â€¦"
              : drops.filter((d) =>
                  ["PROBLEMA", "CONGELADO"].includes(d.status),
                ).length}
          </strong>
        </article>
      </section>
      {error ? (
        <section className="card error-card">{error}</section>
      ) : (
        <DropMap drops={drops} />
      )}
      <DashboardNotes />
    </>
  );
}
function ContractButtons({ drop }: { drop: Drop | null }) {
  const [state, setState] = useState("");
  if (!drop) return null;
  const generate = async (kind: "service" | "termination") => {
    try {
      setState("Gerando PDF...");
      const template =
        kind === "service"
          ? "/templates/modelo-contrato-prestacao-servico.docx"
          : "/templates/modelo-distrato-sociedade.docx";
      const address = String(drop.address ?? "");
      const business = String(drop.legal_name || drop.trade_name || drop.name);
      const documentDate = (value: unknown) => {
        const raw = String(value ?? "").slice(0, 10);
        return raw ? new Intl.DateTimeFormat("pt-BR").format(new Date(`${raw}T12:00:00`)) : "";
      };
      const data = {
        nomeEmpresarial: business,
        cnpj: String(drop.cnpj ?? ""),
        logradouro: address,
        numero: String(drop.address_number ?? ""),
        bairro: String(drop.neighborhood ?? ""),
        municipio: String(drop.municipality ?? ""),
        uf: String(drop.state ?? ""),
        cep: String(drop.postal_code ?? ""),
        logradouroCNPJ: String(drop.company_address ?? ""),
        numeroCNPJ: String(drop.company_address_number ?? ""),
        bairroCNPJ: String(drop.company_neighborhood ?? ""),
        municipioCNPJ: String(drop.company_municipality ?? ""),
        ufCNPJ: String(drop.company_state ?? ""),
        cepCNPJ: String(drop.company_postal_code ?? ""),
        parceiro: String(drop.partner ?? ""),
        valorPacote:
          drop.monthly_value === null
            ? ""
            : Number(drop.monthly_value).toLocaleString("pt-BR", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
        dataHoje: new Intl.DateTimeFormat("pt-BR", {
          dateStyle: "long",
        }).format(new Date()),
        dataContrato: documentDate(drop.signed_at),
        dataDistrato: documentDate(drop.terminated_at),
        motivoDistrato: String(drop.termination_reason ?? ""),
      };
      const safe = drop.name
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/(^-|-$)/g, "")
        .toLowerCase();
      const { downloadContractPdf } = await import("./contractPdf");
      await downloadContractPdf(
        template,
        data,
        (kind === "service"
          ? "contrato-prestacao-servico-"
          : "distrato-sociedade-") +
          safe +
          ".pdf",
      );
      setState("PDF gerado e baixado.");
    } catch (error) {
      setState(
        error instanceof Error
          ? error.message
          : "Nao foi possivel gerar o PDF.",
      );
    }
  };
  return (
    <>
      <section className="form-section document-actions">
        <h3>Documentos do cadastro</h3>
        <p>
          Os documentos sao preenchidos com os dados deste cadastro e baixados
          em PDF.
        </p>
        <div>
          <button
            type="button"
            className="secondary"
            onClick={() => void generate("service")}
          >
            Baixar contrato em PDF
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void generate("termination")}
          >
            Baixar distrato em PDF
          </button>
        </div>
        {state && <p className="form-message">{state}</p>}
      </section>
      <Suspense fallback={null}>
        <ContractTemplateManager />
      </Suspense>
    </>
  );
}
function Cadastro() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get("edit");
  const [values, setValues] = useState<Values>(blank);
  const [record, setRecord] = useState<Drop | null>(null);
  const [loading, setLoading] = useState(Boolean(editId));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const put = (key: string, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  useEffect(() => {
    if (!editId || !supabase) return;
    supabase
      .from("drops")
      .select("*")
      .eq("id", editId)
      .single()
      .then(({ data, error }) => {
        if (error) setMessage(error.message);
        else {
          setRecord(data as Drop);
          const next = blank();
          fields.forEach(
            (k) =>
              (next[k] =
                data?.[k] === null || data?.[k] === undefined
                  ? ""
                  : k === "monthly_value"
                    ? Number(data[k]).toLocaleString("pt-BR", {
                        style: "currency",
                        currency: "BRL",
                      })
                    : k.endsWith("_time")
                      ? normalizeTime(data[k])
                      : String(data[k])),
          );
          next.partner = normalizePartner(next.partner);
          next.zone = normalizeZone(next.zone);
          setValues(next);
        }
        setLoading(false);
      });
  }, [editId]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    if (!values.name.trim()) {
      setMessage("Informe o Nome do Drop.");
      return;
    }
    const latitude = values.latitude ? Number(values.latitude) : null;
    const longitude = values.longitude ? Number(values.longitude) : null;
    if (
      (latitude !== null &&
        (!Number.isFinite(latitude) || Math.abs(latitude) > 90)) ||
      (longitude !== null &&
        (!Number.isFinite(longitude) || Math.abs(longitude) > 180))
    ) {
      setMessage("Latitude ou longitude invÃ¡lida.");
      return;
    }
    const excluding = values.status.includes("EXCLU");
    let deactivationReason = "";
    if (excluding && (!editId || record?.is_active !== false)) {
      deactivationReason = window.prompt("Informe obrigatoriamente o motivo para desativar este cadastro:")?.trim() ?? "";
      if (!deactivationReason) { setMessage("A observação é obrigatória. O cadastro não foi desativado."); return; }
    }
    const payload: Record<string, unknown> = {};
    fields.forEach((k) => {
      if (k === "latitude") payload[k] = latitude;
      else if (k === "longitude") payload[k] = longitude;
      else if (k === "monthly_value")
        payload[k] = values[k] ? Number(digits(values[k])) / 100 : null;
      else if (k === "size_sqm")
        payload[k] = values[k] ? Number(values[k]) : null;
      else payload[k] = values[k].trim() || null;
    });
    if (excluding) {
      const { data: auth } = await supabase.auth.getUser();
      payload.is_active = false;
      if (deactivationReason) {
        payload.deactivated_reason = deactivationReason;
        payload.deactivated_at = new Date().toISOString();
        payload.deactivated_by = auth.user?.id ?? null;
      }
    } else {
      payload.is_active = true;
      if (record?.is_active === false) {
        payload.deactivated_reason = null;
        payload.deactivated_at = null;
        payload.deactivated_by = null;
      }
    }
    setSaving(true);
    const result = editId
      ? await supabase
          .from("drops")
          .update(payload)
          .eq("id", editId)
          .select()
          .single()
      : await supabase.from("drops").insert(payload).select().single();
    setSaving(false);
    if (result.error) {
      setMessage(result.error.message);
      return;
    }
    setRecord(result.data as Drop);
    setValues(blank());
    setMessage(
      editId
        ? "AlteraÃ§Ã£o salva. FormulÃ¡rio limpo."
        : "Cadastro salvo. FormulÃ¡rio limpo.",
    );
    setTimeout(() => nav("/cadastros"), 550);
  };
  if (loading)
    return <section className="card">Carregando cadastroâ€¦</section>;
  return (
    <>
      <form className="cadastro-form" onSubmit={save}>
        <section className="form-section">
          <h3>{editId ? "Editar cadastro" : "Novo cadastro"}</h3>
          <div className="form-grid">
            <Select
              label="Status"
              value={values.status}
              set={(v) => put("status", v)}
              items={statuses}
            />
            <Input
              label="Nome do Drop"
              value={values.name}
              onChange={(v) => put("name", v)}
            />
            <Select
              label="Parceiro logÃ­stico"
              value={values.partner}
              set={(v) => put("partner", v)}
              items={partners}
            />
            <Input
              label="ResponsÃ¡vel"
              value={values.responsible}
              onChange={(v) => put("responsible", v)}
            />
            <Input
              label="Telefone"
              value={values.phone}
              onChange={(v) => put("phone", v)}
              kind="phone"
            />
            <Input
              label="Telefone alternativo"
              value={values.alternate_phone}
              onChange={(v) => put("alternate_phone", v)}
              kind="phone"
            />
            <Input
              label="E-mail"
              value={values.email}
              onChange={(v) => put("email", v)}
              kind="email"
            />
            <Input
              label="CPF"
              value={values.cpf}
              onChange={(v) => put("cpf", v)}
              kind="cpf"
            />
            <Input
              label="Valor acordado (R$)"
              value={values.monthly_value}
              onChange={(v) => put("monthly_value", v)}
              kind="money"
            />
            <Input
              label="Tamanho do ponto (m²)"
              value={values.size_sqm}
              onChange={(v) => put("size_sqm", v)}
              kind="area"
            />
            <Input
              label="Chave PIX"
              value={values.pix_key}
              onChange={(v) => put("pix_key", v)}
            />
            <Input
              label="Nome PIX"
              value={values.pix_holder_name}
              onChange={(v) => put("pix_holder_name", v)}
            />
          </div>
        </section>
        <section className="form-section">
          <h3>Localização</h3>
          <div className="form-grid">
            <Input
              label="Logradouro"
              value={values.address}
              onChange={(v) => put("address", v)}
            />
            <Input
              label="NÃºmero"
              value={values.address_number}
              onChange={(v) => put("address_number", v)}
              kind="number"
            />
            <Input
              label="Complemento"
              value={values.complement}
              onChange={(v) => put("complement", v)}
            />
            <Input
              label="Bairro"
              value={values.neighborhood}
              onChange={(v) => put("neighborhood", v)}
            />
            <Input
              label="CEP"
              value={values.postal_code}
              onChange={(v) => put("postal_code", v)}
              kind="cep"
            />
            <MunicipalityInput
              label="Município"
              value={values.municipality}
              state={values.state}
              onChange={(v) => put("municipality", v)}
            />
            <Select
              label="UF"
              value={values.state}
              set={(v) => put("state", v)}
              items={ufs}
            />
            <Input
              label="Latitude"
              value={values.latitude}
              onChange={(v) => put("latitude", v)}
              kind="coordinate"
            />
            <Input
              label="Longitude"
              value={values.longitude}
              onChange={(v) => put("longitude", v)}
              kind="coordinate"
            />
            <Input
              label="Zona / RegiÃ£o"
              value={values.zone}
              onChange={(v) => put("zone", v)}
              items={ZONES}
            />
          </div>
        </section>
        <section className="form-section">
          <h3>Dados empresariais</h3>
          <div className="form-grid">
            <Input
              label="CNPJ"
              value={values.cnpj}
              onChange={(v) => put("cnpj", v)}
              kind="cnpj"
            />
            <Input
              label="IE"
              value={values.state_registration}
              onChange={(v) => put("state_registration", v)}
            />
            <Input
              label="Nome empresarial"
              value={values.legal_name}
              onChange={(v) => put("legal_name", v)}
            />
            <Input
              label="Nome fantasia"
              value={values.trade_name}
              onChange={(v) => put("trade_name", v)}
            />
          </div>
        </section>
        <section className="form-section">
          <h3>Endereço do CNPJ</h3>
          <div className="form-grid">
            <Input label="Rua" value={values.company_address} onChange={(v) => put("company_address", v)} />
            <Input label="Número" value={values.company_address_number} onChange={(v) => put("company_address_number", v)} kind="number" />
            <Input label="Complemento" value={values.company_complement} onChange={(v) => put("company_complement", v)} />
            <Input label="Bairro" value={values.company_neighborhood} onChange={(v) => put("company_neighborhood", v)} />
            <Input label="CEP" value={values.company_postal_code} onChange={(v) => put("company_postal_code", v)} kind="cep" />
            <MunicipalityInput label="Cidade" value={values.company_municipality} state={values.company_state} onChange={(v) => put("company_municipality", v)} />
            <Select label="UF" value={values.company_state} set={(v) => put("company_state", v)} items={ufs} />
          </div>
        </section>
        <section className="form-section">
          <h3>HorÃ¡rio de operaÃ§Ã£o</h3>
          <div className="form-grid">
            <Select
              label="Abertura semanal"
              value={values.weekday_opening_time}
              set={(v) => put("weekday_opening_time", v)}
              items={times}
            />
            <Select
              label="Fechamento semanal"
              value={values.weekday_closing_time}
              set={(v) => put("weekday_closing_time", v)}
              items={times}
            />
            <Select
              label="Abertura sÃ¡bado"
              value={values.saturday_opening_time}
              set={(v) => put("saturday_opening_time", v)}
              items={times}
            />
            <Select
              label="Fechamento sÃ¡bado"
              value={values.saturday_closing_time}
              set={(v) => put("saturday_closing_time", v)}
              items={times}
            />
            <Select
              label="HorÃ¡rio bipagem semanal"
              value={values.weekday_scan_time}
              set={(v) => put("weekday_scan_time", v)}
              items={times}
            />
            <Select
              label="HorÃ¡rio bipagem sÃ¡bado"
              value={values.saturday_scan_time}
              set={(v) => put("saturday_scan_time", v)}
              items={times}
            />
            <label className="full">
              AnotaÃ§Ãµes
              <textarea
                value={values.notes}
                onChange={(e) => put("notes", e.target.value.toUpperCase())}
              />
            </label>
          </div>
        </section>
        <section className="form-section">
          <h3>Contrato e distrato</h3>
          <div className="form-grid">
            <label>Data do contrato<input type="date" value={values.signed_at} onChange={(e) => put("signed_at", e.target.value)} /></label>
            <label>Data do distrato<input type="date" value={values.terminated_at} onChange={(e) => put("terminated_at", e.target.value)} /></label>
            <label className="full">Motivo do distrato<textarea value={values.termination_reason} onChange={(e) => put("termination_reason", e.target.value)} placeholder="Informe o motivo, se houver distrato." /></label>
          </div>
        </section>
        <DropPhotos dropId={editId || record?.id || null} />
        <DropDocuments dropId={editId || record?.id || null} />
        {message && <p className="form-message">{message}</p>}
        <div className="modal-actions">
          <button
            type="button"
            onClick={() => {
              setValues(blank());
              nav("/cadastros");
            }}
          >
            Cancelar
          </button>
          <button className="primary compact" disabled={saving}>
            {saving
              ? "Salvandoâ€¦"
              : editId
                ? "Salvar alteraÃ§Ã£o"
                : "Salvar cadastro"}
          </button>
        </div>
      </form>
      <ContractButtons drop={record} />
    </>
  );
}
function Empty({ title }: { title: string }) {
  return (
    <section className="empty-state">
      <span>PRÃ“XIMA ETAPA</span>
      <h2>{title}</h2>
      <p>Este mÃ³dulo serÃ¡ ligado Ã  nova base na prÃ³xima etapa.</p>
    </section>
  );
}
function App() {
  const [logged, setLogged] = useState(false);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (!supabase) {
      setChecking(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setLogged(Boolean(data.session));
      setChecking(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) =>
      setLogged(Boolean(s)),
    );
    return () => listener.subscription.unsubscribe();
  }, []);
  if (checking) return <main className="auth-page" />;
  if (!logged) return <Login onSuccess={() => setLogged(true)} />;
  const exit = async () => {
    await supabase?.auth.signOut();
    setLogged(false);
  };
  return (
    <SecureLayout onExit={() => void exit()}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route
          path="/cadastros"
          element={
            <Guard permission="cadastros_view">
              <Lista />
            </Guard>
          }
        />
        <Route
          path="/cadastros/novo"
          element={
            <Guard permission="cadastros_create">
              <Cadastro />
            </Guard>
          }
        />
        <Route path="/cadastros/last-mile" element={<Guard permission="cadastros_view"><Lista kind="last_mile" /></Guard>} />
        <Route path="/cadastros/last-mile/novo" element={<Guard permission="cadastros_create"><LastMileCadastro /></Guard>} />
        <Route
          path="/financeiro"
          element={
            <Guard permission="financeiro_view">
              <Financeiro />
            </Guard>
          }
        />
        <Route
          path="/financeiro/pagamento-total"
          element={
            <Guard permission="financeiro_view">
              <FinanceiroVisuais kind="total" />
            </Guard>
          }
        />
        <Route
          path="/financeiro/pagamento-detalhes"
          element={
            <Guard permission="financeiro_view">
              <FinanceiroVisuais kind="details" />
            </Guard>
          }
        />
        <Route
          path="/financeiro/cnab"
          element={
            <Guard permission="financeiro_view">
              <CnabUpload />
            </Guard>
          }
        />
        <Route
          path="/financeiro/extravios"
          element={
            <Guard permission="financeiro_view">
              <FinanceiroVisuais kind="losses" />
            </Guard>
          }
        />
        <Route
          path="/funcionarios"
          element={
            <Guard permission="funcionarios_view">
              <Funcionarios />
            </Guard>
          }
        />
        <Route
          path="/extravios"
          element={
            <Guard permission="financeiro_view">
              <FinanceiroVisuais kind="losses" />
            </Guard>
          }
        />
        <Route
          path="/configuracoes"
          element={
            <Guard permission="configuracoes_manage">
              <Configuracoes />
            </Guard>
          }
        />
        <Route path="/leitor-etiquetas" element={<LabelReaderGate />} />
        <Route path="/rotas-entrega" element={<RouteManagementGate />} />
        <Route path="/mensagens" element={<ReadyMessages />} />
        <Route path="/documentos" element={<Documents />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </SecureLayout>
  );
}
function SecureLayout({
  children,
  onExit,
}: {
  children: React.ReactNode;
  onExit: () => void;
}) {
  return (
    <AccessProvider>
      <SecureLayoutInner onExit={onExit}>{children}</SecureLayoutInner>
    </AccessProvider>
  );
}
function SecureLayoutInner({
  children,
  onExit,
}: {
  children: React.ReactNode;
  onExit: () => void;
}) {
  const nav = useNavigate();
  const loc = useLocation();
  const { can, isAdmin, canReadLabels, canManageDeliveryRoutes } = useAccess();
  const [open, setOpen] = useState(loc.pathname.startsWith("/cadastros"));
  const [financeOpen, setFinanceOpen] = useState(
    loc.pathname.startsWith("/financeiro"),
  );
  const labels: Record<string, string> = {
    "/": "Visão geral",
    "/cadastros": "Cadastros",
    "/cadastros/novo": "Novo cadastro",
    "/cadastros/last-mile": "Cadastros Last Mile",
    "/cadastros/last-mile/novo": "Novo cadastro Last Mile",
    "/financeiro": "Financeiro",
    "/financeiro/pagamento-total": "Pagamento Total",
    "/financeiro/pagamento-detalhes": "Pagamento Detalhes",
    "/financeiro/cnab": "Gerar CNAB",
    "/financeiro/extravios": "Extravios",
    "/funcionarios": "Funcionários",
    "/configuracoes": "Configurações",
    "/documentos": "Documentos",
    "/leitor-etiquetas": "Leitor de etiquetas",
    "/rotas-entrega": "Rotas de entrega",
    "/mensagens": "Mensagens prontas",
  };
  return (
    <div className="app">
      <aside>
        <div className="side-brand">
          <img
            className="side-logo"
            src="/brand/movidos-fish.png"
            alt="Movidos"
          />
          <span>
            SISTEMA
            <br />
            <small>MOVIDOS</small>
          </span>
        </div>
        <nav>
          <button
            className={loc.pathname === "/" ? "active" : ""}
            onClick={() => nav("/")}
          >
            Visão geral
          </button>
          {(can("cadastros_view") || can("cadastros_create")) && (
            <>
              <button
                className={
                  loc.pathname.startsWith("/cadastros")
                    ? "active nav-parent"
                    : "nav-parent"
                }
                onClick={() => setOpen(!open)}
              >
                Cadastros <span>{open ? "−" : "+"}</span>
              </button>
              {open && (
                <div className="nav-submenu">
                  {can("cadastros_view") && (
                    <button
                      className={
                        loc.pathname === "/cadastros" ? "sub-active" : ""
                      }
                      onClick={() => nav("/cadastros")}
                    >
                      Ver cadastros Drop off
                    </button>
                  )}
                  {can("cadastros_create") && (
                    <button
                      className={
                        loc.pathname === "/cadastros/novo" ? "sub-active" : ""
                      }
                      onClick={() => nav("/cadastros/novo")}
                    >
                      + Novo cadastro Drop off
                    </button>
                  )}
                  {can("cadastros_view") && <button className={loc.pathname === "/cadastros/last-mile" ? "sub-active" : ""} onClick={() => nav("/cadastros/last-mile")}>Ver cadastros Last Mile</button>}
                  {can("cadastros_create") && <button className={loc.pathname === "/cadastros/last-mile/novo" ? "sub-active" : ""} onClick={() => nav("/cadastros/last-mile/novo")}>+ Novo cadastro Last Mile</button>}
                </div>
              )}
            </>
          )}
          {can("financeiro_view") && (
            <>
              <button
                className={
                  loc.pathname.startsWith("/financeiro")
                    ? "active nav-parent"
                    : "nav-parent"
                }
                onClick={() => setFinanceOpen(!financeOpen)}
              >
                Financeiro <span>{financeOpen ? "−" : "+"}</span>
              </button>
              {financeOpen && (
                <div className="nav-submenu">
                  <button
                    className={
                      loc.pathname === "/financeiro" ? "sub-active" : ""
                    }
                    onClick={() => nav("/financeiro")}
                  >
                    Importar base
                  </button>
                  <button
                    className={
                      loc.pathname === "/financeiro/pagamento-total"
                        ? "sub-active"
                        : ""
                    }
                    onClick={() => nav("/financeiro/pagamento-total")}
                  >
                    Pagamento Total
                  </button>
                  <button
                    className={
                      loc.pathname === "/financeiro/pagamento-detalhes"
                        ? "sub-active"
                        : ""
                    }
                    onClick={() => nav("/financeiro/pagamento-detalhes")}
                  >
                    Pagamento Detalhes
                  </button>
                  <button
                    className={loc.pathname === "/financeiro/extravios" ? "sub-active" : ""}
                    onClick={() => nav("/financeiro/extravios")}
                  >
                    Extravios
                  </button>
                  <button
                    className={loc.pathname === "/financeiro/cnab" ? "sub-active" : ""}
                    onClick={() => nav("/financeiro/cnab")}
                  >
                    Gerar CNAB
                  </button>
                </div>
              )}
            </>
          )}
          {can("funcionarios_view") && (
            <button
              className={loc.pathname === "/funcionarios" ? "active" : ""}
              onClick={() => nav("/funcionarios")}
            >
              Funcionários
            </button>
          )}
          {(isAdmin || can("configuracoes_manage")) && (
            <button
              className={`${loc.pathname === "/configuracoes" ? "active" : ""} nav-settings`}
              onClick={() => nav("/configuracoes")}
            >
              Configurações
            </button>
          )}
          {canReadLabels && (
            <button
              className={`${loc.pathname === "/leitor-etiquetas" ? "active" : ""} nav-label-reader`}
              onClick={() => nav("/leitor-etiquetas")}
            >
              Leitor de etiquetas
            </button>
          )}
          {canManageDeliveryRoutes && (
            <button
              className={`${loc.pathname === "/rotas-entrega" ? "active" : ""} nav-routes`}
              onClick={() => nav("/rotas-entrega")}
            >
              Rotas de entrega
            </button>
          )}
          <button
            className={`${loc.pathname === "/mensagens" ? "active" : ""} nav-messages`}
            onClick={() => nav("/mensagens")}
          >
            Mensagens prontas
          </button>
          <button className={`nav-documents ${loc.pathname === "/documentos" ? "active" : ""}`} onClick={() => nav("/documentos")}>Documentos</button>
        </nav>
        <div className="side-bottom">
          <button className="link-button" onClick={onExit}>
            Sair
          </button>
        </div>
      </aside>
      <main className="content">
        <header>
          <div>
            <p className="eyebrow">SISTEMA MOVIDOS</p>
            <h1>{labels[loc.pathname] ?? loc.pathname.slice(1)}</h1>
          </div>
        </header>
        <Suspense
          fallback={
            <section className="card" role="status">
              Carregando...
            </section>
          }
        >
          {children}
        </Suspense>
      </main>
    </div>
  );
}
function RouteManagementGate() {
  const { loading, canManageDeliveryRoutes } = useAccess();
  if (loading)
    return <section className="card">Carregando permissões...</section>;
  if (!canManageDeliveryRoutes)
    return (
      <section className="card employee-locked">
        <p className="eyebrow">ACESSO RESTRITO</p>
        <h2>Sem permissão</h2>
        <p>Esta área está disponível somente para a conta autorizada.</p>
      </section>
    );
  return <RouteManagement />;
}
export default App;
