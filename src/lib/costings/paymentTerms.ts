/**
 * CBP's fallback payment terms (business-confirmed 2026-09-12): whenever
 * nothing more specific is set -- no per-quotation override, and either no
 * customer or a customer with no payment_terms of its own -- a quotation
 * must still show terms rather than going out blank. Not stored on any row;
 * applied at the point of use so it also covers customers created before
 * this default existed and any future one that simply never sets it.
 */
export const DEFAULT_PAYMENT_TERMS = "100% DP setelah terima PO";
