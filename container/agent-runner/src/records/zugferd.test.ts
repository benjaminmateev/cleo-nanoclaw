/**
 * ZUGFeRD parser tests.
 *
 * This is the deterministic path, so the bar is different from the LLM one:
 * a wrong amount here is a silent correctness bug in the one place the design
 * deliberately chose exactness over judgement. The tests therefore focus on
 * money, dates, namespace variation, and degrading to null rather than throwing.
 */
import { test, expect } from 'bun:test';
import {
  parseZugferd, toCents, parseZugferdDate, looksLikeInvoiceXml,
  extractXmlFromPdf, toInvoiceInput,
} from './zugferd.js';

/** A realistic EN16931-profile document, trimmed to the fields we read. */
const ZUGFERD = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument>
    <ram:ID>RE-2026-0042</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">20260715</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Müller Baustoffe GmbH</ram:Name>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Mateev Consulting</ram:Name>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">20260814</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>1000.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>1000.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">190.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>1190.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>1190.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

test('parses a full ZUGFeRD invoice exactly', () => {
  const inv = parseZugferd(ZUGFERD);
  expect(inv.invoiceNumber).toBe('RE-2026-0042');
  expect(inv.issuedOn).toBe('2026-07-15');
  expect(inv.dueOn).toBe('2026-08-14');
  expect(inv.sellerName).toBe('Müller Baustoffe GmbH');
  expect(inv.buyerName).toBe('Mateev Consulting');
  expect(inv.currency).toBe('EUR');
  expect(inv.vatRate).toBe(19);
});

test('amounts are exact integer cents and reconcile', () => {
  const inv = parseZugferd(ZUGFERD);
  expect(inv.netCents).toBe(100000);
  expect(inv.vatCents).toBe(19000);
  expect(inv.grossCents).toBe(119000);
  // The property a Steuerberater would check.
  expect(inv.netCents! + inv.vatCents!).toBe(inv.grossCents!);
});

test('umlauts in the vendor name survive', () => {
  // Party names go straight into the record and then into a filename; mojibake
  // here is visible to the customer.
  expect(parseZugferd(ZUGFERD).sellerName).toBe('Müller Baustoffe GmbH');
});

test('seller and buyer are not confused', () => {
  // A bare `Name` search would return whichever party is first in the file.
  const inv = parseZugferd(ZUGFERD);
  expect(inv.sellerName).not.toBe(inv.buyerName);
  expect(inv.sellerName).toContain('Müller');
});

test('a different namespace prefix parses identically', () => {
  // Issuers vary: ram:, a:, or none at all.
  const reprefixed = ZUGFERD.replace(/ram:/g, 'a:').replace(/udt:/g, 'b:');
  const inv = parseZugferd(reprefixed);
  expect(inv.invoiceNumber).toBe('RE-2026-0042');
  expect(inv.grossCents).toBe(119000);
});

test('no namespace prefix at all still parses', () => {
  const bare = ZUGFERD.replace(/(?:ram|udt|rsm):/g, '');
  expect(parseZugferd(bare).grossCents).toBe(119000);
});

test('a MINIMUM-profile document yields nulls, not an exception', () => {
  // Legitimately omits most fields. A partial invoice is still worth recording.
  const minimal = `<rsm:CrossIndustryInvoice xmlns:rsm="x" xmlns:ram="y">
    <rsm:ExchangedDocument><ram:ID>MIN-1</ram:ID></rsm:ExchangedDocument>
  </rsm:CrossIndustryInvoice>`;
  const inv = parseZugferd(minimal);
  expect(inv.invoiceNumber).toBe('MIN-1');
  expect(inv.grossCents).toBe(null);
  expect(inv.sellerName).toBe(null);
  expect(inv.currency).toBe('EUR');   // sensible default for the target market
});

test('garbage input does not throw', () => {
  // This runs unattended over a mailbox; an exception would kill the sweep.
  expect(() => parseZugferd('not xml at all')).not.toThrow();
  expect(() => parseZugferd('')).not.toThrow();
  expect(parseZugferd('<html><body>nope</body></html>').grossCents).toBe(null);
});

