// Cookie-session authentication. Sessions live in the DB (survive server
// restarts); cookies are httpOnly + sameSite=lax. Role checks are server-side —
// a client can never gain faculty capabilities by switching UI state.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { prisma } from "./db";
import { config } from "./config";

export const SESSION_COOKIE = "cc_session";

export type AuthedUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 3600 * 1000);
  const session = await prisma.session.create({
    data: { id: `sess_${crypto.randomBytes(16).toString("hex")}`, userId, expiresAt },
  });
  return session;
}

export async function setSessionCookie(sessionId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production" && process.env.ALLOW_INSECURE_COOKIES !== "1",
    expires: new Date(Date.now() + config.sessionTtlDays * 24 * 3600 * 1000),
  });
}

export async function clearSessionCookie(sessionId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sessionId } });
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function getCurrentUser(): Promise<AuthedUser | null> {
  const store = await cookies();
  const sid = store.get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  const session = await prisma.session.findUnique({
    where: { id: sid },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return { id: session.user.id, email: session.user.email, name: session.user.name, role: session.user.role };
}

export async function login(email: string, password: string): Promise<AuthedUser | null> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) return null;
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  await setSessionCookie((await createSession(user.id)).id);
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
