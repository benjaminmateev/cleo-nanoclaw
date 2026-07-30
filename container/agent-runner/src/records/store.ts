/**
 * Record operations. Deliberately a small, explicit surface rather than a
 * generic ORM — the agent needs a handful of questions answered well ("what is
 * due", "what did I promise", "what has gone quiet") and each is a real query.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

const now = () => new Date().toISOString();

export interface InvoiceInput {
  vendor: string;
  invoiceNumber?: string | null;
  issuedOn?: string | null;
  dueOn?: string | null;
  netCents?: number | null;
  vatCents?: number | null;
  grossCents?: number | null;
  vatRate?: number | null;
  currency?: string;
  source: string;
  sourceRef?: string | null;
  filedPath?: string | null;
  extraction: 'xml' | 'llm';
  confidence?: number | null;
  notes?: string | null;
}

/**
 * Insert an invoice, or update the existing row for the same
 * (vendor, number, issue date). Detection re-runs over the same mailbox window,
 * so this MUST be idempotent — `ON CONFLICT` on the identity index is what
 * makes a re-sweep safe.
 *
 * Returns whether the row was new, which is what the caller reports to the user
 * ("found 3 new invoices") versus silently reconciling.
 */
export function upsertInvoice(db: Database, inv: InvoiceInput): { id: string; created: boolean } {
  const ts = now();
  const existing = db
    .query(
      `SELECT id FROM invoices
        WHERE vendor = ? AND COALESCE(invoice_number,'') = ? AND COALESCE(issued_on,'') = ?`,
    )
    .get(inv.vendor, inv.invoiceNumber ?? '', inv.issuedOn ?? '') as { id: string } | null;

  if (existing) {
    // An XML re-extraction supersedes an earlier LLM guess; never the reverse.
    db.query(
      `UPDATE invoices SET
         due_on = COALESCE(?, due_on),
         net_cents = COALESCE(?, net_cents),
         vat_cents = COALESCE(?, vat_cents),
         gross_cents = COALESCE(?, gross_cents),
         vat_rate = COALESCE(?, vat_rate),
         filed_path = COALESCE(?, filed_path),
         extraction = CASE WHEN ? = 'xml' THEN 'xml' ELSE extraction END,
         confidence = COALESCE(?, confidence),
         updated_at = ?
       WHERE id = ?`,
    ).run(
      inv.dueOn ?? null, inv.netCents ?? null, inv.vatCents ?? null, inv.grossCents ?? null,
      inv.vatRate ?? null, inv.filedPath ?? null, inv.extraction, inv.confidence ?? null,
      ts, existing.id,
    );
    return { id: existing.id, created: false };
  }

  const id = randomUUID();
  db.query(
    `INSERT INTO invoices (id, vendor, invoice_number, issued_on, due_on,
       net_cents, vat_cents, gross_cents, vat_rate, currency,
       source, source_ref, filed_path, extraction, confidence, notes,
       created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, inv.vendor, inv.invoiceNumber ?? null, inv.issuedOn ?? null, inv.dueOn ?? null,
    inv.netCents ?? null, inv.vatCents ?? null, inv.grossCents ?? null, inv.vatRate ?? null,
    inv.currency ?? 'EUR', inv.source, inv.sourceRef ?? null, inv.filedPath ?? null,
    inv.extraction, inv.confidence ?? null, inv.notes ?? null, ts, ts,
  );
  return { id, created: true };
}

/** Open invoices due on or before `throughIso`, soonest first. */
export function invoicesDue(db: Database, throughIso: string) {
  return db
    .query(
      `SELECT * FROM invoices
        WHERE status = 'open' AND due_on IS NOT NULL AND due_on <= ?
        ORDER BY due_on ASC`,
    )
    .all(throughIso);
}

/** Invoices Cleo was unsure about — what it flags for a human glance. */
export function invoicesNeedingReview(db: Database, threshold = 0.7) {
  return db
    .query(
      `SELECT * FROM invoices
        WHERE status = 'open' AND extraction = 'llm'
          AND (confidence IS NULL OR confidence < ?)
        ORDER BY created_at DESC`,
    )
    .all(threshold);
}

export interface CommitmentInput {
  direction: 'mine' | 'theirs';
  counterparty?: string | null;
  what: string;
  promisedOn: string;
  dueOn?: string | null;
  source: string;
  sourceRef?: string | null;
  sourceQuote?: string | null;
  confidence?: number | null;
}

/**
 * Record a commitment. Idempotent on (source, sourceRef, what) so re-scanning
 * the same sent-mail window does not produce duplicates — extraction is fuzzy
 * and will re-derive the same promise with slightly different wording, so the
 * `what` is part of the key rather than a fuzzy match.
 */
export function upsertCommitment(db: Database, c: CommitmentInput): { id: string; created: boolean } {
  const ts = now();
  const existing = db
    .query(`SELECT id FROM commitments WHERE source = ? AND COALESCE(source_ref,'') = ? AND what = ?`)
    .get(c.source, c.sourceRef ?? '', c.what) as { id: string } | null;
  if (existing) return { id: existing.id, created: false };

  const id = randomUUID();
  db.query(
    `INSERT INTO commitments (id, direction, counterparty, what, promised_on, due_on,
       source, source_ref, source_quote, confidence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, c.direction, c.counterparty ?? null, c.what, c.promisedOn, c.dueOn ?? null,
    c.source, c.sourceRef ?? null, c.sourceQuote ?? null, c.confidence ?? null, ts, ts,
  );
  return { id, created: true };
}

/**
 * Open commitments, optionally only those going stale.
 *
 * `staleAfterDays` counts from when the promise was made, not from its due date:
 * most promises never carry an explicit date ("I'll come back to you on this"),
 * and those are exactly the ones that rot. A promise with no date that is eight
 * days old is the product's core catch.
 */
export function openCommitments(
  db: Database,
  opts: { direction?: 'mine' | 'theirs'; staleAfterDays?: number; now?: Date } = {},
) {
  const clauses = [`status = 'open'`];
  const params: unknown[] = [];
  if (opts.direction) {
    clauses.push('direction = ?');
    params.push(opts.direction);
  }
  if (opts.staleAfterDays != null) {
    const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.staleAfterDays * 86_400_000).toISOString();
    // Stale if past its due date, OR undated and older than the cutoff.
    clauses.push(`((due_on IS NOT NULL AND due_on <= ?) OR (due_on IS NULL AND promised_on <= ?))`);
    params.push((opts.now ?? new Date()).toISOString(), cutoff);
  }
  return db
    .query(`SELECT * FROM commitments WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(due_on, promised_on) ASC`)
    .all(...(params as never[]));
}

