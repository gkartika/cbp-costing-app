import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";

export const GET = apiHandler(async (_req: NextRequest) => {
  const user = await requireUser();
  return NextResponse.json({
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
    roles: user.roles,
  });
});
