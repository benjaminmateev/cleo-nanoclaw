/**
 * Sweep tests.
 *
 * The behaviour that matters most is idempotence across runs. Cleo sweeps 4×
 * daily; if a re-sweep re-announces the same promises, the customer mutes it and
 * the feature is dead. So most of these assert "the second run says nothing".
 */
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRecords } from './schema.js';
import { recordSweep, projectionPlan, confirmProjection, markdownProjection, sweepSummary } from './sweep.js';
import { openCommitments, invoicesDue } from './store.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-sweep-'));
  const { db } = openRecords(dir);
  return db;
}

const COMMITMENT = {
  direction: 'mine' as const,
  counterparty: 'Sandro',
  what: 'implement the one-time purchase feature',
  promisedOn: '2026-07-28T10:00:00Z',
  source: 'email-sent',
  sourceRef: 'msg-tiun-1',
  sourceQuote: 'wird auch direkt implementiert sobald du mir das freigibst',
};

const INVOICE = {
  vendor: 'Anthropic, PBC',
  invoiceNumber: '2381-9644-5234',
  issuedOn: '2026-07-15',
  dueOn: '2026-07-29',
  grossCents: 2400,
  source: 'email-attachment',
  extraction: 'llm' as const,
  confidence: 0.9,
};

test('a first sweep records and reports both kinds', () => {
  const db = fresh();
  const r = recordSweep(db, { commitments: [COMMITMENT], invoices: [INVOICE] });
  expect(r.commitments.created).toBe(1);
  expect(r.invoices.created).toBe(1);
  expect(r.newCommitments.length).toBe(1);
  expect(r.newInvoices[0].vendor).toBe('Anthropic, PBC');
});

test('a second sweep over the same window reports NOTHING new', () => {
  // The property that makes 4 sweeps a day tolerable.
  const db = fresh();
  recordSweep(db, { commitments: [COMMITMENT], invoices: [INVOICE] });
  const again = recordSweep(db, { commitments: [COMMITMENT], invoices: [INVOICE] });

  expect(again.commitments.seen).toBe(1);
  expect(again.commitments.created).toBe(0);
  expect(again.invoices.created).toBe(0);
  expect(again.newCommitments.length).toBe(0);
  expect(sweepSummary(again)).toBe(null);
  // And nothing was duplicated in storage.
  expect((openCommitments(db) as unknown[]).length).toBe(1);
});

test('a repeat sighting does not inflate the vendor observation count', () => {
  // Otherwise a one-off vendor would look like a reliable monthly biller and
  // get chased for an invoice it never promised.
  const db = fresh();
  recordSweep(db, { invoices: [INVOICE] });
  recordSweep(db, { invoices: [INVOICE] });
  recordSweep(db, { invoices: [INVOICE] });
  const row = db.query('SELECT observations FROM vendor_cadence WHERE vendor = ?').get('Anthropic, PBC');
  expect(row.observations).toBe(1);
});

test('sweepSummary stays silent on an empty sweep', () => {
  const db = fresh();
  expect(sweepSummary(recordSweep(db, {}))).toBe(null);
});

test('sweepSummary distinguishes what I owe from what I am owed', () => {
  const db = fresh();
  const r = recordSweep(db, {
    commitments: [
      COMMITMENT,
      { ...COMMITMENT, direction: 'theirs', what: 'the quote', sourceRef: 'msg-2' },
    ],
  });
  const s = sweepSummary(r)!;
  expect(s).toContain('1 thing you promised');
  expect(s).toContain("1 you're waiting on");
});

test('summary pluralises correctly', () => {
  const db = fresh();
  const r = recordSweep(db, {
    commitments: [COMMITMENT, { ...COMMITMENT, what: 'send the deck', sourceRef: 'm2' }],
  });
  expect(sweepSummary(r)!).toContain('2 things you promised');
});

test('projection plan lists pending commitments, then nothing after confirming', () => {
  const db = fresh();
  const r = recordSweep(db, { commitments: [COMMITMENT] });
  const id = r.newCommitments[0].id;

  const plan = projectionPlan(db, 'todoist');
  expect(plan.pending.length).toBe(1);
  expect(plan.titles[0]).toBe('Sandro: implement the one-time purchase feature');

  confirmProjection(db, 'todoist', [{ commitmentId: id, externalId: 'todoist-9' }]);
  expect(projectionPlan(db, 'todoist').pending.length).toBe(0);
});

test('confirmProjection writes a row that closeFromProjection can find', () => {
  // Guards the argument order — an earlier version passed (target, id) to
  // recordProjection instead of (id, target), which silently wrote junk rows
  // that the completion path could never match.
  const db = fresh();
  const r = recordSweep(db, { commitments: [COMMITMENT] });
  confirmProjection(db, 'todoist', [{ commitmentId: r.newCommitments[0].id, externalId: 'todoist-9' }]);

  const row = db
    .query('SELECT commitment_id, target, external_id FROM task_projections')
    .get() as { commitment_id: string; target: string; external_id: string };
  expect(row.commitment_id).toBe(r.newCommitments[0].id);
  expect(row.target).toBe('todoist');
  expect(row.external_id).toBe('todoist-9');
});

test('markdown projection reflects what is open', () => {
  const db = fresh();
  recordSweep(db, {
    commitments: [
      COMMITMENT,
      { ...COMMITMENT, direction: 'theirs', counterparty: 'Anna', what: 'the signed contract', sourceRef: 'm3' },
    ],
  });
  const md = markdownProjection(db, new Date('2026-07-30T12:00:00Z'));
  expect(md).toContain('**Sandro** — implement the one-time purchase feature');
  expect(md).toContain('**Anna** — the signed contract');
});

test('the German source quote survives into the projection', () => {
  const db = fresh();
  const r = recordSweep(db, { commitments: [COMMITMENT] });
  expect(r.newCommitments[0].sourceQuote).toContain('sobald du mir das freigibst');
});

test('invoice amounts survive the sweep exactly', () => {
  const db = fresh();
  recordSweep(db, { invoices: [{ ...INVOICE, grossCents: 123456 }] });
  const due = invoicesDue(db, '2026-12-31') as Array<{ gross_cents: number }>;
  expect(due[0].gross_cents).toBe(123456);
});
