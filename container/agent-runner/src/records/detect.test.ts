/**
 * Detection tests.
 *
 * The fixtures are REAL messages observed in the target mailbox (2026-07-30),
 * not invented ones. That matters: a naive `has:attachment filename:pdf` sweep
 * returned 50+ hits in 90 days whose top three were an order confirmation, a
 * genuine receipt, and supermarket loyalty mail. Those three are the
 * discriminations the filter exists to make, so they are the tests.
 */
import { test, expect } from 'bun:test';
import {
  invoiceQueries, commitmentQueries, invoiceLikelihood, rankCandidates,
  mayCarryInvoiceXml, INVOICE_READ_THRESHOLD,
} from './detect.js';

// --- real observed messages -------------------------------------------------

const REAL_RECEIPT = {
  subject: 'Your receipt from Anthropic, PBC #2381-9644-5234',
  from: 'invoice+statements@mail.anthropic.com',
  hasPdf: true,
};

const ORDER_CONFIRMATION = {
  subject: 'Bestellung GL-228719 bestätigt',
  from: 'info@gusti-leder.de',
  hasPdf: true,
};

const LOYALTY_MAIL = {
  subject: 'EDEKA - Vielen Dank für Ihren Einkauf',
  from: 'noreply@app.edeka.de',
  hasPdf: true,
};

test('a real receipt scores above the read threshold', () => {
  expect(invoiceLikelihood(REAL_RECEIPT)).toBeGreaterThanOrEqual(INVOICE_READ_THRESHOLD);
});

test('an order confirmation with a PDF stays below it', () => {
  // The exact noise a "has:attachment" sweep drowns in.
  expect(invoiceLikelihood(ORDER_CONFIRMATION)).toBeLessThan(INVOICE_READ_THRESHOLD);
});

test('supermarket loyalty mail with a PDF stays below it', () => {
  expect(invoiceLikelihood(LOYALTY_MAIL)).toBeLessThan(INVOICE_READ_THRESHOLD);
});

test('a plain German supplier invoice scores high', () => {
  const score = invoiceLikelihood({
    subject: 'Ihre Rechnung 2026-0042',
    from: 'buchhaltung@lieferant.de',
    hasPdf: true,
  });
  expect(score).toBeGreaterThan(0.8);
});

test('an invoice that mentions an order is NOT vetoed by the negative word', () => {
  // "Rechnung zu Ihrer Bestellung" is a real invoice. A hard veto on
  // "Bestellung" would silently drop these, which is why negatives subtract.
  const score = invoiceLikelihood({
    subject: 'Rechnung zu Ihrer Bestellung 12345',
    from: 'rechnung@shop.de',
    hasPdf: true,
  });
  expect(score).toBeGreaterThanOrEqual(INVOICE_READ_THRESHOLD);
});

test('a dunning notice is not treated as an invoice', () => {
  // It is *about* an invoice; recording it would duplicate the original.
  expect(invoiceLikelihood({
    subject: 'Zahlungserinnerung zu Rechnung 2026-0042',
    from: 'mahnung@lieferant.de',
    hasPdf: false,
  })).toBeLessThan(INVOICE_READ_THRESHOLD);
});

test('an invoice with no attachment still scores — the mail may BE the invoice', () => {
  const score = invoiceLikelihood({
    subject: 'Invoice INV-2026-88 from Acme Ltd',
    from: 'billing@acme.com',
  });
  expect(score).toBeGreaterThanOrEqual(INVOICE_READ_THRESHOLD);
});

test('an unrelated message scores zero', () => {
  expect(invoiceLikelihood({
    subject: 'Lunch on Thursday?',
    from: 'anna@example.com',
  })).toBe(0);
});

test('ranking puts the real invoice above the PDF-carrying noise', () => {
  const ranked = rankCandidates([ORDER_CONFIRMATION, REAL_RECEIPT, LOYALTY_MAIL]);
  expect(ranked[0].subject).toBe(REAL_RECEIPT.subject);
});

test('invoice queries are ordered most-precise first and windowed', () => {
  const qs = invoiceQueries(30);
  expect(qs.length).toBeGreaterThanOrEqual(3);
  for (const q of qs) expect(q).toContain('newer_than:30d');
  // Tier 1 must require both a subject term and an attachment.
  expect(qs[0]).toContain('has:attachment');
  expect(qs[0]).toContain('subject:');
  // A tier must exist for mail with no attachment (portal links, body invoices).
  expect(qs.some((q) => q.includes('-has:attachment'))).toBe(true);
});

test('commitment detection reads sent mail — the core insight', () => {
  const qs = commitmentQueries(14);
  expect(qs[0]).toContain('in:sent');
  // And the inbound side, which feeds chasing.
  expect(qs.some((q) => q.includes('-in:sent'))).toBe(true);
});

test('XML detection accepts bare XML and PDFs (ZUGFeRD embeds inside PDF/A-3)', () => {
  expect(mayCarryInvoiceXml('xrechnung.xml')).toBe(true);
  expect(mayCarryInvoiceXml('invoice.pdf')).toBe(true);
  expect(mayCarryInvoiceXml('data.bin', 'application/xml')).toBe(true);
  // Not every attachment is worth opening.
  expect(mayCarryInvoiceXml('logo.png')).toBe(false);
  expect(mayCarryInvoiceXml('contract.docx')).toBe(false);
});
