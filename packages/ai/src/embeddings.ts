/**
 * Ollama embeddings (EMBED_MODEL, default embeddinggemma).
 *
 * Text embeddings feed `game_features.text_vec` (1024 dims). embeddinggemma
 * emits 768 dims, so the vector is zero-padded to 1024 — cosine similarity is
 * unchanged because the padded dimensions contribute nothing to the dot
 * product or the norms. If Ollama is unreachable, callers get null and should
 * keep `feed_eligible = false` rather than inventing a vector.
 */

export type EmbedOptions = {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const TEXT_VEC_DIMS = 1024;

export function padVector(vec: number[], dims: number = TEXT_VEC_DIMS): number[] {
  if (vec.length === dims) return vec;
  if (vec.length > dims) return vec.slice(0, dims);
  return [...vec, ...new Array<number>(dims - vec.length).fill(0)];
}

/** Embed one text via Ollama's `/api/embed`. Returns null when unavailable. */
export async function embedText(text: string, opts: EmbedOptions = {}): Promise<number[] | null> {
  const baseUrl = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = opts.model ?? process.env.EMBED_MODEL ?? 'embeddinggemma';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { embeddings?: number[][] };
    const vec = json.embeddings?.[0];
    if (!Array.isArray(vec) || vec.length === 0) return null;
    return padVector(vec);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** pgvector text literal: '[0.1,0.2,...]'. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}
