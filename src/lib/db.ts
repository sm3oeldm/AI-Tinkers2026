// Prisma client singleton.
//
// SQLite URLs: the project uses "file:../data/*.db" (relative to
// prisma/schema.prisma, matching `prisma db push` semantics). At runtime we
// normalize relative paths to absolute ones against <root>/prisma so that dev,
// tests and the production server all point at exactly the same file without
// relying on version-specific client resolution quirks.
import path from "node:path";
import { PrismaClient } from "@prisma/client";

function normalizeDbUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) return url;
  const rel = url.slice("file:".length);
  const isAbsolute = rel.startsWith("/") || /^[A-Za-z]:[/\\]/.test(rel);
  if (isAbsolute) return url;
  const abs = path.resolve(process.cwd(), "prisma", rel);
  return `file:${abs.replace(/\\/g, "/")}`;
}

function createClient(): PrismaClient {
  const url = normalizeDbUrl();
  return url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
