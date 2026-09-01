r"""Importação idempotente do staging Access para Supabase.

Uso (PowerShell, após executar schema.sql e 02_post_schema.sql):
  $env:SUPABASE_URL = 'https://<project-ref>.supabase.co'
  $env:SUPABASE_SECRET_KEY = '<nova secret key>'
  python .\supabase\import_to_supabase.py

As credenciais existem apenas na memória daquela sessão. Não as grave em arquivo,
não as envie por chat e não as use no front-end.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).parent
STAGING = ROOT / "staging"
load_dotenv(ROOT.parent / "backend" / ".env")
BASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SECRET = os.environ.get("SUPABASE_SECRET_KEY", "")

if not BASE_URL or not SECRET:
    raise SystemExit("Defina SUPABASE_URL e SUPABASE_SECRET_KEY somente nesta sessão antes de importar.")

HEADERS = {
    "apikey": SECRET,
    "Authorization": f"Bearer {SECRET}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
}
VALID_STATUSES = {
    "INTERESSADO", "PICKUP - INTERESSADO", "AG. ASSINATURA", "CONTRATO ASSINADO",
    "ENVIADO - AG. APROVAÇÃO", "ATIVO", "ATIVO - AG. LOGIN", "ATIVO - AG. INSUMOS",
    "CONGELADO", "PROBLEMA", "EXCLUÍDO",
}


def load(name: str) -> list[dict[str, Any]]:
    with (STAGING / f"{name}.json").open(encoding="utf-8-sig") as source:
        return json.load(source)


def clean(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if value is not None and value != ""}


def date(value: Any) -> str | None:
    if not value:
        return None
    raw = str(value).strip()
    if re.match(r"^\d{2}/\d{2}/\d{4}$", raw):
        return datetime.strptime(raw, "%d/%m/%Y").date().isoformat()
    return raw[:10]


def timestamp(value: Any) -> str | None:
    if not value:
        return None
    raw = str(value)
    try:
        serial = number(raw)
        if serial is not None and 1 < serial < 100000:
            return (datetime(1899, 12, 30) + timedelta(days=serial)).isoformat()
    except (OverflowError, ValueError):
        pass
    for pattern in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, pattern).isoformat()
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return raw


def number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    raw = str(value).strip().replace("R$", "").replace(" ", "")
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


def integer(value: Any) -> int | None:
    converted = number(value)
    return int(converted) if converted is not None else None


def coordinate(value: Any, limit: float) -> float | None:
    converted = number(value)
    return converted if converted is not None and -limit <= converted <= limit else None


def post(table: str, rows: list[dict[str, Any]], conflict: str) -> None:
    for start in range(0, len(rows), 250):
        batch = rows[start:start + 250]
        # PostgREST exige que objetos enviados no mesmo array tenham as mesmas chaves.
        keys = set().union(*(row.keys() for row in batch))
        batch = [{key: row.get(key) for key in keys} for row in batch]
        response = requests.post(
            f"{BASE_URL}/rest/v1/{table}", headers=HEADERS,
            params={"on_conflict": conflict}, json=batch, timeout=60,
        )
        if not response.ok:
            raise RuntimeError(f"Falha ao inserir em {table} (lote {start // 250 + 1}): {response.status_code} {response.text}")
    print(f"{table}: {len(rows)} registros enviados")


def fetch(table: str, columns: str) -> list[dict[str, Any]]:
    response = requests.get(
        f"{BASE_URL}/rest/v1/{table}", headers=HEADERS,
        params={"select": columns, "limit": 10000}, timeout=60,
    )
    response.raise_for_status()
    return response.json()


def legacy_drop_name(row: dict[str, Any]) -> str:
    return (row.get("Drop") or "").strip() or f"LEGADO-{row['ID']}"


def main() -> None:
    source_drops = load("TB_DROPS")
    drops = []
    for row in source_drops:
        status = (row.get("Status") or "INTERESSADO").strip()
        drops.append(clean({
            "legacy_id": row["ID"], "name": legacy_drop_name(row), "status": status if status in VALID_STATUSES else "INTERESSADO",
            "partner": row.get("Parceiro"), "responsible": row.get("Responsavel"), "cpf": row.get("CPF"),
            "phone": row.get("Tel"), "alternate_phone": row.get("Tel1"), "email": row.get("Email"), "zone": row.get("Zona"),
            "weekday_opening_time": row.get("HASem"), "weekday_closing_time": row.get("HFSem"),
            "saturday_opening_time": row.get("HASab"), "saturday_closing_time": row.get("HFSab"),
            "weekday_scan_time": row.get("HorarioBipagemSem"), "saturday_scan_time": row.get("HorarioBipagemSab"),
            "address": row.get("Logradouro"), "address_number": row.get("Numero"), "complement": row.get("Complemento"),
            "neighborhood": row.get("Bairro"), "postal_code": row.get("CEP"), "municipality": row.get("Municipio"), "state": row.get("UF"),
            "monthly_value": number(row.get("Valor")), "pix_key": row.get("Pix"), "pix_holder_name": row.get("NomePix"), "notes": (row.get("Anotações") or "") + (f"\n[Valor legado não numérico: {row['Valor']}]" if row.get("Valor") and number(row.get("Valor")) is None else "") + (f"\n[Coordenadas legadas inválidas: {row.get('Latitude')}, {row.get('Longitude')}]" if (row.get("Latitude") and coordinate(row.get("Latitude"), 90) is None) or (row.get("Longitude") and coordinate(row.get("Longitude"), 180) is None) else ""),
            "cnpj": row.get("CNPJ"), "state_registration": row.get("IE"), "legal_name": row.get("NomeEmpresarial"), "trade_name": row.get("NomeFantasia"),
            "company_address": row.get("LogradouroCNPJ"), "company_address_number": row.get("NumeroCNPJ"), "company_complement": row.get("ComplementoCNPJ"),
            "company_postal_code": row.get("CEPCNPJ"), "company_neighborhood": row.get("BairroCNPJ"), "company_municipality": row.get("MunicipioCNPJ"), "company_state": row.get("UFCNPJ"),
            "signed_at": date(row.get("DataAssinatura")), "terminated_at": date(row.get("DataDistrato")), "termination_reason": row.get("MotivoDistrato"),
            "start_period": row.get("PeriodoInicio"), "end_period": row.get("PeriodoFim"), "latitude": coordinate(row.get("Latitude"), 90), "longitude": coordinate(row.get("Longitude"), 180),
        }))
    post("drops", drops, "legacy_id")

    period_index: dict[tuple[str, str], dict[str, Any]] = {}
    for row in load("TB_FINANCEIRO_GERAL") + load("TB_FINANCEIRO_DROPS"):
        label, partner = row.get("Periodo"), row.get("Parceiro")
        if label and partner:
            period_index[(label, partner)] = clean({"label": label, "partner": partner, "payment_date": date(row.get("DataPagamento")), "net_amount": number(row.get("TotalLiquidoAReceber"))})
    post("financial_periods", list(period_index.values()), "label,partner")

    drop_ids = {row["legacy_id"]: row["id"] for row in fetch("drops", "id,legacy_id")}
    drop_by_name = {(row.get("name") or "", row.get("partner") or ""): row["id"] for row in fetch("drops", "id,name,partner")}
    period_ids = {(row["label"], row["partner"]): row["id"] for row in fetch("financial_periods", "id,label,partner")}

    financial_items = []
    for row in load("TB_FINANCEIRO_DROPS"):
        key = (row.get("Periodo"), row.get("Parceiro"))
        financial_items.append(clean({"legacy_id": row["ID"], "financial_period_id": period_ids.get(key), "drop_id": drop_by_name.get((row.get("Drop") or "", row.get("Parceiro") or "")), "drop_name_snapshot": row.get("Drop") or f"LEGADO-FIN-{row['ID']}", "quantity_packages": integer(row.get("QuantidadePacote")) or 0, "reimbursement": number(row.get("Reembolso")) or 0, "unit_value": 0}))
    post("financial_drop_items", financial_items, "legacy_id")

    losses = []
    for row in load("TB_FINANCEIRO_EXTRAVIO"):
        key = (row.get("Periodo"), row.get("Parceiro"))
        losses.append(clean({"legacy_id": row["ID"], "financial_period_id": period_ids.get(key), "drop_id": drop_by_name.get((row.get("Drop") or "", row.get("Parceiro") or "")), "period_label": row.get("Periodo"), "partner": row.get("Parceiro"), "drop_name_snapshot": row.get("Drop"), "waybill": row.get("Waybill"), "label_code": row.get("CodigoEtiqueta"), "bag_code": row.get("Saca"), "seller": row.get("Seller"), "received_at": timestamp(row.get("DataRecebimento")), "status": row.get("Status"), "observation": row.get("Obs"), "amount": number(row.get("ValorExtravio")) or 0}))
    post("loss_events", losses, "legacy_id")

    history = []
    for row in load("TB_FINANCEIRO_HISTORICO_PAGAMENTOS"):
        key = (row.get("Periodo"), row.get("Parceiro"))
        history.append(clean({"legacy_id": row["ID"], "financial_period_id": period_ids.get(key), "drop_id": drop_ids.get(row.get("IDDrop")), "period_label": row.get("Periodo"), "partner": row.get("Parceiro"), "drop_name_snapshot": row.get("Drop"), "responsible": row.get("Responsavel"), "amount": number(row.get("Valor")), "package_quantity": integer(row.get("Pacotes")), "subtotal": number(row.get("Subtotal")), "loss_amount": number(row.get("Extravio")), "reimbursement": number(row.get("Reembolso")), "total_receivable": number(row.get("TotalReceber")), "pix_key": row.get("Pix"), "pix_holder_name": row.get("NomePix"), "email": row.get("Email"), "observation": row.get("Observacao"), "frozen_at": timestamp(row.get("DataCongelamento")), "paid_at": timestamp(row.get("DataPagamento")), "cnpj": row.get("CNPJ")}))
    post("financial_payment_history", history, "legacy_id")

    emails = []
    for row in load("TB_ENVIO_EMAIL"):
        key = (row.get("Periodo"), row.get("Parceiro"))
        emails.append(clean({"legacy_id": row["ID"], "financial_period_id": period_ids.get(key), "drop_id": drop_by_name.get((row.get("Drop") or "", row.get("Parceiro") or "")), "recipient_email": row.get("Email"), "status": "enviado" if row.get("StatusEnvio") == "ENVIADO" else "erro", "error_message": row.get("ErroEmail"), "sent_at": timestamp(row.get("DataHora"))}))
    post("email_logs", emails, "legacy_id")
    print("Migração concluída. Reexecute o script sem risco de duplicação se for necessário.")


if __name__ == "__main__":
    main()
