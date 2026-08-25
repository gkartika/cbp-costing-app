import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiHandler } from "@/lib/http/apiHandler";
import { revokeSessionByToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";

export const POST = apiHandler(async (_req: NextRequest) => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await revokeSessionByToken(token);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE_NAME);
  return res;
});
