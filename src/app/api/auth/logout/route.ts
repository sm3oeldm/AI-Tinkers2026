import { cookies } from "next/headers";
import { checkOrigin, jsonOk, route } from "@/lib/http";
import { clearSessionCookie, SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  return route(async () => {
    checkOrigin(req);
    const store = await cookies();
    const sid = store.get(SESSION_COOKIE)?.value;
    if (sid) await clearSessionCookie(sid);
    return jsonOk({ ok: true });
  });
}
