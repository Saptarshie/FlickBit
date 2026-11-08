import type { AiProvider } from './types';

/**
 * OpenAI-compatible chat-completions provider.
 *
 * Works with any `/chat/completions` endpoint: Command Code (`LLM_BASE_URL`),
 * OpenAI, OpenRouter, vLLM, LM Studio, ... Configure with:
 *   LLM_BASE_URL   e.g. https://api.commandcode.ai/provider/v1  (no trailing /)
 *   LLM_API_KEY    bearer token
 *   LLM_MODEL      e.g. deepseek/deepseek-v4.1-flash
 *
 * Reasoning models (deepseek, qwen, o1-style) return their chain-of-thought in
 * `reasoning_content` and the answer in `content`; `content` can be null when
 * `max_tokens` is exhausted by reasoning, so we retry once with a bigger budget
 * and surface a clear error rather than returning an empty game.
 *
 * Long artifacts (a 20 KB game file) can hit the completion budget mid-file.
 * When that happens (`finish_reason: "length"`) we ask the model to continue
 * exactly where it stopped and splice the parts, instead of publishing a
 * half-written file.
 */

export type OpenAiCompatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Default completion budget per call. */
  maxTokens?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ChatResponse = {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }[];
  error?: { message?: string; code?: string };
};

export class OpenAiCompatProvider implements AiProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generateText(
    prompt: string,
    options: { systemPrompt?: string; temperature?: number } = {}
  ): Promise<string> {
    const messages: ChatMessage[] = [];
    if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
    messages.push({ role: 'user', content: prompt });

    let result = await this.complete(messages, options.temperature, this.maxTokens);
    if (result.content.trim().length === 0) {
      // Reasoning models can spend the whole budget thinking. Retry once bigger.
      result = await this.complete(messages, options.temperature, Math.min(this.maxTokens * 2, 64_000));
    }
    if (result.content.trim().length === 0) {
      throw new Error(
        `LLM returned empty content (model=${this.model}). ` +
          'The model may have spent the whole budget on reasoning output.'
      );
    }

    // Truncated mid-file: ask for the continuation and splice it on.
    let full = result.content;
    for (let i = 0; i < 3 && result.finishReason === 'length'; i += 1) {
      const continuation = await this.complete(
        [
          ...messages,
          { role: 'assistant', content: full },
          {
            role: 'user',
            content:
              'The file above was cut off. Continue EXACTLY where it stopped, from the next character on. ' +
              'Output only the remaining raw text (no fences, no commentary, do not repeat anything already written).',
          },
        ],
        options.temperature,
        this.maxTokens
      );
      if (continuation.content.trim().length === 0) break;
      full += continuation.content;
      result = continuation;
      if (continuation.finishReason === 'stop') break;
    }

    if (result.finishReason === 'length') {
      throw new Error(
        `LLM output still truncated after continuations (model=${this.model}). ` +
          'The requested artifact is too large for one completion; lower the scope or raise max_tokens.'
      );
    }
    return full;
  }

  private async complete(
    messages: ChatMessage[],
    temperature: number | undefined,
    maxTokens: number
  ): Promise<{ content: string; finishReason: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          ...(temperature === undefined ? {} : { temperature }),
        }),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 400)}`);
      }

      let json: ChatResponse;
      try {
        json = JSON.parse(text) as ChatResponse;
      } catch {
        throw new Error(`LLM returned non-JSON response: ${text.slice(0, 300)}`);
      }
      if (json.error?.message) throw new Error(`LLM error: ${json.error.message}`);

      const choice = json.choices?.[0];
      return {
        content: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? 'stop',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build a provider from LLM_* env vars, or null when they are not configured. */
export function providerFromEnv(): AiProvider | null {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return new OpenAiCompatProvider({ baseUrl, apiKey, model });
}
