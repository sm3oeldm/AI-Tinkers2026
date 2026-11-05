// LLM provider factory. "google" requires GOOGLE_AI_API_KEY (no silent key
// fallback); anything else is the deterministic offline test provider whose
// rows label themselves as test-offline-deterministic.

import { config } from "../config";
import { GoogleProvider } from "./google";
import { TestProvider, getTestProvider } from "./test-provider";
import { LlmError, LlmProvider } from "./types";

export function getProvider(): LlmProvider {
  const provider = config.llm.provider;
  if (provider === "google") {
    if (!config.llm.googleApiKey) {
      throw new LlmError(500, "LLM_PROVIDER=google but GOOGLE_AI_API_KEY is empty. Add the AI Studio key or set LLM_PROVIDER=test.");
    }
    return new GoogleProvider(config.llm.model);
  }
  return getTestProvider();
}

export function providerDescription(): { provider: string; model: string; keyConfigured: boolean } {
  const provider = config.llm.provider;
  return provider === "google"
    ? { provider: "google", model: config.llm.model, keyConfigured: Boolean(config.llm.googleApiKey) }
    : { provider: "test", model: "test-offline-deterministic", keyConfigured: false };
}

export * from "./types";
