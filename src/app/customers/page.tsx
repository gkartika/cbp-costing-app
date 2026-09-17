import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { serializeCustomer, type CustomerRow } from "@/lib/costings/customers";
import { CustomersAdmin } from "./CustomersAdmin";

export default async function CustomersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { rows } = await pool.query<CustomerRow>(`SELECT * FROM customers WHERE active = TRUE ORDER BY customer_name`);

  const isSuperAdmin = user.roles.includes("super_admin");
  const canEditCustomer = isSuperAdmin || user.roles.includes("costing_head");

  return (
    <CustomersAdmin
      initialCustomers={rows.map(serializeCustomer)}
      isSuperAdmin={isSuperAdmin}
      canEditCustomer={canEditCustomer}
    />
  );
}
