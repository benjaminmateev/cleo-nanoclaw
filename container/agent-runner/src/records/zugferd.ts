/**
 * ZUGFeRD / Factur-X / XRechnung extraction — the deterministic path.
 *
 * German e-invoices embed structured XML (inside a PDF/A-3 for ZUGFeRD and
 * Factur-X, standalone for XRechnung). Where that XML exists, the invoice fields
 * are stated exactly and there is nothing to infer: no model, no OCR, no cost,
 * no confidence score. Given the German e-invoicing mandate this path will cover
 * a growing share of invoices, so it is the PRIMARY route and LLM extraction is
 * the fallback.
 *
 * Deliberately NOT using a general XML parser. The element set below is small,
 * fixed by the standard, and namespace-prefixed in ways that vary between
 * issuers (`ram:` / `a:` / none). Targeted extraction over a known schema is
 * both smaller than a parser dependency and harder to trip up — an unexpected
 * document yields nulls rather than a thrown error, which is the right failure
 * mode when this runs unattended over a customer's mailbox.
 *
 * Money is returned as integer cents to match the store. Never floats.
 */

/** Amounts and metadata as stated by the document itself. */
export interface ZugferdInvoice {
  invoiceNumber: string | null;
  issuedOn: string | null;       // ISO yyyy-mm-dd
  dueOn: string | null;
  sellerName: string | null;
  buyerName: string | null;
  currency: string;
  netCents: number | null;       // TaxBasisTotalAmount
  vatCents: number | null;       // TaxTotalAmount
  grossCents: number | null;     // GrandTotalAmount
  vatRate: number | null;
}

/**
 * Match an element ignoring namespace prefix. Issuers differ (`ram:ID`, `a:ID`,
 * bare `ID`), and a prefix-sensitive match silently returns nothing on a
 * perfectly valid invoice.
 */
function tag(xml: string, name: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`, 'i');
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

/** All occurrences — needed where the standard permits repetition. */
function tagAll(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

/** Contents of a named section, so a lookup can be scoped to it. */
function section(xml: string, name: string): string | null {
  return tag(xml, name);
}

/**
 * Parse a decimal amount into integer cents.
 *
 * Rounds rather than truncates: ZUGFeRD amounts are already 2dp by the
 * standard, but a 4dp value (permitted for unit prices) must not silently lose
 * a cent. Returns null rather than 0 on garbage — a missing amount and a zero
 * amount are different facts.
 */
export function toCents(value: string | null | undefined): number | null {
  if (value == null) return null;
  const cleaned = value.trim().replace(/\s/g, '');
  if (!/^-?\d+(?:[.,]\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * `udt:DateTimeString format="102"` is YYYYMMDD. Other formats exist (`610` =
 * YYYYMM, `616` = week) but are vanishingly rare on invoices; unrecognised
 * shapes return null instead of a wrong date.
 */
export function parseZugferdDate(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.trim().replace(/[^0-9]/g, '');
  if (digits.length !== 8) return null;
  const y = digits.slice(0, 4), m = digits.slice(4, 6), d = digits.slice(6, 8);
  const month = Number(m), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${m}-${d}`;
}

/** Is this text a ZUGFeRD/Factur-X/XRechnung document at all? */
export function looksLikeInvoiceXml(xml: string): boolean {
  return (
    /CrossIndustryInvoice/i.test(xml) ||     // ZUGFeRD / Factur-X
    /<(?:[A-Za-z0-9]+:)?Invoice\b/i.test(xml) // UBL (XRechnung)
  );
}

/**
 * Extract invoice fields from ZUGFeRD/Factur-X XML.
 *
 * Returns nulls for anything absent rather than throwing: the MINIMUM profile
 * legitimately omits most fields, and a partial invoice is still worth
 * recording. The caller decides whether what came back is enough.
 */
