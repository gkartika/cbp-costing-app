import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { UserAdmin } from "./UserAdmin";

export default async function AdminUsersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.roles.includes("super_admin")) notFound();

  const { rows } = await pool.query<{
    user_id: string;
    username: string;
    display_name: string;
    active: boolean;
    must_reset_password: boolean;
    roles: string[] | null;
  }>(
    `SELECT u.user_id, u.username, u.display_name, u.active, u.must_reset_password,
            array_remove(array_agg(r.role_name), NULL) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.user_id AND ur.valid_to IS NULL
     LEFT JOIN roles r ON r.role_id = ur.role_id
     GROUP BY u.user_id
     ORDER BY u.username`,
  );

  const users = rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    active: r.active,
    mustResetPassword: r.must_reset_password,
    roles: r.roles ?? [],
  }));

  return <UserAdmin initialUsers={users} currentUserId={user.userId} />;
}
