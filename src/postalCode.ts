export type PostalAddress = { street: string; neighborhood: string; city: string; state: string };
export const postalAddressFields = ["street", "neighborhood", "city", "state"] as const;
export type PostalAddressField = typeof postalAddressFields[number];

export const postalCodeDigits = (value: string) => value.replace(/\D/g, "");
export function formatPostalCode(value: string) {
  const digits = postalCodeDigits(value).slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

export class PostalCodeError extends Error {
  constructor(public code: "invalid" | "network" | "timeout" | "response", message: string) {
    super(message);
    this.name = "PostalCodeError";
  }
}

export async function lookupPostalCode(value: string, options: {
  signal?: AbortSignal; fetcher?: typeof fetch; timeoutMs?: number;
} = {}): Promise<PostalAddress | null> {
  const digits = postalCodeDigits(value);
  if (digits.length !== 8) throw new PostalCodeError("invalid", "Informe um CEP com 8 digitos.");
  const { signal, fetcher = fetch, timeoutMs = 8000 } = options;
  if (signal?.aborted) throw new DOMException("Consulta cancelada.", "AbortError");
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(timedOut
    ? new PostalCodeError("timeout", "A consulta do CEP demorou demais. Tente novamente.")
    : new DOMException("Consulta cancelada.", "AbortError"));
  const cancel = () => controller.abort();
  controller.signal.addEventListener("abort", onAbort, { once: true });
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await Promise.race([aborted, (async () => {
      let response: Response;
      try {
        response = await fetcher(`https://viacep.com.br/ws/${digits}/json/`, {
          signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer",
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new PostalCodeError("network", "Nao foi possivel consultar o CEP. Tente novamente.");
      }
      if (!response.ok) throw new PostalCodeError("network", "Servico de CEP indisponivel. Tente novamente.");
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new PostalCodeError("response", "Resposta de CEP invalida. Tente novamente."); }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new PostalCodeError("response", "Resposta de CEP invalida. Tente novamente.");
      }
      const record = data as Record<string, unknown>;
      if (record.erro === true || record.erro === "true") return null;
      if (record.cep !== undefined && (typeof record.cep !== "string" || postalCodeDigits(record.cep) !== digits)) {
        throw new PostalCodeError("response", "O servico retornou outro CEP. Tente novamente.");
      }
      const text = (key: string) => typeof record[key] === "string" ? record[key].trim() : "";
      const address = { street: text("logradouro"), neighborhood: text("bairro"), city: text("localidade"), state: text("uf").toUpperCase() };
      if (!postalAddressFields.some(field => address[field]) || (address.state && !/^[A-Z]{2}$/.test(address.state))) {
        throw new PostalCodeError("response", "Resposta de CEP invalida. Tente novamente.");
      }
      return address;
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export function mergePostalAddress(current: PostalAddress, found: PostalAddress, options: {
  initial?: PostalAddress; editedFields?: ReadonlySet<PostalAddressField>; overwrite?: boolean;
} = {}): { address: PostalAddress; conflicts: PostalAddressField[] } {
  const address = { ...current };
  const conflicts: PostalAddressField[] = [];
  for (const field of postalAddressFields) {
    if (!found[field].trim() || options.editedFields?.has(field) ||
      (options.initial && current[field] !== options.initial[field])) continue;
    if (!current[field].trim()) address[field] = found[field];
    else if (current[field].trim() !== found[field].trim()) {
      if (options.overwrite) address[field] = found[field];
      else conflicts.push(field);
    }
  }
  return { address, conflicts };
}