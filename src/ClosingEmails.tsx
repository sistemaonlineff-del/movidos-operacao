import { useEffect, useMemo, useRef, useState } from "react";
import type { DataRow } from "./financialData";
import { key, text } from "./financialData";
import { createClosingPdf } from "./financialReport";
import { supabase } from "./lib/supabase";

const legacySubject = "FECHAMENTO 2Q DE JUNHO - IMILE";
const legacyBody = `BOA TARDE!

SEGUE EM ANEXO O FECHAMENTO REFERENTE AO PERÍODO DE 15 A 30/06, 2Q DE JUNHO, DA IMILE DELIVERY.

PEÇO QUE SE ALGUÉM QUISER CONTESTAR É SÓ ENVIAR AS CÂMERAS DO MOMENTO EM QUE A SACA COM AQUELE PACOTE EXTRAVIA FOI FEITA, DO INÍCIO AO FIM DA SACA. NÃO PRECISA SER FILMAGEM QUE MOSTRE O QUE ESTÁ ESCRITO NO PACOTE, MAS PRECISO QUE MOSTRE COLOCANDO NA SACA A MESMA QUANTIDADE DE PACOTES QUE CONSTAM NO SISTEMA E DEPOIS FECHANDO A SACA, SÓ ISSO JÁ É SUFICIENTE. QUEM NÃO TEM CÂMERA, RECOMENDO QUE INVISTA EM UMA BARATINHA COM CARTÃO DE MEMÓRIA E COLOQUE FILMANDO O LOCAL ONDE AS SACAS SÃO FEITAS, COM 2 CARTÕES DE MEMÓRIA É POSSÍVEL GRAVAR 30 DIAS OU MAIS, DEPENDENDO DA CÂMERA.

EM CASO DE DÚVIDAS, ESTAMOS À DISPOSIÇÃO.

ATENCIOSAMENTE,
TALITA PREVIATTI.
(11) 92622-6508`;

type Result = { drop: string; status: string; error: string };

