import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");

  // Dev/demo convenience only — DEMO_ADMIN_* are never set outside a local
  // .env.local, so this block simply doesn't render in a real deployment.
  // The NODE_ENV check is belt-and-suspenders: even if those vars were ever
  // set by mistake in a production environment, this still never renders.
  const isProduction = process.env.NODE_ENV === "production";
  const demoUsername = isProduction ? undefined : process.env.DEMO_ADMIN_USERNAME;
  const demoPassword = isProduction ? undefined : process.env.DEMO_ADMIN_PASSWORD;

  return (
    <div className="login-gate">
      <div className="login-card">
        <div className="brand" style={{ marginBottom: 22 }}>
          <img src="/brand/cbp-logo.png" alt="CBP" className="brand-mark" />
          <div className="brand-text">
            <h1>CBP Costing App</h1>
            <p>Costing &amp; Quotation</p>
          </div>
        </div>
        <LoginForm />
        {demoUsername && demoPassword && (
          <div className="warn-note" style={{ marginTop: 22, marginBottom: 0 }}>
            <strong style={{ color: "var(--ink)" }}>Demo account (local dev only)</strong>
            <div className="mono" style={{ marginTop: 6 }}>
              Username: {demoUsername}
            </div>
            <div className="mono">Password: {demoPassword}</div>
            <div style={{ marginTop: 4 }}>Role: super_admin</div>
          </div>
        )}
      </div>
    </div>
  );
}
