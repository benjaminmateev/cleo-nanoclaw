/**
 * Detection queries and classification hints.
 *
 * This module deliberately contains NO LLM calls and NO Gmail calls. It builds
 * the search queries and scores candidates on cheap signals, so the expensive
 * steps (reading a message, extracting from a PDF) run on a shortlist rather
 * than on everything.
 *
 * Why that matters, measured on a real mailbox: `has:attachment filename:pdf
 * newer_than:90d` returned 50+ results whose top three were an order
 * confirmation, a genuine receipt, and a supermarket loyalty mail. Feeding all
 * of that to a model is both expensive and worse — the noise crowds out the
 * signal. Narrow first, then read.
 */

export type DetectionMode = 'scheduled' | 'on-demand' | 'label';

/**
 * Gmail search queries for invoice candidates, most-precise first.
 *
 * German and English terms both matter for a DACH customer: suppliers write
 * "Rechnung", international SaaS writes "invoice"/"receipt". Note `Beleg` and
 * `Zahlungsbestätigung` deliberately absent from the precise tier — they appear
 * on payment *confirmations* far more often than on the invoice itself, and a
 * confirmation is not the document the Steuerberater needs.
 */
export function invoiceQueries(sinceDays = 30): string[] {
  const window = `newer_than:${sinceDays}d`;
  return [
    // Tier 1 — an invoice word AND an attachment. Highest precision.
    `${window} has:attachment (subject:Rechnung OR subject:invoice OR subject:Zahlungsbeleg)`,
    // Tier 2 — invoice word anywhere with an attachment.
    `${window} has:attachment (Rechnung OR Invoice OR "Ihre Rechnung" OR "your invoice")`,
    // Tier 3 — an invoice word with no attachment: the mail may BE the invoice,
    // or carry a portal link ("your invoice is ready, log in").
    `${window} -has:attachment (subject:Rechnung OR subject:invoice)`,
  ];
}

/**
 * Gmail queries for commitment candidates (roadmap B0).
 *
 * `in:sent` is the whole trick: promises the customer made are in their own
 * outbound mail. Nobody has to write a to-do — it is already written.
 */
export function commitmentQueries(sinceDays = 14): string[] {
  const window = `newer_than:${sinceDays}d`;
  return [
    // What I promised. The phrase list is a starting point; per-customer
    // phrasing is learned into prose memory and layered on top.
    `in:sent ${window}`,
    // What was promised to me — the input to chasing.
    `${window} -in:sent (["I'll send" OR "I will send" OR "schicke ich" OR "sende ich" OR "melde mich"])`,
  ];
}

/** Cheap signals that a message is probably an invoice, before reading it. */
export interface Candidate {
  subject?: string;
  from?: string;
  hasPdf?: boolean;
  snippet?: string;
}

const INVOICE_WORDS = [
  'rechnung', 'invoice', 'zahlungsbeleg', 'faktura',
  'rechnungsnummer', 'invoice no', 'invoice number', 'steuernummer', 'ust-idnr',
];

/**
 * Terms that reliably mark a NON-invoice even when a PDF is attached. Drawn
 * from what the real mailbox actually contained rather than guessed:
 * order confirmations, shipping notices and loyalty mail all carry PDFs.
 */
const NEGATIVE_WORDS = [
  'bestellung', 'bestellbestätigung', 'order confirmed', 'order confirmation',
  'versandbestätigung', 'shipping', 'versandt', 'tracking', 'sendungsverfolgung',
  'newsletter', 'angebot', 'gutschein', 'vielen dank für ihren einkauf',
  'payreq', 'zahlungserinnerung',  // dunning: about an invoice, not one itself
];

/**
 * Score 0..1 that this is an invoice worth reading. This is a FILTER, not a
 * verdict — the LLM/XML extraction step decides. Its job is to keep the
 * expensive step off obvious noise.
 *
 * Deliberately not a trained classifier: with a corpus of one mailbox that
 * would overfit, and the operating model tolerates a wrong call that is
 * reported. Tune the threshold from observed behaviour instead.
 */
export function invoiceLikelihood(c: Candidate): number {
  const haystack = `${c.subject ?? ''} ${c.snippet ?? ''}`.toLowerCase();
  const from = (c.from ?? '').toLowerCase();

  let score = 0;
  if (INVOICE_WORDS.some((w) => haystack.includes(w))) score += 0.5;
  if (c.hasPdf) score += 0.3;
  // Billing-shaped sender addresses are a strong, cheap signal.
  if (/billing|invoice|rechnung|buchhaltung|accounts|noreply.*pay/.test(from)) score += 0.2;

  // Negatives subtract rather than veto: "Rechnung zu Ihrer Bestellung" is a
  // real invoice that mentions an order, and a hard veto would drop it.
  if (NEGATIVE_WORDS.some((w) => haystack.includes(w))) score -= 0.35;

  return Math.max(0, Math.min(1, score));
}

/** Above this, spend a read + extraction on the message. */
export const INVOICE_READ_THRESHOLD = 0.5;

export function rankCandidates(cs: Candidate[]): Array<Candidate & { score: number }> {
  return cs
    .map((c) => ({ ...c, score: invoiceLikelihood(c) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Does this attachment carry structured invoice XML (ZUGFeRD / XRechnung)?
 *
 * This is the determinism gate. A hit means exact parsing with no model
 * involved; a miss falls back to LLM extraction. ZUGFeRD embeds XML inside a
 * PDF/A-3, so a `.pdf` name proves nothing either way — the embedded-file check
 * happens after download. XRechnung ships as bare XML.
 */
export function mayCarryInvoiceXml(filename: string, mimeType?: string): boolean {
  const f = filename.toLowerCase();
  if (f.endsWith('.xml')) return true;
  if (mimeType === 'application/xml' || mimeType === 'text/xml') return true;
  // A PDF *might* be PDF/A-3 with an embedded factur-x.xml — worth checking.
  return f.endsWith('.pdf');
}

/** Embedded-XML filenames the ZUGFeRD/Factur-X standards specify. */
export const ZUGFERD_XML_NAMES = [
  'factur-x.xml',
  'zugferd-invoice.xml',
  'ZUGFeRD-invoice.xml',
  'xrechnung.xml',
];