export default function ClosingEmails({
  rows,
  losses,
  periods,
  period,
  partner,
}: {
  rows: DataRow[];
  losses: DataRow[];
  periods: DataRow[];
  period: string;
  partner: string;
}) {
  const [subject, setSubject] = useState(legacySubject);
  const [body, setBody] = useState(legacyBody);
  const [results, setResults] = useState<Result[]>([]);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState("");
  const sending = useRef(false);

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from("email_templates")
      .select("subject,body")
      .eq("key", "financial_closing")
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setSubject(data.subject || legacySubject);
          setBody(data.body || legacyBody);
        }
      });
  }, []);
  useEffect(() => {
    if (!supabase || !period || !partner) {
      setResults([]);
      return;
    }
    supabase
      .from("email_logs")
      .select("drop_name_snapshot,status,error_message")
      .eq("period_label", period)
      .eq("partner", partner)
      .order("sent_at", { ascending: false })
      .limit(100)
      .then(({ data }) => {
        setResults(
          (data ?? []).map((row) => ({
            drop: row.drop_name_snapshot || "",
            status: String(row.status || "").toUpperCase(),
            error: row.error_message || "",
          })),
        );
      });
  }, [period, partner]);

  const groups = useMemo(() => {
    const grouped = new Map<string, DataRow[]>();
    rows.forEach((row) =>
      grouped.set(key(row.drop), [...(grouped.get(key(row.drop)) ?? []), row]),
    );
    return [...grouped.values()];
  }, [rows]);

  const save = async () => {
    if (!supabase) return;
    setSaving(true);
    setMessage("");
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("email_templates")
      .upsert({
        key: "financial_closing",
        subject,
        body,
        updated_by: auth.user?.id ?? null,
      });
    setSaving(false);
    setMessage(error ? error.message : "Modelo de e-mail salvo com sucesso!");
  };

  const requestMail = async (payload?: DataRow) => {
    const session = await supabase?.auth.getSession();
    const token = session?.data.session?.access_token;
    if (!token) throw new Error("Entre novamente no sistema.");
    const response = await fetch("/api/financial/send-closing", {
      method: payload ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("O serviço de envio direto ainda não está disponível neste ambiente.");
    }
    const result = await response.json();
    return { ...result, ok: response.ok, httpStatus: response.status };
  };

  const prepare = async () => {
    if (sending.current) return;
    if (!period || !partner || !subject.trim() || !body.trim()) {
      setMessage(
        "Selecione período e parceiro e preencha o assunto e o texto do e-mail.",
      );
      return;
    }
    sending.current = true;
    setPreparing(true);
    setMessage("");
    const next: Result[] = [];
    try {
      const configuration = await requestMail();
      if (!configuration.ok) throw new Error(configuration.error || "Envio não configurado.");
      if (!window.confirm(`Enviar o fechamento ${period} de ${partner} para ${groups.length} DROP(s), usando ${configuration.from}?`)) return;
      setResults([]);
      for (const group of groups) {
        const row = group[0];
        if (!row.dropId || !row.periodId) {
          next.push({ drop: text(row.drop), status: "ERRO", error: "Confira o vínculo do DROP com o cadastro e o período." });
          setResults([...next]);
          continue;
        }
        let pdf: string;
        try {
          pdf = createClosingPdf(group, losses, periods).output("datauristring").split(",")[1];
        } catch {
          next.push({ drop: text(row.drop), status: "ERRO", error: "Não foi possível gerar o PDF." });
          setResults([...next]);
          continue;
        }
        setMessage(`Enviando ${next.length + 1} de ${groups.length}: ${text(row.drop)}`);
        try {
          const result = await requestMail({ dropId: row.dropId, periodId: row.periodId, period, partner, subject, body, pdf });
          const status = result.status === "aceito" ? "ACEITO" : result.status === "incerto" ? "INCERTO" : "ERRO";
          next.push({ drop: text(row.drop), status, error: result.error || (result.duplicate ? "Já aceito anteriormente; não reenviado." : "") });
          setResults([...next]);
          if (status === "INCERTO" || [401, 403, 503].includes(result.httpStatus)) break;
        } catch {
          next.push({ drop: text(row.drop), status: "INCERTO", error: "Conexão interrompida. Confira a caixa remetente antes de tentar novamente." });
          setResults([...next]);
          break;
        }
      }
      setMessage(`Aceitos pelo servidor de e-mail: ${next.filter(item => item.status === "ACEITO").length}. Sem confirmação: ${next.filter(item => item.status === "INCERTO").length}. Erros: ${next.filter(item => item.status === "ERRO").length}. Não processados: ${groups.length - next.length}.`);
    } catch (caught) {
      setMessage((caught as Error).message || "Não foi possível iniciar o envio.");
    } finally {
      sending.current = false;
      setPreparing(false);
    }
  };

  return (
    <section className="card closing-emails">
      <div className="closing-email-heading">
        <div>
          <p className="eyebrow">E-MAIL</p>
          <h3>Enviar fechamento por e-mail</h3>
        </div>
        <div>
          <button
            className="secondary"
            disabled={saving || preparing}
            onClick={() => void save()}
          >
            {saving ? "Salvando…" : "Salvar modelo"}
          </button>
          <button
            className="primary compact"
            disabled={preparing || !groups.length || !period || !partner}
            onClick={() => void prepare()}
          >
            {preparing ? "Enviando…" : "Enviar e-mails"}
          </button>
        </div>
      </div>
      <div className="email-template-grid">
        <label>
          Assunto do e-mail
          <input
            disabled={preparing}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
        <label className="full">
          Texto do e-mail
          <textarea
            disabled={preparing}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
      </div>
      {(!period || !partner) && (
        <p className="financial-hint">
          Selecione um período e um parceiro nos filtros acima.
        </p>
      )}
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      {results.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>DROP</th>
                <th>Status</th>
                <th>Erro do e-mail</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, index) => (
                <tr key={`${result.drop}-${index}`}>
                  <td>{result.drop}</td>
                  <td>
                    <span
                      className={`pill ${["ERRO", "INCERTO", "ENVIANDO"].includes(result.status) ? "status-problem" : "status-active"}`}
                    >
                      {result.status}
                    </span>
                  </td>
                  <td>{result.error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
