import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { formatPostalCode, lookupPostalCode, mergePostalAddress, postalAddressFields, postalCodeDigits } from "./postalCode";
import type { PostalAddress, PostalAddressField } from "./postalCode";
import "./postal-code.css";

export type PostalCodeLookupProps = {
  value: string;
  onChange: (value: string) => void;
  address: PostalAddress;
  onAddress: (address: PostalAddress) => void;
};

type LookupRequest = {
  value: string;
  initial: PostalAddress;
  observed: PostalAddress;
  editedFields: Set<PostalAddressField>;
  controller: AbortController;
  invalidated: boolean;
};
type LookupState = {
  phase: "idle" | "waiting" | "loading" | "found" | "not-found" | "error";
  message?: string;
  found?: PostalAddress;
  request?: LookupRequest;
  applied?: boolean;
};

export default function PostalCodeLookup({ value, onChange, address, onAddress }: PostalCodeLookupProps) {
  const inputId = useId();
  const [lookup, setLookup] = useState<LookupState>({ phase: "idle" });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef({ value, address, onAddress });
  const active = useRef<LookupRequest | null>(null);

  useLayoutEffect(() => {
    latest.current = { value, address, onAddress };
    const request = active.current;
    if (!request) return;
    if (request.value !== value) {
      request.invalidated = true;
      request.controller.abort();
    }
    for (const field of postalAddressFields) {
      if (request.observed[field] !== address[field]) request.editedFields.add(field);
    }
    request.observed = { ...address };
  });

  useEffect(() => {
    if (postalCodeDigits(value).length !== 8) {
      setLookup({ phase: "idle" });
      return;
    }
    const request: LookupRequest = {
      value, initial: { ...latest.current.address }, observed: { ...latest.current.address },
      editedFields: new Set(), controller: new AbortController(), invalidated: false,
    };
    active.current = request;
    const isCurrent = () => active.current === request && !request.invalidated &&
      !request.controller.signal.aborted && latest.current.value === request.value;
    setLookup({ phase: "waiting" });
    const timer = setTimeout(async () => {
      if (!isCurrent()) return;
      setLookup({ phase: "loading" });
      try {
        const found = await lookupPostalCode(value, { signal: request.controller.signal });
        if (!isCurrent()) return;
        if (!found) { setLookup({ phase: "not-found" }); return; }
        const merged = mergePostalAddress(latest.current.address, found, request);
        if (postalAddressFields.some(field => merged.address[field] !== latest.current.address[field])) {
          request.observed = { ...merged.address };
          latest.current.onAddress(merged.address);
        }
        setLookup({ phase: "found", found, request });
      } catch (error) {
        if (!isCurrent()) return;
        setLookup({ phase: "error", message: error instanceof Error ? error.message : "Falha na consulta do CEP." });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      request.invalidated = true;
      request.controller.abort();
      if (active.current === request) active.current = null;
    };
  }, [value, attempt]);

  const currentResult = lookup.request && !lookup.request.invalidated && lookup.request.value === value;
  const conflicts = currentResult && lookup.found
    ? mergePostalAddress(address, lookup.found, lookup.request).conflicts : [];
  const applyAddress = () => {
    const request = lookup.request;
    if (!lookup.found || !request || request !== active.current || request.invalidated ||
      latest.current.value !== request.value) return;
    const merged = mergePostalAddress(latest.current.address, lookup.found, { ...request, overwrite: true });
    request.observed = { ...merged.address };
    if (postalAddressFields.some(field => merged.address[field] !== latest.current.address[field])) {
      latest.current.onAddress(merged.address);
    }
    setLookup({ ...lookup, applied: true });
  };

  return <div className="postal-code-lookup">
    <label htmlFor={inputId}>CEP</label>
    <input id={inputId} type="text" inputMode="numeric" autoComplete="postal-code" maxLength={9}
      value={formatPostalCode(value)} aria-describedby={`${inputId}-status`}
      onChange={event => {
        const next = formatPostalCode(event.target.value);
        if (next !== value) {
          if (active.current) {
            active.current.invalidated = true;
            active.current.controller.abort();
          }
          setLookup({ phase: "idle" });
          onChange(next);
        }
      }} />
    <div id={`${inputId}-status`} className={`postal-code-feedback postal-code-${lookup.phase}`}
      role={lookup.phase === "error" ? "alert" : "status"} aria-live="polite" aria-atomic="true">
      {lookup.phase === "loading" && "Consultando CEP..."}
      {lookup.phase === "not-found" && "CEP n\u00e3o encontrado."}
      {lookup.phase === "error" && lookup.message}
      {lookup.phase === "found" && currentResult && (conflicts.length
        ? "Endere\u00e7o diferente do cadastro." : lookup.applied ? "Endere\u00e7o aplicado." : "CEP localizado.")}
    </div>
    {conflicts.length > 0 && lookup.found && <div className="postal-code-suggestion">
      <p>{postalAddressFields.map(field => lookup.found?.[field]).filter(Boolean).join(", ")}</p>
      <button type="button" onClick={applyAddress}>{"Aplicar endere\u00e7o"}</button>
    </div>}
    {(lookup.phase === "error" || lookup.phase === "not-found") &&
      <button type="button" onClick={() => setAttempt(current => current + 1)}>Tentar novamente</button>}
  </div>;
}