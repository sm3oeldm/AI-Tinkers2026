import { NextResponse } from "next/server";
import { checkOrigin, jsonOk, readJson, route } from "@/lib/http";
import { login } from "@/lib/auth";

export async function POST(req: Request) {
  return route(async () => {
    checkOrigin(req);
    const { email, password } = await readJson<{ email?: string; password?: string }>(req);
    if (!email || !password) return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    const user = await login(email, password);
    if (!user) return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    return jsonOk({ user });
  });
}
