// Text utilities: normalization for comparisons, evidence-quote verification
// against student answers, and duplicate question detection.

const WS = /\s+/g;

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(WS, " ")
    .trim();
}

export function tokenize(s: string): string[] {
  const n = normalizeText(s);
  return n ? n.split(" ") : [];
}

export type QuoteVerification =
  | { found: true; method: "exact" | "word-sequence" | "fuzzy"; score: number }
  | { found: false; method: "not-found"; score: number };

/**
 * Verify that an evidence quote supplied by the grading model actually appears
 * in the student's answer. Mirrors spec rule: "Verify evidence quotations
 * against the original submission. Flag unsupported justifications."
 * Covers reflowed whitespace/punctuation (exact), reworded punctuation and
 * split lines (word-sequence), and small reflows (fuzzy bigram recall).
 */
export function verifyQuote(quote: string, answer: string): QuoteVerification {
  const q = normalizeText(quote);
  const a = normalizeText(answer);
  if (!q || !a) return { found: false, method: "not-found", score: 0 };
  if (a.includes(q)) return { found: true, method: "exact", score: 1 };

  const qTokens = q.split(" ");
  const aTokens = a.split(" ");
  if (qTokens.length === 0) return { found: false, method: "not-found", score: 0 };

  // exact word sequence containment ("labeled training data appears as words")
  if (containsWordSequence(aTokens, qTokens)) {
    return { found: true, method: "word-sequence", score: 0.99 };
  }

  // fuzzy: proportion of the quote's word bigrams present in the answer
  const recall = bigramRecall(qTokens, aTokens);
  const plausible = (qTokens.length <= 3 && recall >= 0.66) || (qTokens.length <= 8 && recall >= 0.8) || recall >= 0.9;
  if (plausible) return { found: true, method: "fuzzy", score: recall };
  return { found: false, method: "not-found", score: recall };
}

function containsWordSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(tokens[i] + " " + tokens[i + 1]);
  return out;
}

function bigramRecall(quoteTokens: string[], answerTokens: string[]): number {
  const qb = bigrams(quoteTokens);
  if (qb.length === 0) return containsWordSequableSingle(quoteTokens, answerTokens) ? 1 : 0;
  const ab = new Set(bigrams(answerTokens));
  let matched = 0;
  for (const b of qb) if (ab.has(b)) matched++;
  return matched / qb.length;
}

function containsWordSequableSingle(quoteTokens: string[], answerTokens: string[]): boolean {
  if (quoteTokens.length !== 1) return false;
  return answerTokens.includes(quoteTokens[0]);
}

export type DuplicateCheck = { duplicate: boolean; similarity: number };

/** Duplicate question detection: normalized token-set similarity + shared rare
 * word-unigram / 4-gram heuristics, tuned so reworded duplicates are caught
 * while legitimately distinct questions about the same topic stay separate. */
export function questionDuplicateScore(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const minLen = Math.min(ta.length, tb.length);
  const longEnough = minLen >= 6;

  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const jaccard = inter / (sa.size + sb.size - inter);

  let fourGram = 0;
  if (longEnough) {
    const fa = new Set(ngrams(ta, 4));
    const fb = new Set(ngrams(tb, 4));
    let both = 0;
    for (const g of fa) if (fb.has(g)) both++;
    fourGram = both / fa.size;
  }

  const sequenceSimilarity = containsWordSequence(ta, tb)
    ? 1
    : fourGram;
  return Math.max(jaccard * (longEnough ? 1 : 0.85), sequenceSimilarity * 0.95);
}

function normalizeStringTokens(t: string[]): string[][] {
  return t.map((_, i) => t.slice(i, i + 4));
}

function ngrams(tokens: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
