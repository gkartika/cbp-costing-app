import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { MasterDataAdmin } from "./MasterDataAdmin";

export default async function MasterDataPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.roles.includes("super_admin")) notFound();

  return <MasterDataAdmin />;
}
