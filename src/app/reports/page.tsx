import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { ReportsClient } from "./ReportsClient";

export default async function ReportsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <div className="app-shell">
      <div style={{ marginBottom: 16 }}>
        <a href="/dashboard" className="link-btn">
          &larr; Dashboard
        </a>
      </div>

      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">CBP</div>
          <div className="brand-text">
            <h1>Laporan</h1>
            <p>Quotation &amp; PO</p>
          </div>
        </div>
      </header>

      <ReportsClient />
    </div>
  );
}