export function parseZugferd(xml: string): ZugferdInvoice {
  const doc = section(xml, 'ExchangedDocument') ?? xml;
  const agreement = section(xml, 'ApplicableHeaderTradeAgreement') ?? '';
  const settlement = section(xml, 'ApplicableHeaderTradeSettlement') ?? '';
  const totals = section(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation') ?? settlement;

  // Scope party lookups to their own sections — a bare `Name` search would
  // return whichever party appears first in the file.
  const seller = section(agreement, 'SellerTradeParty');
  const buyer = section(agreement, 'BuyerTradeParty');

  const issueRaw = tag(section(doc, 'IssueDateTime') ?? doc, 'DateTimeString');
  const dueRaw = tag(section(settlement, 'SpecifiedTradePaymentTerms') ?? '', 'DateTimeString');

  // VAT rate may be stated per line and per document; the header rate is the
  // meaningful one for a single-rate invoice. Mixed-rate invoices need line
  // detail, which is out of scope here — the store keeps one rate.
  const taxSection = section(settlement, 'ApplicableTradeTax') ?? '';
  const rateRaw = tag(taxSection, 'RateApplicablePercent') ?? tagAll(xml, 'RateApplicablePercent')[0] ?? null;

  return {
    invoiceNumber: tag(doc, 'ID'),
    issuedOn: parseZugferdDate(issueRaw),
    dueOn: parseZugferdDate(dueRaw),
    sellerName: seller ? tag(seller, 'Name') : null,
    buyerName: buyer ? tag(buyer, 'Name') : null,
    currency: tag(settlement, 'InvoiceCurrencyCode') ?? 'EUR',
    netCents: toCents(tag(totals, 'TaxBasisTotalAmount')),
    vatCents: toCents(tag(totals, 'TaxTotalAmount')),
    grossCents: toCents(tag(totals, 'GrandTotalAmount')),
    vatRate: rateRaw == null ? null : Number(rateRaw.replace(',', '.')) || null,
  };
}

/**
 * Locate embedded invoice XML inside a PDF's raw bytes.
 *
 * ZUGFeRD embeds the XML as a PDF/A-3 attachment. A full PDF parser would be
 * the correct way to extract it, but the payload is frequently stored
 * uncompressed, and the document is bounded by unmistakable markers — so a
 * targeted scan handles the common case with no dependency.
 *
 * Returns null when the XML is compressed (FlateDecode), which is a legitimate
 * miss, not an error: the caller falls back to LLM extraction exactly as it
 * would for a scanned PDF. Worth revisiting with real inflate if the miss rate
 * proves high in practice.
 */
export function extractXmlFromPdf(bytes: Uint8Array): string | null {
  // latin1 keeps byte offsets intact; the XML itself is UTF-8 but the markers
  // we search for are ASCII.
  const text = Buffer.from(bytes).toString('latin1');
  const start = text.search(/<\?xml|<(?:[A-Za-z0-9]+:)?CrossIndustryInvoice/i);
  if (start < 0) return null;

  const endMarker = /<\/(?:[A-Za-z0-9]+:)?(?:CrossIndustryInvoice|Invoice)>/i;
  const rest = text.slice(start);
  const endMatch = endMarker.exec(rest);
  if (!endMatch) return null;

  const raw = rest.slice(0, endMatch.index + endMatch[0].length);
  // Re-decode as UTF-8 so umlauts in party names survive.
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  return looksLikeInvoiceXml(utf8) ? utf8 : null;
}

/** Shape the store expects, from parsed XML. */
export function toInvoiceInput(
  parsed: ZugferdInvoice,
  opts: { source: string; sourceRef?: string | null },
) {
  return {
    vendor: parsed.sellerName ?? 'Unknown vendor',
    invoiceNumber: parsed.invoiceNumber,
    issuedOn: parsed.issuedOn,
    dueOn: parsed.dueOn,
    netCents: parsed.netCents,
    vatCents: parsed.vatCents,
    grossCents: parsed.grossCents,
    vatRate: parsed.vatRate,
    currency: parsed.currency,
    source: opts.source,
    sourceRef: opts.sourceRef ?? null,
    // 'xml' marks this as exact, which is what stops a later LLM pass
    // downgrading it (see upsertInvoice).
    extraction: 'xml' as const,
    confidence: 1,
  };
}
