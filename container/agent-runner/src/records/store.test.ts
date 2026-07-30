/**
 * Record-store tests. These target the failures that would actually hurt:
 * duplicate rows from a re-sweep, an LLM guess overwriting exact XML data,
 * undated promises never surfacing, and chasing a vendor on one observation.
 */
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRecords } from './schema.js';
import {
  upsertInvoice, invoicesDue, invoicesNeedingReview,
  upsertCommitment, openCommitments, closeCommitment,
  observeVendorInvoice, vendorsOverdue,
} from './store.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-records-'));
  const { db } = openRecords(dir);
  return db;
}

const INV = {
  vendor: 'Telekom',
  invoiceNumber: '2026-001',
  issuedOn: '2026-07-03',
  dueOn: '2026-07-17',
  grossCents: 4999,
  source: 'email-attachment',
  extraction: 'llm' as const,
  confidence: 0.9,
};

test('re-running detection over the same mail does not duplicate an invoice', () => {
  const db = fresh();
  const first = upsertInvoice(db, INV);
  const second = upsertInvoice(db, INV);
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.id).toBe(first.id);
  expect(db.query('SELECT count(*) c FROM invoices').get().c).toBe(1);
});

test('the same invoice number from a different vendor is a different invoice', () => {
  const db = fresh();
  upsertInvoice(db, INV);
  upsertInvoice(db, { ...INV, vendor: 'Vodafone' });
  // Two vendors legitimately both issue "2026-001".
  expect(db.query('SELECT count(*) c FROM invoices').get().c).toBe(2);
});

test('an XML re-extraction upgrades an LLM guess, and never the reverse', () => {
  const db = fresh();
  upsertInvoice(db, INV);
  upsertInvoice(db, { ...INV, extraction: 'xml', grossCents: 5099 });
  let row = db.query('SELECT extraction, gross_cents FROM invoices').get();
  expect(row.extraction).toBe('xml');
  expect(row.gross_cents).toBe(5099);

  // A later LLM pass must not downgrade the trustworthy value.
  upsertInvoice(db, { ...INV, extraction: 'llm' });
  row = db.query('SELECT extraction FROM invoices').get();
  expect(row.extraction).toBe('xml');
});

test('amounts round-trip exactly as integer cents', () => {
  const db = fresh();
  // 1234.56 EUR — the value that would drift if stored as a float.
  upsertInvoice(db, { ...INV, invoiceNumber: 'F-1', netCents: 103744, vatCents: 19712, grossCents: 123456 });
  const row = db.query('SELECT net_cents, vat_cents, gross_cents FROM invoices WHERE invoice_number = ?').get('F-1');
  expect(row.gross_cents).toBe(123456);
  expect(row.net_cents + row.vat_cents).toBe(123456);
});

test('invoicesDue returns only open invoices up to the cutoff, soonest first', () => {
  const db = fresh();
  upsertInvoice(db, { ...INV, invoiceNumber: 'A', dueOn: '2026-07-10' });
  upsertInvoice(db, { ...INV, invoiceNumber: 'B', dueOn: '2026-07-05' });
  upsertInvoice(db, { ...INV, invoiceNumber: 'C', dueOn: '2026-09-01' });
  const due = invoicesDue(db, '2026-07-31') as Array<{ invoice_number: string }>;
  expect(due.map((r) => r.invoice_number)).toEqual(['B', 'A']);
});

test('low-confidence LLM extractions surface for review; exact XML ones do not', () => {
  const db = fresh();
  upsertInvoice(db, { ...INV, invoiceNumber: 'LOW', confidence: 0.4 });
  upsertInvoice(db, { ...INV, invoiceNumber: 'SURE', confidence: 0.95 });
  upsertInvoice(db, { ...INV, invoiceNumber: 'XML', extraction: 'xml', confidence: 0.2 });
  const review = invoicesNeedingReview(db) as Array<{ invoice_number: string }>;
  expect(review.map((r) => r.invoice_number)).toEqual(['LOW']);
});

