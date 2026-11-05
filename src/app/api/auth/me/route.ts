import { jsonOk, route } from "@/lib/http";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  return route(async () => {
    return jsonOk({ user: await getCurrentUser() });
  });
}
