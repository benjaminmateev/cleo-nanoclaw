/**
 * The sweep — chains detection → store → projection.
 *
 * IMPORTANT shape decision: this module does NOT fetch anything. Gmail lives
 * behind MCP tools that only the agent process can invoke, so a sweep that tried
 * to call Gmail itself would need a second credential path — exactly the thing
 * the OneCLI gateway design exists to prevent.
 *
 * So the agent does the fetching (it has the tools) and hands what it found to
 * `recordSweep`, which owns everything the agent is bad at: idempotence,
 * dedupe across runs, exact amounts, and deciding what is genuinely new and
 * therefore worth telling the customer about.
 *
 * That split also matches the operating model: the model supplies judgement,
 * SQLite supplies exactness.
 */
import type { Database } from 'bun:sqlite';
import {
  upsertCommitment, upsertInvoice, observeVendorInvoice,
  commitmentsToProject, recordProjection, openCommitments,
  type CommitmentInput, type InvoiceInput,
} from './store.js';
import { renderMarkdown, taskTitle, type ProjectableCommitment } from './tasklist.js';

export interface SweepInput {
  /** Commitments the agent extracted from mail/meetings this run. */
  commitments?: CommitmentInput[];
  /** Invoices the agent extracted this run. */
  invoices?: InvoiceInput[];
}

export interface SweepResult {
  commitments: { seen: number; created: number };
  invoices: { seen: number; created: number };
  /** Only the genuinely new items — what the customer should hear about. */
  newCommitments: ProjectableCommitment[];
  newInvoices: Array<{ id: string; vendor: string; grossCents?: number | null; dueOn?: string | null }>;
}

/**
 * Record everything the agent found. Idempotent by construction: the store's
 * upserts key on natural identity, so re-running a sweep over the same mail
 * window creates nothing and reports nothing new.
 *
 * That property is what makes a 4×/day schedule tolerable — without it, every
 * sweep would re-announce the same promises and the customer would mute Cleo.
 */
export function recordSweep(db: Database, input: SweepInput): SweepResult {
  const result: SweepResult = {
    commitments: { seen: 0, created: 0 },
    invoices: { seen: 0, created: 0 },
    newCommitments: [],
    newInvoices: [],
  };

  for (const c of input.commitments ?? []) {
    result.commitments.seen++;
    const { id, created } = upsertCommitment(db, c);
    if (!created) continue;
    result.commitments.created++;
    result.newCommitments.push({
      id,
      direction: c.direction,
      counterparty: c.counterparty ?? null,
      what: c.what,
      promisedOn: c.promisedOn,
      dueOn: c.dueOn ?? null,
      sourceQuote: c.sourceQuote ?? null,
    });
  }

  for (const inv of input.invoices ?? []) {
    result.invoices.seen++;
    const { id, created } = upsertInvoice(db, inv);
    // Cadence is observed even on a repeat sighting only when the row is new —
    // otherwise a re-sweep would inflate the observation count and make a
    // one-off vendor look like a reliable monthly biller.
    if (!created) continue;
    result.invoices.created++;
    observeVendorInvoice(db, inv.vendor, inv.issuedOn ?? null, inv.grossCents ?? null);
    result.newInvoices.push({
      id, vendor: inv.vendor, grossCents: inv.grossCents ?? null, dueOn: inv.dueOn ?? null,
    });
  }

  return result;
}

/**
 * What to push to the task app, and the markdown view to write.
 *
 * Returns instructions rather than performing them: pushing to Todoist is an
 * MCP call, which again only the agent can make. The agent calls `add-tasks`
 * with these args and then reports the external ids back via
 * `confirmProjection` so the store knows not to push them again.
 */
export function projectionPlan(db: Database, target: 'todoist' | 'markdown') {
  const rows = commitmentsToProject(db, target) as Array<{
    id: string; direction: 'mine' | 'theirs'; counterparty: string | null;
    what: string; promised_on: string; due_on: string | null; source_quote: string | null;
  }>;
  const pending: ProjectableCommitment[] = rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    counterparty: r.counterparty,
    what: r.what,
    promisedOn: r.promised_on,
    dueOn: r.due_on,
    sourceQuote: r.source_quote,
  }));
  return { target, pending, titles: pending.map(taskTitle) };
}

export function confirmProjection(
  db: Database,
  target: 'todoist' | 'markdown',
  confirmations: Array<{ commitmentId: string; externalId?: string | null }>,
) {
  for (const c of confirmations) recordProjection(db, c.commitmentId, target, c.externalId);
  return { recorded: confirmations.length };
}

/**
 * The full markdown projection of everything currently open — for customers with
 * no task app. Regenerated wholesale; it is a view, not a document to edit.
 */
export function markdownProjection(db: Database, now = new Date()): string {
  const rows = openCommitments(db) as Array<{
    id: string; direction: 'mine' | 'theirs'; counterparty: string | null;
    what: string; promised_on: string; due_on: string | null; source_quote: string | null;
  }>;
  return renderMarkdown(
    rows.map((r) => ({
      id: r.id, direction: r.direction, counterparty: r.counterparty, what: r.what,
      promisedOn: r.promised_on, dueOn: r.due_on, sourceQuote: r.source_quote,
    })),
    now,
  );
}

/**
 * One-line summary for the briefing, or null when there is nothing to say.
 *
 * Returning null matters: "nothing new" is a legitimate and desirable outcome,
 * and a proactive assistant that reports every empty sweep trains the customer
 * to ignore it. Silence when there is no news is a feature.
 */
export function sweepSummary(r: SweepResult): string | null {
  const parts: string[] = [];
  if (r.newCommitments.length) {
    const mine = r.newCommitments.filter((c) => c.direction === 'mine').length;
    const theirs = r.newCommitments.length - mine;
    const bits: string[] = [];
    if (mine) bits.push(`${mine} thing${mine === 1 ? '' : 's'} you promised`);
    if (theirs) bits.push(`${theirs} you're waiting on`);
    parts.push(bits.join(' and '));
  }
  if (r.newInvoices.length) {
    parts.push(`${r.newInvoices.length} new invoice${r.newInvoices.length === 1 ? '' : 's'}`);
  }
  return parts.length ? `Found ${parts.join(', ')}.` : null;
}
