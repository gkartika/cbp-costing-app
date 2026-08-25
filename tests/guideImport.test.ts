import { describe, it, expect, beforeEach } from "vitest";
import { pool } from "../src/lib/db";
import { generateId } from "../src/lib/ids";
import { hashPassword } from "../src/lib/auth/password";
import { importGuidePackage } from "../src/lib/guide/importGuide";
import { validateGuideVersion } from "../src/lib/guide/validateGuide";
import { publishGuideVersion } from "../src/lib/guide/publishGuide";
import { buildGuidePackageXlsx } from "./fixtures/buildGuidePackageXlsx";
import { AppError } from "../src/lib/errors";

let adminUserId: string;

beforeEach(async () => {
  adminUserId = generateId("usr");
  await pool.query(
    `INSERT INTO users (user_id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)`,
    [adminUserId, `guide_admin_${Date.now()}`, await hashPassword("irrelevant-not-logged-in-via-http"), "Guide Admin"],
  );
});

describe("AT-IMPORT-001: import atomicity", () => {
  it("a valid package imports cleanly as a Draft with all master rows staged", async () => {
    const file = await buildGuidePackageXlsx({ versionCode: `V-${Date.now()}-ok` });
    const result = await importGuidePackage({
      fileBuffer: file,
      originalFilename: "guide.xlsx",
      versionCode: `V-${Date.now()}-ok`,
      uploadedBy: adminUserId,
      requestId: "req-import-1",
    });

    const gv = await pool.query(`SELECT status FROM guide_versions WHERE guide_version_id = $1`, [result.guideVersionId]);
    expect(gv.rows[0].status).toBe("draft");

    const priceRows = await pool.query(`SELECT * FROM price_per_kg WHERE guide_version_id = $1`, [result.guideVersionId]);
    expect(priceRows.rows).toHaveLength(1);
  });

  it("a duplicate business key rolls the whole import back — no partial rows land", async () => {
    const versionCode = `V-${Date.now()}-dup`;
    const file = await buildGuidePackageXlsx({
      versionCode,
      mutate: (sheets) => {
        // Two Grade_Profile_Rules rows for the same (product_family, grade_or_spec).
        sheets.Grade_Profile_Rules.push([
          "PROFILE-BOLT-A325-DUP",
          "Bolt",
          "A325",
          "Regular Hex",
          "confirmed",
          false,
          200,
          "",
          "",
          "",
          true,
        ]);
      },
    });

    let error: unknown;
    try {
      await importGuidePackage({
        fileBuffer: file,
        originalFilename: "guide.xlsx",
        versionCode,
        uploadedBy: adminUserId,
        requestId: "req-import-2",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_DUPLICATE_KEY");

    const gv = await pool.query(`SELECT * FROM guide_versions WHERE version_code = $1`, [versionCode]);
    expect(gv.rows).toHaveLength(0); // whole transaction rolled back, including the guide_versions row itself
  });

  it("a reference to a non-existent row is rejected", async () => {
    const versionCode = `V-${Date.now()}-ref`;
    const file = await buildGuidePackageXlsx({
      versionCode,
      mutate: (sheets) => {
        sheets.Material_Grade_Map.push(["MGM-BAD", "MAT-DOES-NOT-EXIST", "Bolt", "X", "", true]);
      },
    });

    let error: unknown;
    try {
      await importGuidePackage({
        fileBuffer: file,
        originalFilename: "guide.xlsx",
        versionCode,
        uploadedBy: adminUserId,
        requestId: "req-import-3",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_REFERENCE_MISSING");
  });

  it("EXC-001: a package containing an operational tab is rejected outright", async () => {
    const wbFile = await buildGuidePackageXlsx({ versionCode: `V-${Date.now()}-exc` });
    // Re-open and add a forbidden tab to prove the check fires even alongside otherwise-valid data.
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(wbFile as unknown as ArrayBuffer);
    wb.addWorksheet("Costing_Headers").addRow(["costing_id"]);
    const mutatedBuffer = Buffer.from(await wb.xlsx.writeBuffer());

    let error: unknown;
    try {
      await importGuidePackage({
        fileBuffer: mutatedBuffer,
        originalFilename: "guide.xlsx",
        versionCode: `V-${Date.now()}-exc2`,
        uploadedBy: adminUserId,
        requestId: "req-import-4",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_IMPORT_REJECTED");
  });
});

describe("AT-IMPORT-002: overlapping ranges are caught at validate time", () => {
  it("overlapping adjustment_rules ranges -> GUIDE_RANGE_INVALID", async () => {
    const versionCode = `V-${Date.now()}-range`;
    const file = await buildGuidePackageXlsx({
      versionCode,
      mutate: (sheets) => {
        // Overlaps the existing 26-30 Bolt|Carbon quantity rule.
        sheets.Adjustment_Rules.push([
          "RULE-BOLT-QTY-OVERLAP",
          "Custom Production",
          "Quantity",
          "Bolt|Carbon",
          "qty",
          20,
          40,
          "percent_add",
          0.1,
          "base_price_per_item",
          true,
          true,
          true,
        ]);
      },
    });
    const { guideVersionId } = await importGuidePackage({
      fileBuffer: file,
      originalFilename: "guide.xlsx",
      versionCode,
      uploadedBy: adminUserId,
      requestId: "req-range-1",
    });

    let error: unknown;
    try {
      await validateGuideVersion(guideVersionId, adminUserId, "req-range-2");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_RANGE_INVALID");
  });
});

describe("AT-IMPORT-009: a priced size with no stocked raw bar big enough is caught at validate time", () => {
  it("Bolt A325 M40 (nominal 40mm) with only an 18mm SCM440 bar stocked -> GUIDE_RAW_BAR_GAP", async () => {
    const versionCode = `V-${Date.now()}-rawbar`;
    const file = await buildGuidePackageXlsx({
      versionCode,
      mutate: (sheets) => {
        // A new, bigger Heavy Hex size than the fixture's only Raw_Bar_Stock
        // row (MAT-SCM440 @ 18mm) can cover -- a genuine sourcing gap.
        sheets.Material_Size_Guides.push([
          "SIZE-HEAVY-HEX-M40", "Metric", "ANSI Metric", "Heavy Hex", "M40", 40, 45, 60, 69.24, 25, null, null, true,
        ]);
        sheets.Price_Per_Kg.push([
          "PRICE-BOLT-A325-M40", "Bolt", "Hex Bolt", "HT", "A325", "SCM440", "Metric", "M40", 40, 60000, "IDR", true,
        ]);
      },
    });
    const { guideVersionId } = await importGuidePackage({
      fileBuffer: file,
      originalFilename: "guide.xlsx",
      versionCode,
      uploadedBy: adminUserId,
      requestId: "req-rawbar-1",
    });

    let error: unknown;
    try {
      await validateGuideVersion(guideVersionId, adminUserId, "req-rawbar-2");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_RAW_BAR_GAP");
  });
});

describe("AT-IMPORT-003: unsupported formula token is caught at validate time", () => {
  it("a formula calling a disallowed function -> GUIDE_FORMULA_INVALID", async () => {
    const versionCode = `V-${Date.now()}-formula`;
    const file = await buildGuidePackageXlsx({
      versionCode,
      mutate: (sheets) => {
        sheets.Calculation_Formulas[1] = [
          "FORMULA-BOLT-RAW-CUT-V1",
          "Bolt",
          "raw_cut_weight_per_item",
          "raw_weight=EXEC(raw_diameter)", // EXEC is not in the allow-list
          "raw_diameter,width_flat,width_corner,head_thickness,finished_length,density",
          0.02,
          "confirmed",
          "",
          "",
          true,
        ];
      },
    });
    const { guideVersionId } = await importGuidePackage({
      fileBuffer: file,
      originalFilename: "guide.xlsx",
      versionCode,
      uploadedBy: adminUserId,
      requestId: "req-formula-1",
    });

    let error: unknown;
    try {
      await validateGuideVersion(guideVersionId, adminUserId, "req-formula-2");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_FORMULA_INVALID");
  });
});

describe("AT-IMPORT-008: golden Simulation_Cases regression gates validation", () => {
  it("a valid package's bundled golden case passes and the version becomes Validated", async () => {
    const versionCode = `V-${Date.now()}-sim-ok`;
    const file = await buildGuidePackageXlsx({ versionCode });
    const { guideVersionId } = await importGuidePackage({
      fileBuffer: file,
      originalFilename: "guide.xlsx",
      versionCode,
      uploadedBy: adminUserId,
      requestId: "req-sim-1",
    });

    const report = await validateGuideVersion(guideVersionId, adminUserId, "req-sim-2");
    expect(report.simulationCasesRun).toBe(1);
    expect(report.regressionFailures).toHaveLength(0);

    const gv = await pool.query(`SELECT status FROM guide_versions WHERE guide_version_id = $1`, [guideVersionId]);
    expect(gv.rows[0].status).toBe("validated");
  });

  it("GUIDE_REGRESSION_FAILED when the bundled golden case's expected values are wrong", async () => {
    const versionCode = `V-${Date.now()}-sim-bad`;
    const file = await buildGuidePackageXlsx({
      versionCode,
      mutate: (sheets) => {
        const expected = JSON.parse(sheets.Simulation_Cases[1][4] as string);
        expected.unitSellingPrice = 999999; // deliberately wrong
        sheets.Simulation_Cases[1][4] = JSON.stringify(expected);
      },
    });
    const { guideVersionId } = await importGuidePackage({
      fileBuffer: file,
      originalFilename: "guide.xlsx",
      versionCode,
      uploadedBy: adminUserId,
      requestId: "req-sim-3",
    });

    let error: unknown;
    try {
      await validateGuideVersion(guideVersionId, adminUserId, "req-sim-4");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_REGRESSION_FAILED");
  });
});

describe("AT-VERSION-001: publishing a new version never mutates an already-published one", () => {
  it("V1 stays Published+unchanged in the DB until V2 is actually published, then V1 retires atomically", async () => {
    const v1Code = `V-${Date.now()}-v1`;
    const file1 = await buildGuidePackageXlsx({ versionCode: v1Code });
    const { guideVersionId: v1 } = await importGuidePackage({
      fileBuffer: file1,
      originalFilename: "guide.xlsx",
      versionCode: v1Code,
      uploadedBy: adminUserId,
      requestId: "req-v1-1",
    });
    await validateGuideVersion(v1, adminUserId, "req-v1-2");
    await publishGuideVersion(v1, adminUserId, "req-v1-3");

    const v1PriceBefore = await pool.query(
      `SELECT selling_price_per_kg FROM price_per_kg WHERE guide_version_id = $1`,
      [v1],
    );
    expect(Number(v1PriceBefore.rows[0].selling_price_per_kg)).toBe(70000);

    const v2Code = `V-${Date.now()}-v2`;
    const file2 = await buildGuidePackageXlsx({
      versionCode: v2Code,
      mutate: (sheets) => {
        sheets.Price_Per_Kg[1][9] = 99000; // different price in the new version
        // The bundled golden case's expected values were computed for the old
        // price and would now correctly fail regression — drop it here since
        // this test is about version history, not re-deriving new goldens.
        sheets.Simulation_Cases.splice(1, 1);
      },
    });
    const { guideVersionId: v2 } = await importGuidePackage({
      fileBuffer: file2,
      originalFilename: "guide.xlsx",
      versionCode: v2Code,
      uploadedBy: adminUserId,
      requestId: "req-v2-1",
    });

    // V1 is untouched by V2 merely being imported as a Draft.
    const v1AfterImport = await pool.query(`SELECT status FROM guide_versions WHERE guide_version_id = $1`, [v1]);
    expect(v1AfterImport.rows[0].status).toBe("published");

    await validateGuideVersion(v2, adminUserId, "req-v2-2");
    await publishGuideVersion(v2, adminUserId, "req-v2-3");

    const v1AfterPublish = await pool.query(`SELECT status FROM guide_versions WHERE guide_version_id = $1`, [v1]);
    expect(v1AfterPublish.rows[0].status).toBe("retired");

    // AT-VERSION-002: V1's own master rows are never rewritten — a costing that
    // captured v1 in its snapshot would still see the original price.
    const v1PriceAfter = await pool.query(
      `SELECT selling_price_per_kg FROM price_per_kg WHERE guide_version_id = $1`,
      [v1],
    );
    expect(Number(v1PriceAfter.rows[0].selling_price_per_kg)).toBe(70000);

    const v2Price = await pool.query(`SELECT selling_price_per_kg FROM price_per_kg WHERE guide_version_id = $1`, [v2]);
    expect(Number(v2Price.rows[0].selling_price_per_kg)).toBe(99000);

    const v2Status = await pool.query(`SELECT status FROM guide_versions WHERE guide_version_id = $1`, [v2]);
    expect(v2Status.rows[0].status).toBe("published");
  });
});