// --- amount and date primitives --------------------------------------------

test('toCents handles the formats that appear on real invoices', () => {
  expect(toCents('1190.00')).toBe(119000);
  expect(toCents('1190,00')).toBe(119000);   // German decimal comma
  expect(toCents('0.01')).toBe(1);
  expect(toCents('-50.00')).toBe(-5000);     // credit notes
  expect(toCents('1190')).toBe(119000);
});

test('toCents rounds 4dp rather than truncating', () => {
  // Unit prices may carry 4dp; truncation would lose a cent.
  expect(toCents('10.005')).toBe(1001);
  expect(toCents('10.004')).toBe(1000);
});

test('toCents distinguishes missing from zero', () => {
  expect(toCents(null)).toBe(null);
  expect(toCents('')).toBe(null);
  expect(toCents('abc')).toBe(null);
  expect(toCents('0.00')).toBe(0);   // a genuine zero is not a miss
});

test('toCents avoids binary floating-point drift', () => {
  // 0.1 + 0.2 !== 0.3 is exactly why the store holds integers.
  expect(toCents('0.10')).toBe(10);
  expect(toCents('0.20')).toBe(20);
  expect(toCents('0.30')).toBe(30);
  expect(toCents('19.99')).toBe(1999);
  expect(toCents('1234.56')).toBe(123456);
});

test('parseZugferdDate reads format 102 and rejects the rest', () => {
  expect(parseZugferdDate('20260715')).toBe('2026-07-15');
  expect(parseZugferdDate('202607')).toBe(null);      // format 610, not a day
  expect(parseZugferdDate('2026-07-15')).toBe('2026-07-15'); // tolerant of dashes
  expect(parseZugferdDate('20261315')).toBe(null);    // month 13
  expect(parseZugferdDate('20260732')).toBe(null);    // day 32
  expect(parseZugferdDate(null)).toBe(null);
});

// --- detection and PDF embedding -------------------------------------------

test('recognises both CrossIndustryInvoice and UBL', () => {
  expect(looksLikeInvoiceXml(ZUGFERD)).toBe(true);
  expect(looksLikeInvoiceXml('<ubl:Invoice xmlns:ubl="x"></ubl:Invoice>')).toBe(true);
  expect(looksLikeInvoiceXml('<html></html>')).toBe(false);
});

test('extracts embedded XML from PDF bytes', () => {
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nstream\n', 'latin1'),
    Buffer.from(ZUGFERD, 'utf8'),
    Buffer.from('\nendstream\n%%EOF', 'latin1'),
  ]);
  const xml = extractXmlFromPdf(new Uint8Array(pdf));
  expect(xml).not.toBe(null);
  expect(parseZugferd(xml!).grossCents).toBe(119000);
  // Umlauts must survive the latin1 scan / utf8 re-decode.
  expect(parseZugferd(xml!).sellerName).toBe('Müller Baustoffe GmbH');
});

test('a PDF with no embedded XML returns null, not junk', () => {
  const plain = Buffer.from('%PDF-1.7\nscanned image only\n%%EOF', 'latin1');
  expect(extractXmlFromPdf(new Uint8Array(plain))).toBe(null);
});

test('toInvoiceInput marks the record exact so an LLM pass cannot downgrade it', () => {
  const input = toInvoiceInput(parseZugferd(ZUGFERD), { source: 'email-attachment', sourceRef: 'msg-1' });
  expect(input.extraction).toBe('xml');
  expect(input.confidence).toBe(1);
  expect(input.vendor).toBe('Müller Baustoffe GmbH');
  expect(input.grossCents).toBe(119000);
});

test('a document with no seller still produces a usable record', () => {
  const noSeller = ZUGFERD.replace(/<ram:SellerTradeParty>[\s\S]*?<\/ram:SellerTradeParty>/, '');
  const input = toInvoiceInput(parseZugferd(noSeller), { source: 'email-attachment' });
  // Better a placeholder the customer can correct than a dropped invoice.
  expect(input.vendor).toBe('Unknown vendor');
  expect(input.grossCents).toBe(119000);
});
