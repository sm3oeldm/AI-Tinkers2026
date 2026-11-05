// Official Google Generative Language API client (AI Studio key).
//
// Gemma models served by this API historically do not support system
// instructions or native JSON mode, so all instructions — safety preamble,
// JSON contract — are carried inside the user turn by the prompt registry.
// If the served model is a Gemini-family model (which support system
// instructions), we use the dedicated systemInstruction field instead.

import { config } from "../config";
import { LlmError, LlmPrompt, LlmProvider, LlmResult } from "./types";

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export class GoogleProvider implements LlmProvider {
  readonly id = "google";
  readonly model: string;
  readonly keyConfigured = true;

  constructor(model: string) {
    this.model = model;
  }

  async generate(prompt: LlmPrompt, options?: { temperature?: number; maxOutputTokens?: number }): Promise<LlmResult> {
    const isGemma = /^gemma/i.test(this.model);
    const body: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: isGemma
            ? [{ text: `${prompt.systemPreamble}\n\n${prompt.userPrompt}` }]
            : [{ text: prompt.userPrompt }],
        },
      ],
      generationConfig: {
        temperature: options?.temperature ?? 0.2,
        maxOutputTokens: options?.maxOutputTokens ?? 8192,
        responseMimeType: isGemma ? undefined : "application/json",
      },
    };
    if (!isGemma) body.systemInstruction = { parts: [{ text: prompt.systemPreamble }] };

    let res: Response;
    try {
      res = await fetch(`${config.llm.apiBase}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.llm.googleApiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new LlmError(502, `Could not reach ${this.providerName()}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let hint = "";
      if (res.status === 404) {
        hint = ` The model id "${this.model}" was not found — set GEMMA_MODEL to the exact model name served for your API key (see the model list at your AI Studio).`;
      }
      throw new LlmError(502, `${this.providerName()} error ${res.status}: ${detail.slice(0, 300)}.${hint}`);
    }

    const data = (await res.json().catch(() => null)) as GenerateContentResponse | null;
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) {
      const reason = data?.promptFeedback?.blockReason;
      throw new LlmError(502, reason ? `${this.providerName()} blocked the request (${reason}).` : `${this.providerName()} returned an empty response.`);
    }
    return { text, provider: this.id, model: this.model, keyConfigured: true };
  }

  private providerName(): string {
    return `Google ${this.model}`;
  }
}
