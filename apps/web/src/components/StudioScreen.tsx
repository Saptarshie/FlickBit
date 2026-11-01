'use client';

import { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

const TEMPLATES = [
  { id: 'tap-runner', name: '🏃 Runner' },
  { id: 'flappy', name: '🪶 Flappy' },
  { id: 'snake', name: '🐍 Snake' },
  { id: 'brick-breaker', name: '🧱 Bricks' },
  { id: 'match-3', name: '💎 Match-3' },
  { id: 'shooter', name: '🚀 Shooter' },
  { id: 'physics-toss', name: '🎯 Toss' },
];

export function StudioScreen() {
  const [prompt, setPrompt] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('tap-runner');
  const [isGenerating, setIsGenerating] = useState(false);
  const [progressStage, setProgressStage] = useState<string>('');
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [artifactUrl, setArtifactUrl] = useState<string | null>(null);
  const [gameTitle, setGameTitle] = useState('My Vibecoded Game');
  const [gameTags, setGameTags] = useState('arcade, casual');
  const [publishedGameId, setPublishedGameId] = useState<string | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishSaved, setPublishSaved] = useState(false);

  // Remix: /studio?remix=<gameId> prefills the generation with the base code.
  const searchParams = useSearchParams();
  const remixId = searchParams.get('remix');
  const [remixBaseCode, setRemixBaseCode] = useState<string | null>(null);
  const [remixSourceTitle, setRemixSourceTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!remixId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/games/${remixId}/source`);
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) {
          setRemixBaseCode(body.data.code);
          setRemixSourceTitle(body.data.game.title);
          setPrompt((p) => (p.trim() ? p : `Remix of ${body.data.game.title}: `));
        }
      } catch {
        // Non-fatal: user can still vibecode from scratch.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [remixId]);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handleGenerate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || isGenerating) return;

    setIsGenerating(true);
    setProgressStage('spec');
    setProgressMsg('Planning game concept...');
    setProgressPercent(10);
    setPublishedGameId(null);

    try {
      const response = await fetch('/api/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          templateId: selectedTemplate,
          ...(remixId && remixBaseCode
            ? { forkedFromId: remixId, baseCode: remixBaseCode, isRemix: true }
            : {}),
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to start generation');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const block of lines) {
          const eventMatch = block.match(/^event:\s*(.+)$/m);
          const dataMatch = block.match(/^data:\s*(.+)$/m);
          if (!dataMatch) continue;

          const eventType = eventMatch?.[1]?.trim() ?? 'message';
          const rawData = dataMatch[1]?.trim();
          if (!rawData) continue;
          const data = JSON.parse(rawData);

          if (eventType === 'progress') {
            setProgressStage(data.stage);
            setProgressMsg(data.message);
            setProgressPercent(data.progressPercent);
          } else if (eventType === 'complete') {
            setArtifactUrl(data.artifactUrl);
            setGameTitle(data.metadata.title);
            setGameTags(data.metadata.tags.join(', '));
            setPublishedGameId(data.gameId);
            setProgressStage('done');
            setProgressMsg('Game is ready to play!');
            setProgressPercent(100);
          } else if (eventType === 'error') {
            throw new Error(data.message || 'Generation error');
          }
        }
      }
    } catch (err: any) {
      setProgressMsg(`Error: ${err.message}`);
      setProgressStage('failed');
    } finally {
      setIsGenerating(false);
    }
  };

  const restartGame = () => {
    if (iframeRef.current && artifactUrl) {
      iframeRef.current.src = artifactUrl;
      setIsPaused(false);
    }
  };

  const saveGameDetails = async () => {
    if (!publishedGameId || publishBusy) return;
    setPublishBusy(true);
    setPublishSaved(false);
    try {
      const res = await fetch(`/api/games/${publishedGameId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: gameTitle.trim() || undefined,
          tags: gameTags.split(',').map((t) => t.trim()).filter(Boolean),
        }),
      });
      setPublishSaved(res.ok);
    } catch {
      setPublishSaved(false);
    } finally {
      setPublishBusy(false);
    }
  };

  const togglePause = () => {
    if (iframeRef.current?.contentWindow) {
      const nextPaused = !isPaused;
      iframeRef.current.contentWindow.postMessage({
        src: 'playloop',
        type: nextPaused ? 'pause' : 'resume',
      }, '*');
      setIsPaused(nextPaused);
    }
  };

  return (
    <main className="relative w-full h-[100dvh] bg-black text-white flex flex-col items-center justify-center overflow-hidden select-none">
      {/* Centered 9:16 mobile container */}
      <div className="relative w-full max-w-[480px] h-full flex flex-col bg-neutral-950 shadow-2xl">
        {/* Top App Bar */}
        <header className="flex items-center justify-between px-4 py-3 bg-neutral-900/80 backdrop-blur border-b border-neutral-800 z-20">
          <div className="flex items-center gap-2">
            <Link href="/" className="text-neutral-400 hover:text-white text-lg p-1">
              ←
            </Link>
            <h1 className="text-base font-bold bg-gradient-to-r from-indigo-400 via-pink-400 to-amber-300 bg-clip-text text-transparent">
              Vibecode Studio
            </h1>
          </div>
          {artifactUrl && (
            <button
              onClick={() => setShowPublishModal(true)}
              className="px-3 py-1.5 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 text-xs font-semibold hover:opacity-90 transition"
            >
              🚀 Published
            </button>
          )}
        </header>

        {/* Preview / Canvas Stage */}
        <div className="relative flex-1 bg-neutral-900 overflow-hidden flex items-center justify-center">
          {artifactUrl ? (
            <>
              <iframe
                ref={iframeRef}
                src={artifactUrl}
                sandbox="allow-scripts"
                title="Game Preview"
                className="w-full h-full border-0"
              />
              {/* Floating controls */}
              <div className="absolute top-3 right-3 flex flex-col gap-2 z-10">
                <button
                  onClick={restartGame}
                  className="w-10 h-10 rounded-full bg-neutral-900/80 backdrop-blur border border-neutral-700 flex items-center justify-center text-sm shadow hover:bg-neutral-800"
                  title="Restart"
                >
                  🔄
                </button>
                <button
                  onClick={togglePause}
                  className="w-10 h-10 rounded-full bg-neutral-900/80 backdrop-blur border border-neutral-700 flex items-center justify-center text-sm shadow hover:bg-neutral-800"
                  title={isPaused ? 'Resume' : 'Pause'}
                >
                  {isPaused ? '▶️' : '⏸️'}
                </button>
              </div>
            </>
          ) : (
            <div className="p-6 text-center max-w-xs">
              <div className="text-4xl mb-3">✨</div>
              <h2 className="text-lg font-semibold mb-1">Vibecode Any Game</h2>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Type an idea below. AI plans the mechanics, generates the canvas code, runs security checks, and loads it instantly.
              </p>
            </div>
          )}

          {/* Progress Overlay during Generation */}
          {isGenerating && (
            <div className="absolute inset-0 bg-neutral-950/80 backdrop-blur-sm flex flex-col items-center justify-center p-6 z-30">
              <div className="w-12 h-12 rounded-full border-4 border-indigo-500/20 border-t-indigo-500 animate-spin mb-4" />
              <div className="text-sm font-semibold capitalize mb-1 text-indigo-300">
                {progressStage}...
              </div>
              <p className="text-xs text-neutral-400 text-center mb-4 max-w-xs">
                {progressMsg}
              </p>
              <div className="w-48 h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-pink-500 transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Bottom Vibecoding Console / Drawer */}
        <div className="bg-neutral-900/90 backdrop-blur border-t border-neutral-800 p-4 z-20">
          {/* Template chips */}
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none text-xs">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedTemplate(t.id)}
                className={`px-2.5 py-1 rounded-full whitespace-nowrap transition-colors ${
                  selectedTemplate === t.id
                    ? 'bg-indigo-600 text-white font-medium'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                {t.name}
              </button>
            ))}
          </div>

          {/* Prompt input form */}
          <form onSubmit={handleGenerate} className="mt-2 flex gap-2">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Cyberpunk flappy bird with lasers..."
              disabled={isGenerating}
              className="flex-1 bg-neutral-800 border border-neutral-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={isGenerating || !prompt.trim()}
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-pink-500 text-sm font-semibold hover:opacity-95 active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGenerating ? '...' : '✨ Vibe'}
            </button>
          </form>
        </div>
      </div>

      {/* Publish / Share Modal */}
      {showPublishModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-2xl p-5 shadow-2xl">
            <h3 className="text-lg font-bold mb-1">Game Published!</h3>
            <p className="text-xs text-neutral-400 mb-4">
              Your game artifact is verified, sandboxed, and ready in the vertical Reels feed.
            </p>
            <div className="space-y-3 text-sm">
              <div>
                <label className="text-xs text-neutral-400 block mb-1">Title</label>
                <input
                  type="text"
                  value={gameTitle}
                  onChange={(e) => setGameTitle(e.target.value)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="text-xs text-neutral-400 block mb-1">Tags</label>
                <input
                  type="text"
                  value={gameTags}
                  onChange={(e) => setGameTags(e.target.value)}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button
                type="button"
                onClick={saveGameDetails}
                disabled={publishBusy}
                className="flex-1 py-2 rounded-xl bg-neutral-800 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
              >
                {publishBusy ? 'Saving…' : publishSaved ? '✓ Saved' : 'Save details'}
              </button>
              <Link
                href="/"
                className="flex-1 py-2 rounded-xl bg-gradient-to-r from-pink-500 to-purple-600 text-sm font-medium text-center hover:opacity-95"
              >
                View in Feed
              </Link>
            </div>
            {remixSourceTitle ? (
              <p className="text-[11px] text-neutral-500 mt-3 text-center">
                🔁 This game is a remix of “{remixSourceTitle}”
              </p>
            ) : null}
          </div>
        </div>
      )}
    </main>
  );
}
