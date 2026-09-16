import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");

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
      </div>
    </div>
  );
}