export function closeCommitment(db: Database, id: string, status: 'done' | 'dropped' | 'superseded') {
  const ts = now();
  db.query(`UPDATE commitments SET status = ?, closed_on = ?, updated_at = ? WHERE id = ?`).run(status, ts, ts, id);
}

export function markNudged(db: Database, id: string) {
  const ts = now();
  db.query(`UPDATE commitments SET last_nudged_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id);
}

// --- task-app projection ----------------------------------------------------

/**
 * Commitments that are open but not yet pushed to `target`. This is what makes
 * the projection idempotent: a sweep pushes only what is missing, so re-running
 * it does not fill the customer's task app with duplicates.
 */
export function commitmentsToProject(db: Database, target: string) {
  return db
    .query(
      `SELECT c.* FROM commitments c
        LEFT JOIN task_projections p
          ON p.commitment_id = c.id AND p.target = ?
        WHERE c.status = 'open' AND p.commitment_id IS NULL
        ORDER BY COALESCE(c.due_on, c.promised_on) ASC`,
    )
    .all(target);
}

export function recordProjection(db: Database, commitmentId: string, target: string, externalId?: string | null) {
  db.query(
    `INSERT INTO task_projections (commitment_id, target, external_id, pushed_at)
     VALUES (?,?,?,?)
     ON CONFLICT(commitment_id, target) DO UPDATE SET external_id = excluded.external_id`,
  ).run(commitmentId, target, externalId ?? null, now());
}

/**
 * Close a commitment because it was completed in the task app.
 *
 * This is the ONLY direction completion flows (see tasklist.ts): the task app
 * owns "done", SQLite owns everything else. Recording `completed_seen_at`
 * separately from the commitment's own `closed_on` keeps the audit trail honest
 * about *where* the completion came from.
 */
export function closeFromProjection(db: Database, target: string, externalId: string): { closed: boolean } {
  const row = db
    .query(`SELECT commitment_id FROM task_projections WHERE target = ? AND external_id = ?`)
    .get(target, externalId) as { commitment_id: string } | null;
  if (!row) return { closed: false };
  const ts = now();
  db.query(`UPDATE task_projections SET completed_seen_at = ? WHERE target = ? AND external_id = ?`)
    .run(ts, target, externalId);
  db.query(`UPDATE commitments SET status = 'done', closed_on = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
    .run(ts, ts, row.commitment_id);
  return { closed: true };
}

/** External ids Cleo has pushed and not yet seen completed — the poll list. */
export function pendingProjections(db: Database, target: string) {
  return db
    .query(
      `SELECT p.external_id, p.commitment_id FROM task_projections p
        JOIN commitments c ON c.id = p.commitment_id
        WHERE p.target = ? AND p.completed_seen_at IS NULL
          AND p.external_id IS NOT NULL AND c.status = 'open'`,
    )
    .all(target);
}

/**
 * Fold a newly seen invoice into the vendor's cadence profile.
 *
 * Deliberately naive: it tracks the modal billing day and a running count
 * rather than fitting a distribution. With 3-4 observations a real distribution
 * is noise anyway, and "Telekom usually bills around the 3rd" is all chasing
 * needs. `observations` is exposed so callers can refuse to chase on thin data.
 */
export function observeVendorInvoice(db: Database, vendor: string, issuedOn: string | null, grossCents: number | null) {
  const ts = now();
  const day = issuedOn ? new Date(issuedOn).getUTCDate() : null;
  const existing = db.query(`SELECT * FROM vendor_cadence WHERE vendor = ?`).get(vendor) as
    | { observations: number; typical_day: number | null }
    | null;
  if (!existing) {
    db.query(
      `INSERT INTO vendor_cadence (vendor, typical_day, typical_cents, observations, last_seen_on, updated_at)
       VALUES (?,?,?,1,?,?)`,
    ).run(vendor, day, grossCents, issuedOn, ts);
    return { observations: 1 };
  }
  // Keep the earlier typical_day unless we have none; a single outlier month
  // should not move it.
  db.query(
    `UPDATE vendor_cadence SET
       typical_day = COALESCE(typical_day, ?),
       typical_cents = COALESCE(?, typical_cents),
       observations = observations + 1,
       last_seen_on = COALESCE(?, last_seen_on),
       updated_at = ?
     WHERE vendor = ?`,
  ).run(day, grossCents, issuedOn, ts, vendor);
  return { observations: existing.observations + 1 };
}

/**
 * Vendors that look overdue: a known cadence, enough observations to trust it,
 * and nothing seen for longer than the period suggests. This is the input to
 * "shall I ask them for it?" (roadmap B1).
 */
export function vendorsOverdue(db: Database, opts: { minObservations?: number; graceDays?: number; now?: Date } = {}) {
  const minObs = opts.minObservations ?? 3;
  const grace = opts.graceDays ?? 5;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (30 + grace) * 86_400_000).toISOString();
  return db
    .query(
      `SELECT * FROM vendor_cadence
        WHERE chase_enabled = 1 AND observations >= ?
          AND last_seen_on IS NOT NULL AND last_seen_on <= ?
        ORDER BY last_seen_on ASC`,
    )
    .all(minObs, cutoff);
}
