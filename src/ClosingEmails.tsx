import { useEffect, useMemo, useState } from "react";
import type { DataRow } from "./financialData";
import { key, text } from "./financialData";
import { createClosingPdf } from "./financialReport";
import { downloadOutlookDraft, safeFileName } from "./emailDraft";
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

  const log = async (
    row: DataRow,
    status: "preparado" | "erro",
    errorMessage: string,
    attachmentName: string,
  ) => {
    if (!supabase) return;
    await supabase
      .from("email_logs")
      .insert({
        financial_period_id: row.periodId || null,
        drop_id: row.dropId || null,
        period_label: period,
        partner,
        drop_name_snapshot: text(row.drop),
        responsible: text(row.responsible) || null,
        recipient_email: text(row.email) || null,
        status,
        error_message: errorMessage || null,
        subject,
        attachment_name: attachmentName || null,
      });
  };

  const prepare = async () => {
    if (!period || !partner) {
      setMessage(
        "Selecione um período e um parceiro antes de preparar os e-mails.",
      );
      return;
    }
    setPreparing(true);
    setMessage("");
    setResults([]);
    const next: Result[] = [];
    for (const group of groups) {
      const row = group[0],
        email = text(row.email);
      if (!email) {
        next.push({
          drop: text(row.drop),
          status: "ERRO",
          error: "E-mail vazio",
        });
        await log(row, "erro", "E-mail vazio", "");
        continue;
      }
      try {
        const attachmentName = `${safeFileName(`${text(row.drop)} - ${period}`) || "fechamento"}.pdf`;
        downloadOutlookDraft({
          to: email,
          subject,
          body,
          attachmentName,
          pdf: createClosingPdf(group, losses, periods),
        });
        next.push({ drop: text(row.drop), status: "PREPARADO", error: "" });
        await log(row, "preparado", "", attachmentName);
      } catch (caught) {
        const error =
          (caught as Error).message || "Não foi possível preparar o e-mail.";
        next.push({ drop: text(row.drop), status: "ERRO", error });
        await log(row, "erro", error, "");
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    setResults(next);
    setPreparing(false);
    setMessage(
      `Processo concluído! Preparados: ${next.filter((item) => item.status === "PREPARADO").length}. Erros: ${next.filter((item) => item.status === "ERRO").length}. Abra cada arquivo .eml no Outlook, confira e clique em Enviar.`,
    );
  };

  return (
    <section className="card closing-emails">
      <div className="closing-email-heading">
        <div>
          <p className="eyebrow">E-MAIL</p>
          <h3>Enviar fechamento por e-mail</h3>
          <p>
            Igual ao sistema antigo: prepara uma mensagem do Outlook por DROP,
            com o PDF anexado, para conferência antes do envio.
          </p>
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
            disabled={preparing || !groups.length}
            onClick={() => void prepare()}
          >
            {preparing ? "Preparando…" : "Preparar e-mails no Outlook"}
          </button>
        </div>
      </div>
      <div className="email-template-grid">
        <label>
          Assunto do e-mail
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
        <label className="full">
          Texto do e-mail
          <textarea
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
                      className={`pill ${result.status === "ERRO" ? "status-problem" : "status-active"}`}
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
