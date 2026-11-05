import { NextResponse } from "next/server";

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function jsonOk(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function route(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  return fn().catch((err: unknown) => {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message, details: err.details ?? undefined }, { status: err.status });
    }
    console.error("[api] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  });
}

/** CSRF guard for mutating requests: if an Origin header is present it must
 * match the request host. Browsers always send Origin on POST; non-browser
 * clients (tests/curl) may omit it. */
export function checkOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (host && originHost && originHost !== host) {
    throw new ApiError(403, "Cross-origin request rejected");
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
}

export function requireParam(value: string | undefined | null, name: string): string {
  if (!value) throw new ApiError(400, `Missing ${name}`);
  return value;
}
