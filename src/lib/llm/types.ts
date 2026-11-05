export interface LlmPrompt {
  /** Stable prompt identifier recorded on every grade/generation row. */
  version: string;
  /** Safety/role preamble (inline for Gemma, which historically has no
   * separation of system instructions on the Generative Language API). */
  systemPreamble: string;
  userPrompt: string;
}

export interface LlmGenerateOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  /** true when a real API key is configured (vs. offline test provider). */
  keyConfigured: boolean;
}

export interface LlmProvider {
  id: string;
  model: string;
  generate(prompt: LlmPrompt, options?: LlmGenerateOptions): Promise<LlmResult>;
}

export class LlmError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Extract a JSON object from messy model text (code fences, prose, prefixes). */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, "").trim();
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(text)) !== null) candidates.push(m[1]);
  candidates.push(text);

  for (const candidate of candidates) {
    const parsed = tryParseBalanced(candidate);
    if (parsed !== undefined) return parsed;
  }
  throw new LlmError(502, `Model did not return parsable JSON. Output began: ${text.slice(0, 200)}`);
}

function tryParseBalanced(s: string): unknown {
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