test('the same promise extracted twice from one message is stored once', () => {
  const db = fresh();
  const c = {
    direction: 'mine' as const, what: 'send Marcus the pricing',
    promisedOn: '2026-07-20T09:00:00Z', source: 'email-sent', sourceRef: 'msg-1',
  };
  expect(upsertCommitment(db, c).created).toBe(true);
  expect(upsertCommitment(db, c).created).toBe(false);
});

test('an undated promise goes stale on age — the core catch', () => {
  const db = fresh();
  const now = new Date('2026-07-30T12:00:00Z');
  // No due date, made 9 days ago: exactly the promise that quietly rots.
  upsertCommitment(db, {
    direction: 'mine', what: 'come back to Anna on price',
    promisedOn: '2026-07-21T09:00:00Z', source: 'email-sent', sourceRef: 'm1',
  });
  // Recent, also undated — should NOT be nagged about yet.
  upsertCommitment(db, {
    direction: 'mine', what: 'look at the Sandbox thread',
    promisedOn: '2026-07-29T09:00:00Z', source: 'email-sent', sourceRef: 'm2',
  });
  const stale = openCommitments(db, { staleAfterDays: 7, now }) as Array<{ what: string }>;
  expect(stale.map((r) => r.what)).toEqual(['come back to Anna on price']);
});

test('direction separates my to-dos from what I am owed', () => {
  const db = fresh();
  upsertCommitment(db, { direction: 'mine', what: 'send deck', promisedOn: '2026-07-20T09:00:00Z', source: 'email-sent', sourceRef: 'a' });
  upsertCommitment(db, { direction: 'theirs', what: 'quote from Klaus', promisedOn: '2026-07-20T09:00:00Z', source: 'email-received', sourceRef: 'b' });
  expect((openCommitments(db, { direction: 'mine' }) as unknown[]).length).toBe(1);
  expect((openCommitments(db, { direction: 'theirs' }) as unknown[]).length).toBe(1);
});

test('a closed commitment stops appearing', () => {
  const db = fresh();
  const { id } = upsertCommitment(db, {
    direction: 'mine', what: 'send deck', promisedOn: '2026-07-20T09:00:00Z', source: 'email-sent', sourceRef: 'a',
  });
  closeCommitment(db, id, 'done');
  expect((openCommitments(db) as unknown[]).length).toBe(0);
});

test('vendor cadence accumulates observations and keeps the first billing day', () => {
  const db = fresh();
  observeVendorInvoice(db, 'Telekom', '2026-05-03', 4999);
  observeVendorInvoice(db, 'Telekom', '2026-06-04', 4999);
  const r = observeVendorInvoice(db, 'Telekom', '2026-07-03', 5199);
  expect(r.observations).toBe(3);
  const row = db.query('SELECT typical_day, observations FROM vendor_cadence WHERE vendor = ?').get('Telekom');
  expect(row.typical_day).toBe(3);
  expect(row.observations).toBe(3);
});

test('a vendor seen once is never chased — thin data must not trigger a nudge', () => {
  const db = fresh();
  observeVendorInvoice(db, 'OneOff GmbH', '2026-01-05', 1000);
  const overdue = vendorsOverdue(db, { now: new Date('2026-07-30T00:00:00Z') });
  expect(overdue.length).toBe(0);
});

test('a well-established vendor that has gone quiet is flagged', () => {
  const db = fresh();
  for (const d of ['2026-03-03', '2026-04-03', '2026-05-03']) {
    observeVendorInvoice(db, 'Telekom', d, 4999);
  }
  const overdue = vendorsOverdue(db, { now: new Date('2026-07-30T00:00:00Z') }) as Array<{ vendor: string }>;
  expect(overdue.map((r) => r.vendor)).toEqual(['Telekom']);
});
