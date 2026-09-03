/**
 * Stable error codes shared by the API, UI and automated tests (10_VALIDATION_RULES).
 * userMessage is the Indonesian message shown to end users; message is the
 * English detail used in logs/audit and is never sent to the client.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly userMessage: string;

  constructor(code: string, status: number, userMessage: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
  }
}

export const Errors = {
  authRequired: () =>
    new AppError("AUTH_REQUIRED", 401, "Silakan masuk untuk melanjutkan."),
  invalidCredentials: () =>
    new AppError("INVALID_CREDENTIALS", 401, "Username atau password salah."),
  accountInactive: () =>
    new AppError("ACCOUNT_INACTIVE", 403, "Akun ini tidak aktif."),
  loginRateLimited: () =>
    new AppError(
      "LOGIN_RATE_LIMITED",
      429,
      "Terlalu banyak percobaan login. Coba lagi dalam beberapa menit.",
    ),
  forbidden: () =>
    new AppError("FORBIDDEN", 403, "Anda tidak memiliki izin untuk tindakan ini."),
  costingReadOnly: () =>
    new AppError(
      "COSTING_READ_ONLY",
      403,
      "Costing ini milik user lain dan hanya dapat dilihat.",
    ),
  costingLocked: () =>
    new AppError(
      "COSTING_LOCKED",
      409,
      "Costing yang sudah final tidak dapat diedit. Buat revisi.",
    ),
  staleUpdate: () =>
    new AppError(
      "STALE_UPDATE",
      409,
      "Data telah diubah user lain. Muat ulang sebelum melanjutkan.",
    ),
  notFound: (entity = "Data") =>
    new AppError("NOT_FOUND", 404, `${entity} tidak ditemukan.`),
  validation: (userMessage: string, message?: string) =>
    new AppError("VALIDATION_ERROR", 400, userMessage, message),

  // 10_VALIDATION_RULES — calculation engine (VAL-003..021)
  routeRequired: () => new AppError("ROUTE_REQUIRED", 400, "Pilih Trading atau Custom Production."),
  qtyInvalid: () => new AppError("QTY_INVALID", 400, "Quantity minimal 1."),
  guideNotActive: () => new AppError("GUIDE_NOT_ACTIVE", 409, "Panduan harga belum aktif."),
  profileNotFound: () => new AppError("PROFILE_NOT_FOUND", 422, "Profile untuk grade ini belum tersedia."),
  profileAmbiguous: () => new AppError("PROFILE_AMBIGUOUS", 422, "Panduan profile memiliki konflik."),
  hexWidthMissing: () => new AppError("HEX_WIDTH_MISSING", 422, "Ukuran hex belum lengkap."),
  rawSizeInvalid: () => new AppError("RAW_SIZE_INVALID", 422, "Ukuran bahan baku tidak valid."),
  rawBarUnavailable: () =>
    new AppError("RAW_BAR_UNAVAILABLE", 422, "Tidak ada stok batang bahan baku pada diameter ini atau lebih besar."),
  weightInvalid: () => new AppError("WEIGHT_INVALID", 422, "Berat costing tidak valid."),
  priceGuideNotFound: () => new AppError("PRICE_GUIDE_NOT_FOUND", 422, "Panduan harga per kg tidak ditemukan."),
  wrongCostingRoute: (grade: string, requiredRoute: string) =>
    new AppError(
      "WRONG_COSTING_ROUTE",
      422,
      `Grade ${grade} harus di-costing lewat ${requiredRoute}, bukan route ini.`,
    ),
  adjustmentNoMatch: () =>
    new AppError("ADJUSTMENT_NO_MATCH", 422, "Kondisi quantity/lead time/panjang tidak tersedia dalam panduan."),
  adjustmentAmbiguous: () => new AppError("ADJUSTMENT_AMBIGUOUS", 422, "Panduan adjustment memiliki range overlap."),
  tradingTierNotFound: () =>
    new AppError("TRADING_TIER_NOT_FOUND", 422, "Harga trading untuk quantity ini belum tersedia."),
  ppnRateRequired: () => new AppError("PPN_RATE_REQUIRED", 400, "Tarif PPN diperlukan untuk menormalkan harga."),
  landedCostConfirmationRequired: () =>
    new AppError("LANDED_COST_CONFIRMATION_REQUIRED", 400, "Konfirmasi harga sudah termasuk ongkir dan biaya impor."),
  marginInvalid: () => new AppError("MARGIN_INVALID", 400, "Margin harus minimal 0% dan kurang dari 100%."),
  coatingGuideNotFound: () => new AppError("COATING_GUIDE_NOT_FOUND", 422, "Panduan coating tidak ditemukan."),
  diesCostRequired: () => new AppError("DIES_COST_REQUIRED", 400, "Masukkan biaya dies untuk order ini."),
  poNumberRequired: () => new AppError("PO_NUMBER_REQUIRED", 400, "Masukkan nomor PO dari customer."),
  diesCostGuideNotFound: () =>
    new AppError("DIES_COST_GUIDE_NOT_FOUND", 422, "Tidak ada referensi biaya dies untuk kombinasi ini — gunakan opsi \"Lainnya\" dan masukkan biaya secara manual."),
  anchorDevelopedLengthRequired: () =>
    new AppError("ANCHOR_DEVELOPED_LENGTH_REQUIRED", 400, "Masukkan panjang bahan sebelum ditekuk."),
  recalculationRequired: () =>
    new AppError("RECALCULATION_REQUIRED", 409, "Hitung ulang semua item sebelum finalisasi."),
  quotationNotFinal: () =>
    new AppError("QUOTATION_NOT_FINAL", 409, "Quotation harus difinalisasi sebelum diekspor."),

  // 10_VALIDATION_RULES — guide import/publish (VAL-023..029)
  guideSchemaInvalid: (detail?: string) =>
    new AppError("GUIDE_SCHEMA_INVALID", 422, "Format file panduan tidak sesuai template.", detail),
  guideDuplicateKey: (detail?: string) =>
    new AppError("GUIDE_DUPLICATE_KEY", 422, "Terdapat ID atau kombinasi data duplikat.", detail),
  guideRangeInvalid: (detail?: string) =>
    new AppError("GUIDE_RANGE_INVALID", 422, "Range panduan overlap atau tidak lengkap.", detail),
  guideRawBarGap: (detail?: string) =>
    new AppError("GUIDE_RAW_BAR_GAP", 422, "Ada ukuran yang dijual tanpa stok batang bahan baku yang cukup.", detail),
  guideReferenceMissing: (detail?: string) =>
    new AppError("GUIDE_REFERENCE_MISSING", 422, "Panduan memiliki referensi yang tidak ditemukan.", detail),
  guideAliasInvalid: (detail?: string) =>
    new AppError("GUIDE_ALIAS_INVALID", 422, "Mapping alias grade tidak valid.", detail),
  guideFormulaInvalid: (detail?: string) =>
    new AppError("GUIDE_FORMULA_INVALID", 422, "Formula panduan tidak dapat dijalankan.", detail),
  guideRegressionFailed: (detail?: string) =>
    new AppError("GUIDE_REGRESSION_FAILED", 422, "Versi panduan gagal simulation test.", detail),
  guideImportRejected: (detail?: string) =>
    new AppError(
      "GUIDE_IMPORT_REJECTED",
      422,
      "Paket panduan berisi data transaksional yang tidak diperbolehkan.",
      detail,
    ),
};

/** Narrows an unknown catch value to AppError, defaulting to a sanitized 500. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Never leak internal error details (stack traces, DB errors) to the client.
  return new AppError(
    "INTERNAL_ERROR",
    500,
    "Terjadi kesalahan pada server. Silakan coba lagi.",
    err instanceof Error ? err.message : String(err),
  );
}
