/**
 * CBP's fallback payment terms (business-confirmed 2026-09-12): whenever
 * nothing more specific is set -- no per-quotation override, and either no
 * customer or a customer with no payment_terms of its own -- a quotation
 * must still show terms rather than going out blank. Not stored on any row;
 * applied at the point of use so it also covers customers created before
 * this default existed and any future one that simply never sets it.
 */
export const DEFAULT_PAYMENT_TERMS = "100% DP setelah terima PO";

/**
 * The fixed set of payment terms CBP actually quotes (business-confirmed
 * 2026-09-17): every combination of DP% (100/70/50/30/0) and how the
 * remainder is settled (before shipment, or NET 14/30/45/60) — 100% DP needs
 * no remainder leg. Used to turn the per-quotation Termin Pembayaran field
 * from free text into a dropdown so every quotation reads consistently.
 */
export const PAYMENT_TERMS_OPTIONS = [
  "100% DP setelah terima PO",
  "70% DP setelah PO, 30% sebelum pengiriman",
  "70% DP setelah PO, 30% NET 14",
  "70% DP setelah PO, 30% NET 30",
  "70% DP setelah PO, 30% NET 45",
  "70% DP setelah PO, 30% NET 60",
  "50% DP setelah PO, 50% sebelum pengiriman",
  "50% DP setelah PO, 50% NET 14",
  "50% DP setelah PO, 50% NET 30",
  "50% DP setelah PO, 50% NET 45",
  "50% DP setelah PO, 50% NET 60",
  "30% DP setelah PO, 70% sebelum pengiriman",
  "30% DP setelah PO, 70% NET 14",
  "30% DP setelah PO, 70% NET 30",
  "30% DP setelah PO, 70% NET 45",
  "30% DP setelah PO, 70% NET 60",
  "0% DP, 100% sebelum pengiriman",
  "0% DP, NET 14",
  "0% DP, NET 30",
  "0% DP, NET 45",
  "0% DP, NET 60",
] as const;
