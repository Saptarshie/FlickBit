/**
 * Main thread: start the agent worker, show what it does, and expose the result on
 * `window.__spike` so a headless driver can read it without parsing the DOM.
 */

export type SpikeResult = {
  done: boolean;
  ok: boolean | null;
  ms: number;
  toolCalls: string[];
  files: string[];
  reply: string;
  error: string | null;
};

declare global {
  interface Window {
    __spike: SpikeResult;
  }
}

const log = document.getElementById('log') as HTMLDivElement;
const status = document.getElementById('status') as HTMLSpanElement;
const preview = document.getElementById('preview') as HTMLIFrameElement;

window.__spike = { done: false, ok: null, ms: 0, toolCalls: [], files: [], reply: '', error: null };

function line(text: string, cls = ''): void {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

const PROMPT =
  'Call list_project_files to see what exists. Then write index.html: a single file, ' +
  'tap-to-jump game on a canvas, 30 lines or fewer of JavaScript, and a visible "TAP TO JUMP" label. ' +
  'Then call list_project_files once more to confirm the file is there, and reply with one sentence.';

const worker = new Worker(new URL('./agent.worker.ts', import.meta.url), { type: 'module' });

worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
  const msg = event.data;
  if (msg['type'] === 'event') {
    line(`→ tool: ${String(msg['name'])}  (${String(msg['at'])} ms)`);
    window.__spike.toolCalls.push(String(msg['name']));
    return;
  }
  if (msg['type'] === 'done') {
    const ok = Boolean(msg['ok']);
    window.__spike = {
      done: true,
      ok,
      ms: Number(msg['ms'] ?? 0),
      toolCalls: (msg['toolCalls'] as string[]) ?? [],
      files: (msg['files'] as string[]) ?? [],
      reply: String(msg['reply'] ?? ''),
      error: (msg['error'] as string | null) ?? null,
    };
    status.textContent = ok ? `done in ${window.__spike.ms} ms` : `failed after ${window.__spike.ms} ms`;
    status.className = ok ? 'ok' : 'bad';
    line('', '');
    line(ok ? '✓ agent finished' : `✗ ${window.__spike.error}`, ok ? 'ok' : 'bad');
    if (window.__spike.files.length) line(`files: ${window.__spike.files.join(', ')}`, 'dim');
    if (window.__spike.reply) line(`reply: ${window.__spike.reply}`, 'dim');
  }
};

worker.onerror = (event) => {
  window.__spike = { done: true, ok: false, ms: 0, toolCalls: [], files: [], reply: '', error: event.message };
  status.textContent = 'worker crashed';
  status.className = 'bad';
  line(`✗ worker error: ${event.message}`, 'bad');
};

line(`prompt: ${PROMPT.slice(0, 90)}…`, 'dim');
line('', '');
worker.postMessage({ prompt: PROMPT });

// Once the agent reports a file, show it: the same bytes a creator would see.
const poll = window.setInterval(async () => {
  if (!window.__spike.done) return;
  window.clearInterval(poll);
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('project');
    const handle = await dir.getFileHandle('index.html');
    const file = await handle.getFile();
    const html = await file.text();
    preview.srcdoc = html;
    line(`preview: ${(html.length / 1024).toFixed(1)} KB of html in the iframe`, 'dim');
  } catch {
    line('preview: no index.html in the project', 'dim');
  }
}, 500);
