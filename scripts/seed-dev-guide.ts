/**
 * Imports, validates and publishes the same representative guide package
 * used by Phase 2's automated tests into whichever DATABASE_URL is active —
 * intended for `npm run seed:guide` against the local dev database so the
 * Workspace UI has a Published guide_version to calculate against.
 */
import { pool } from "../src/lib/db";
import { generateId } from "../src/lib/ids";
import { hashPassword } from "../src/lib/auth/password";
import { importGuidePackage } from "../src/lib/guide/importGuide";
import { validateGuideVersion } from "../src/lib/guide/validateGuide";
import { publishGuideVersion } from "../src/lib/guide/publishGuide";
import { buildGuidePackageXlsx } from "../tests/fixtures/buildGuidePackageXlsx";

async function main() {
  const { rows: existing } = await pool.query(`SELECT 1 FROM guide_versions WHERE status = 'published' LIMIT 1`);
  if (existing.length > 0) {
    console.log("A guide version is already Published — skipping.");
    await pool.end();
    return;
  }

  const { rows: adminRows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM users WHERE user_id IN (
       SELECT user_id FROM user_roles WHERE role_id = (SELECT role_id FROM roles WHERE role_name = 'super_admin') AND valid_to IS NULL
     ) LIMIT 1`,
  );
  let uploaderId = adminRows[0]?.user_id;
  if (!uploaderId) {
    uploaderId = generateId("usr");
    const passwordHash = await hashPassword("seed-only-not-a-real-login");
    await pool.query(
      `INSERT INTO users (user_id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)`,
      [uploaderId, `seed_uploader_${Date.now()}`, passwordHash, "Seed Uploader"],
    );
  }

  const versionCode = `2026.dev.${Date.now()}`;
  const file = await buildGuidePackageXlsx({ versionCode });
  const { guideVersionId } = await importGuidePackage({
    fileBuffer: file,
    originalFilename: "dev-seed-guide.xlsx",
    versionCode,
    uploadedBy: uploaderId,
    requestId: "req-seed-dev-guide",
  });
  await validateGuideVersion(guideVersionId, uploaderId, "req-seed-dev-guide-validate");
  await publishGuideVersion(guideVersionId, uploaderId, "req-seed-dev-guide-publish");

  console.log(`Published guide version ${versionCode} (${guideVersionId}).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
