"""Gemeinsame Helfer für die Taxonomie-Offline-Skripte (Etappe B/C + D).

READ-ONLY gegenüber der Datenbank. Spiegelt die Verbindungslogik aus
db/database.ts (non-test-Zweig) und liest die kanonischen Slugs direkt aus
documents/tax-sections.ts bzw. documents/taxonomy.ts (eine Quelle der Wahrheit).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import psycopg2

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).resolve().parent / "out"


# ── DB-Verbindung (Spiegel von db/database.ts) ──────────────────────────────
def connection_string() -> str:
    explicit = os.environ.get("POSTGRES_CONNECTION_STRING")
    if explicit:
        return explicit
    host = os.environ.get("POSTGRES_HOST", "localhost")
    port = os.environ.get("POSTGRES_PORT", "5432")
    user = os.environ.get("POSTGRES_USER", "postgres")
    password = os.environ.get("POSTGRES_PASSWORD", "postgres")
    database = os.environ.get("POSTGRES_DATABASE", "fk_encore")
    return f"postgres://{user}:{password}@{host}:{port}/{database}"


def connect():
    conn = psycopg2.connect(connection_string())
    conn.set_session(readonly=True, autocommit=True)
    return conn


def safe_dsn() -> str:
    return re.sub(r":[^:@/]+@", ":***@", connection_string())


# ── Kanonische Slugs aus dem TS-Quelltext ───────────────────────────────────
def tax_sections() -> list[dict]:
    """[{slug, group, name}] aus documents/tax-sections.ts."""
    text = (REPO_ROOT / "documents" / "tax-sections.ts").read_text(encoding="utf8")
    out = []
    for m in re.finditer(
        r'slug:\s*"([^"]+)",\s*group:\s*"([^"]+)",\s*name:\s*"([^"]+)"', text
    ):
        out.append({"slug": m.group(1), "group": m.group(2), "name": m.group(3)})
    return out


def taxonomy_slugs() -> list[str]:
    text = (REPO_ROOT / "documents" / "taxonomy.ts").read_text(encoding="utf8")
    return re.findall(r'slug:\s*"([^"]+)"', text)


def tax_sections_with_hints() -> list[dict]:
    """[{slug, group, name, hint}] aus documents/tax-sections.ts.

    Separat von `tax_sections()` (die keinen Hint braucht, z.B. `mine_hints.py`),
    damit dort nichts kaputtgeht. Wird vom Cloud-Audit genutzt, um Claude
    dieselbe Sektions-Beschreibung wie dem lokalen Klassifikator zu zeigen.
    """
    text = (REPO_ROOT / "documents" / "tax-sections.ts").read_text(encoding="utf8")
    out = []
    for m in re.finditer(
        r'slug:\s*"([^"]+)",\s*group:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*'
        r'hint:\s*"((?:[^"\\]|\\.)*)"',
        text,
    ):
        out.append({
            "slug": m.group(1),
            "group": m.group(2),
            "name": m.group(3),
            "hint": m.group(4).replace('\\"', '"'),
        })
    return out


# ── PII-Scrubbing für anonymisierten Cloud-Export ───────────────────────────
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b")
_AMOUNT = re.compile(r"\b\d{1,3}(?:[.\s]\d{3})*,\d{2}\s?(?:€|EUR)?\b")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\s/-]{6,}\d)(?!\d)")
_DATE = re.compile(r"\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b")
_LONGNUM = re.compile(r"\b\d{6,}\b")  # Kunden-/Steuer-/Versichertennummern

# Grobe Absender-Typisierung (Klarname → Typ), damit der Absender nicht im
# Klartext die Maschine verlässt, der Typ aber als Signal erhalten bleibt.
_SENDER_TYPES = [
    (re.compile(r"bank|comdirect|dkb|\bing\b|sparkasse|volksbank|trade republic|scalable|broker", re.I), "Bank/Broker"),
    (re.compile(r"versicherung|lebensvers|allianz|axa|huk|kravag|generali", re.I), "Versicherung"),
    (re.compile(r"krankenkasse|krankenvers|aok|barmer|techniker|hallesche|gesundheitskasse", re.I), "Kranken-/Pflegekasse"),
    (re.compile(r"finanzamt|kirchensteuer|steueramt|steuerberat|treukontax", re.I), "Finanzamt/Steuer"),
    (re.compile(r"\barzt\b|\bdr\.? med|klinik|praxis|caritas|sozialstation|pflege", re.I), "Arzt/Pflege"),
    (re.compile(r"rentenversicherung|\bdrv\b|versorgung", re.I), "Renten-/Versorgung"),
    (re.compile(r"stadt|gemeinde|landratsamt|behörde|amt\b", re.I), "Behörde"),
    (re.compile(r"gymnasium|schule|hochschule|universität|kita", re.I), "Bildung"),
    (re.compile(r"stadtwerke|lechwerke|energie|strom|gas|telekom|vodafone", re.I), "Versorger/Telekom"),
]


def sender_type(sender: str | None) -> str:
    if not sender:
        return "unbekannt"
    for rx, label in _SENDER_TYPES:
        if rx.search(sender):
            return label
    return "sonstiger Absender"


_ADDRESS_FRAGMENTS = [
    "bahnhofstr", "bahnhofstraße", "bahnhofstrasse",
    "10a", "12345", "beispielstadt",
]
_ADDRESS_RX = re.compile(
    "|".join(rf"\b{re.escape(f)}\b" for f in _ADDRESS_FRAGMENTS),
    re.I,
)


def scrub(text: str | None) -> str | None:
    if not text:
        return text
    t = _IBAN.sub("[IBAN]", text)
    t = _EMAIL.sub("[EMAIL]", t)
    t = _AMOUNT.sub("[BETRAG]", t)
    t = _DATE.sub("[DATUM]", t)
    t = _PHONE.sub("[TEL]", t)
    t = _LONGNUM.sub("[NR]", t)
    t = _ADDRESS_RX.sub("[ADRESSE]", t)
    return t


def scrub_names(text: str | None, names: list[str]) -> str | None:
    """Maskiert konkrete Personennamen (aus DB + Haushalt)."""
    if not text:
        return text
    for name in names:
        for part in [name] + name.split():
            part = part.strip()
            if len(part) >= 3:
                text = re.sub(rf"\b{re.escape(part)}\b", "[NAME]", text, flags=re.I)
    return text


def household_names(conn) -> list[str]:
    """Collect all person names that must be scrubbed: subject_persons,
    user accounts, and any hardcoded household members."""
    names: set[str] = set()

    # 1. user_subject_persons (Bezugspersonen)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT name FROM user_subject_persons")
            for (n,) in cur.fetchall():
                if n:
                    names.add(n)
    except Exception:
        pass

    # 2. users table (account owners)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT name FROM users WHERE name IS NOT NULL")
            for (n,) in cur.fetchall():
                if n:
                    names.add(n)
    except Exception:
        pass

    # 3. Known household members not necessarily in either table
    for extra in ["Beispiel", "Isabella", "Manuel"]:
        names.add(extra)

    # 4. Family domain — scrub_names doesn't catch email-embedded names,
    #    but scrub() replaces full emails; this covers partial occurrences.
    names.add("beispiel.test")

    return sorted(names)


# Keep legacy alias for existing callers
subject_person_names = household_names


# ── Markdown-Helfer ─────────────────────────────────────────────────────────
class Md:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def __call__(self, s: str = "") -> None:
        self.lines.append(s)

    def table(self, headers: list[str], rows: list[list]) -> None:
        self("| " + " | ".join(headers) + " |")
        self("| " + " | ".join("---" for _ in headers) + " |")
        for r in rows:
            self("| " + " | ".join(str(c if c is not None else "") for c in r) + " |")
        self("")

    def write(self, path: Path) -> None:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(self.lines), encoding="utf8")


def write_json(path: Path, obj) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf8")
