/**
 * Structured records — the half of Cleo's memory that must be exact.
 *
 * The operating model (PRD §10, decided 2026-07-29) splits memory by failure
 * mode. Judgement and preference live as prose in the markdown knowledge base,
 * where nuance survives and a human can read and correct it. Anything that must
 * be exact lives here: amounts, dates, vendor billing cadence, commitment
 * status. A vendor's billing day must not depend on a model reading a sentence
 * correctly.
 *
 * One SQLite database per agent group, so a customer's records are as isolated
 * as their container.
 */
import { Database } from 'bun:sqlite';
import path from 'node:path';
import fs from 'node:fs';

/** Schema version. Bump when adding a migration below. */
export const SCHEMA_VERSION = 1;

const DDL = `
-- Invoices Cleo found, wherever it found them.
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  -- Identity as printed on the document. invoice_number is NOT unique: two
  -- vendors legitimately issue "2026-001", so dedup keys on (vendor, number).
  vendor          TEXT NOT NULL,
  invoice_number  TEXT,
  issued_on       TEXT,           -- ISO date
  due_on          TEXT,           -- ISO date; may be absent, then derived from terms
  -- Amounts in MINOR UNITS (cents) as integers. Never floats: 0.1 + 0.2 in
  -- binary floating point is not 0.3, and this is money.
  net_cents       INTEGER,
  vat_cents       INTEGER,
  gross_cents     INTEGER,
  vat_rate        REAL,
  currency        TEXT NOT NULL DEFAULT 'EUR',
  -- Where it came from and where it went.
  source          TEXT NOT NULL,  -- 'email-attachment' | 'email-body' | 'drive' | 'portal' | 'manual'
  source_ref      TEXT,           -- message id, file id, URL
  filed_path      TEXT,           -- where Cleo put the file, per learned preference
  -- How the data was obtained, which predicts how much to trust it.
  extraction      TEXT NOT NULL,  -- 'xml' (ZUGFeRD/XRechnung, exact) | 'llm' (inferred)
  confidence      REAL,           -- 0..1; low values are what Cleo reports as unsure
  status          TEXT NOT NULL DEFAULT 'open',  -- open | paid | disputed | ignored
  paid_on         TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_due    ON invoices(status, due_on);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendor);
-- Dedup guard: re-running detection over the same mailbox must not duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_identity
  ON invoices(vendor, COALESCE(invoice_number, ''), COALESCE(issued_on, ''));

-- Commitments: things the customer promised, or that were promised to them.
-- The flagship capability (roadmap B0) — these are extracted from outbound and
-- inbound messages rather than typed by anyone.
CREATE TABLE IF NOT EXISTS commitments (
  id            TEXT PRIMARY KEY,
  -- direction is the whole product distinction: 'mine' is what I owe (a to-do),
  -- 'theirs' is what I am owed (something to chase).
  direction     TEXT NOT NULL,   -- 'mine' | 'theirs'
  counterparty  TEXT,            -- who it was made to, or by
  what          TEXT NOT NULL,   -- the promise, in the customer's own words where possible
  promised_on   TEXT NOT NULL,   -- when it was said
  due_on        TEXT,            -- if a date was stated or implied
  -- Verbatim source so Cleo can quote it back: "you wrote, on Monday, ..."
  source        TEXT NOT NULL,   -- 'email-sent' | 'email-received' | 'meeting' | 'chat'
  source_ref    TEXT,
  source_quote  TEXT,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | done | dropped | superseded
  confidence    REAL,
  -- Set when Cleo has already nudged, so it does not nag on every sweep.
  last_nudged_at TEXT,
  closed_on     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commitments_open ON commitments(status, direction, due_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commitments_source
  ON commitments(source, COALESCE(source_ref, ''), what);

-- Vendor billing cadence — learned from observation, used for chasing (B1).
-- "Telekom bills on the 3rd; it is the 9th and nothing arrived."
CREATE TABLE IF NOT EXISTS vendor_cadence (
  vendor          TEXT PRIMARY KEY,
  period          TEXT,      -- 'monthly' | 'quarterly' | 'annual' | 'irregular'
  typical_day     INTEGER,   -- day of month the invoice usually lands
  typical_cents   INTEGER,   -- typical gross, for spotting anomalies
  observations    INTEGER NOT NULL DEFAULT 0,  -- how many invoices this is based on
  last_seen_on    TEXT,
  chase_enabled   INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL
);

-- Recurring obligations with derived dates (tax filings, and anything else the
-- customer tells Cleo repeats). Dates are computed from cadence, then stored so
-- a reminder can be attached to a specific occurrence.
CREATE TABLE IF NOT EXISTS obligations (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,   -- 'ustva' | 'einkommensteuer' | 'custom' | ...
  label         TEXT NOT NULL,
  due_on        TEXT NOT NULL,
  -- Cleo states its assumptions rather than asserting dates silently, per the
  -- act-then-report rule. e.g. "10th fell on a Saturday; assuming Monday."
  assumption    TEXT,
  status        TEXT NOT NULL DEFAULT 'upcoming',  -- upcoming | done | missed
  reminded_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obligations_due ON obligations(status, due_on);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface RecordsDb {
  db: Database;
  close(): void;
}

/**
 * Open (creating if needed) the records database for this agent group.
 * Idempotent — safe to call on every container spawn.
 */
export function openRecords(root: string): RecordsDb {
  fs.mkdirSync(root, { recursive: true });
  const db = new Database(path.join(root, 'records.db'), { create: true });
  // WAL so a long-running read (a briefing query) does not block a write
  // (detection storing a new invoice).
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run(DDL);
  const row = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | null;
  if (!row) {
    db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
  return { db, close: () => db.close() };
}

export function schemaVersion(db: Database): number {
  const row = db.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | null;
  return row ? Number(row.value) : 0;
}
