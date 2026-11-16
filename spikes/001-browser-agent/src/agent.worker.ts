/**
 * The agent, in a Worker, with the project files in OPFS.
 *
 * This is the spike's whole question: does Pi Agent Core run in a browser Worker,
 * talk to an OpenAI-compatible provider through a thin proxy, and execute a tool that
 * reads and writes real project files — without a Node process anywhere?
 */
import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';

type Model = Parameters<typeof streamSimple>[0];

/** Hand-built descriptor: our provider is OpenAI-compatible chat completions. */
function makeModel(): Model {
  return {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek 4.1 Flash',
    api: 'openai-completions',
    provider: 'flickbit-proxy',
    // The proxy adds the key; the token below is a placeholder it accepts.
    baseUrl: `${self.location.origin}/api/llm`,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 384000,
    maxTokens: 8192,
  } as unknown as Model;
}

async function projectDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('project', { create: true });
}

const listFiles = {
  name: 'list_project_files',
  label: 'List project files',
  description: 'List the files in the game project.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const dir = await projectDir();
    const names: string[] = [];
    for await (const [name] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) names.push(name);
    return {
      content: [{ type: 'text', text: names.length > 0 ? names.join('\n') : '(empty project)' }],
      details: { count: names.length },
    };
  },
};

const writeFile = {
  name: 'write_project_file',
  label: 'Write project file',
  description: 'Write a text file into the game project, overwriting it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File name, e.g. index.html' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute(_id: string, params: { path: string; content: string }) {
    const dir = await projectDir();
    const handle = await dir.getFileHandle(params.path, { create: true });
    const writable = await handle.createWritable();
    await writable.write(params.content);
    await writable.close();
    return {
      content: [{ type: 'text', text: `wrote ${params.path} (${params.content.length} bytes)` }],
      details: { bytes: params.content.length },
    };
  },
};

const SYSTEM = [
  'You are a game coding agent inside a browser tab.',
  'The project lives in the browser file system; use the tools, never claim you wrote something without calling write_project_file.',
  'Write one self-contained HTML file when asked. Keep it small.',
].join('\n');

self.onmessage = async (event: MessageEvent<{ prompt: string }>) => {
  const started = Date.now();
  const toolCalls: string[] = [];
  const text: string[] = [];
  let turns = 0;

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM,
      model: makeModel(),
      tools: [listFiles, writeFile],
    } as never,
    streamFn: ((model: Model, context: never, options: never) =>
      streamSimple(model, context, { ...(options as object), apiKey: 'proxy-managed' } as never)) as never,
  } as never);

  agent.subscribe((e: { type: string; [k: string]: unknown }) => {
    if (e.type === 'message_update') {
      const inner = e['assistantMessageEvent'] as { type?: string; delta?: string } | undefined;
      if (inner?.type === 'text_delta' && inner.delta) text.push(inner.delta);
    }
    if (e.type === 'tool_execution_start') {
      const name = String((e as { toolName?: string }).toolName ?? 'tool');
      toolCalls.push(name);
      self.postMessage({ type: 'event', name, at: Date.now() - started });
    }
    if (e.type === 'agent_end') turns += 1;
  });

  try {
    await agent.prompt(event.data.prompt);
    const dir = await projectDir();
    const files: string[] = [];
    for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemFileHandle]>) {
      const file = await handle.getFile();
      files.push(`${name} (${file.size} bytes)`);
    }
    self.postMessage({
      type: 'done',
      ok: true,
      ms: Date.now() - started,
      toolCalls,
      turns,
      files,
      reply: text.join('').slice(0, 400),
    });
  } catch (err) {
    self.postMessage({
      type: 'done',
      ok: false,
      ms: Date.now() - started,
      toolCalls,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
};
