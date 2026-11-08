import { describe, expect, it } from 'vitest';
import { OpenAiCompatProvider, providerFromEnv } from './openai-provider';
import { extractHtmlArtifact } from './generator';

/** Build a fake fetch that replays the given chat-completion payloads. */
function fakeFetch(payloads: Array<{ content: string | null; finish_reason?: string }>) {
  let call = 0;
  const calls: unknown[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const p = payloads[Math.min(call, payloads.length - 1)]!;
    call += 1;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: p.content }, finish_reason: p.finish_reason ?? 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  return { impl, calls, get count() { return call; } };
}

const base = { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'test-model' };

describe('OpenAiCompatProvider', () => {
  it('returns the assistant content', async () => {
    const f = fakeFetch([{ content: 'hello' }]);
    const p = new OpenAiCompatProvider({ ...base, fetchImpl: f.impl });
    await expect(p.generateText('hi')).resolves.toBe('hello');
    expect(f.count).toBe(1);
  });

  it('retries with a bigger budget when the model returns null content', async () => {
    const f = fakeFetch([{ content: null }, { content: 'second try' }]);
    const p = new OpenAiCompatProvider({ ...base, fetchImpl: f.impl });
    await expect(p.generateText('hi')).resolves.toBe('second try');
    expect(f.count).toBe(2);
    const second = f.calls[1] as { max_tokens: number };
    expect(second.max_tokens).toBeGreaterThan((f.calls[0] as { max_tokens: number }).max_tokens);
  });

  it('assembles a streamed (SSE) completion', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"<html>"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"<body>streamed"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"</body></html>"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const impl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const p = new OpenAiCompatProvider({ ...base, fetchImpl: impl });
    await expect(p.generateText('hi')).resolves.toBe('<html><body>streamed</body></html>');
  });

  it('splices continuation chunks when finish_reason is length', async () => {
    const f = fakeFetch([
      { content: '<html><body>part one', finish_reason: 'length' },
      { content: '</body></html>', finish_reason: 'stop' },
    ]);
    const p = new OpenAiCompatProvider({ ...base, fetchImpl: f.impl });
    await expect(p.generateText('make a game')).resolves.toBe('<html><body>part one</body></html>');
    expect(f.count).toBe(2);
    // The continuation request must carry the partial output as assistant turn.
    const msgs = (f.calls[1] as { messages: { role: string }[] }).messages;
    expect(msgs[msgs.length - 2]?.role).toBe('assistant');
  });

  it('throws instead of returning a truncated file', async () => {
    const truncated = { content: '<html><body>x', finish_reason: 'length' };
    const f = fakeFetch([truncated, truncated, truncated, truncated, truncated]);
    const p = new OpenAiCompatProvider({ ...base, fetchImpl: f.impl });
    await expect(p.generateText('make a game')).rejects.toThrow(/truncated/);
  });

  it('surfaces provider errors with status and body', async () => {
    const impl = (async () =>
      new Response('{"error":{"message":"quota exceeded"}}', { status: 429 })) as unknown as typeof fetch;
    const p = new OpenAiCompatProvider({ ...base, fetchImpl: impl });
    await expect(p.generateText('hi')).rejects.toThrow(/429/);
  });
});

describe('providerFromEnv', () => {
  it('returns null when LLM_* is not configured', () => {
    const saved = { ...process.env };
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    expect(providerFromEnv()).toBeNull();
    Object.assign(process.env, saved);
  });
});

describe('extractHtmlArtifact', () => {
  it('unwraps a complete ```html fence', () => {
    expect(extractHtmlArtifact('chat\n```html\n<!doctype html><html></html>\n```')).toBe(
      '<!doctype html><html></html>'
    );
  });

  it('handles an unterminated fence (truncated completion)', () => {
    const out = extractHtmlArtifact("Here's the game:\n```html\n<!doctype html><html>");
    expect(out.startsWith('<!doctype html>')).toBe(true);
  });

  it('drops prose before a bare doctype', () => {
    expect(extractHtmlArtifact('Sure! Here you go:\n<!doctype html><html></html>')).toBe(
      '<!doctype html><html></html>'
    );
  });

  it('returns the raw string when no html is present (validation must reject it)', () => {
    expect(extractHtmlArtifact('  no html here  ')).toBe('no html here');
  });
});
