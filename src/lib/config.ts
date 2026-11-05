// Central configuration, parsed from process.env (next dev loads .env from the
// project root automatically; the custom server loads it in server.js).
import path from "node:path";

export type LlmProviderId = "google" | "test";

function readUploadDir(): string {
  const raw = process.env.UPLOAD_DIR || "./data/uploads";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

export const config = {
  port: Number(process.env.PORT || 8792),
  sessionTtlDays: 30,
  uploadDir: readUploadDir(),

  llm: {
    provider: (process.env.LLM_PROVIDER || "test") as LlmProviderId,
    // Spec-mandated default; adjustable per environment if Google serves a
    // different versioned id for the same model.
    model: process.env.GEMMA_MODEL || "gemma-4-31b-it",
    googleApiKey: process.env.GOOGLE_AI_API_KEY || "",
    apiBase: process.env.GOOGLE_API_BASE || "https://generativelanguage.googleapis.com/v1beta",
  },
} as const;

export const ROLE = {
  FACULTY: "FACULTY",
  STUDENT: "STUDENT",
} as const;
