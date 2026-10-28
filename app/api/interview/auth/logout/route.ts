import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../../../lib/interview-auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
