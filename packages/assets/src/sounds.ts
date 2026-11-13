/**
 * Synthesised sound effects for the starter pack.
 *
 * No licensing question, no download, and tiny: these are generated as 16-bit
 * WAV at 44.1 kHz and then encoded to Opus by the ingest step (a 250 ms blip
 * lands around 3–5 KB). They are deliberately simple — a game that wants a
 * soundtrack can synthesise one with WebAudio.
 */

export type StarterSound = {
  id: string;
  name: string;
  tags: string[];
  /** Seconds. */
  durationMs: number;
  /** Amplitude envelope + waveform description, rendered by `renderSound`. */
  render: (samples: Float32Array, sampleRate: number) => void;
};

const SR = 44100;

function env(t: number, attack: number, decay: number): number {
  if (t < attack) return t / attack;
  return Math.max(0, 1 - (t - attack) / decay);
}

function tone(samples: Float32Array, from: number, to: number, gain: number, kind: 'sine' | 'square' | 'saw' = 'sine'): void {
  let phase = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const p = i / samples.length;
    const freq = from + (to - from) * p;
    phase += (2 * Math.PI * freq) / SR;
    const wave = kind === 'sine' ? Math.sin(phase) : kind === 'square' ? Math.sign(Math.sin(phase)) : ((phase / Math.PI) % 2) - 1;
    samples[i] = (samples[i] ?? 0) + wave * gain * env(p, 0.02, 0.98);
  }
}

function noise(samples: Float32Array, gain: number, decayPower: number): void {
  let seed = 1337;
  for (let i = 0; i < samples.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = (seed / 0x7fffffff) * 2 - 1;
    const p = i / samples.length;
    samples[i] = (samples[i] ?? 0) + r * gain * Math.pow(1 - p, decayPower);
  }
}

export function starterSounds(): StarterSound[] {
  return [
    {
      id: 'sfx_jump',
      name: 'Jump',
      tags: ['sfx', 'jump', 'platformer'],
      durationMs: 220,
      render: (s) => tone(s, 320, 720, 0.5, 'square'),
    },
    {
      id: 'sfx_coin',
      name: 'Coin',
      tags: ['sfx', 'pickup', 'currency'],
      durationMs: 180,
      render: (s) => {
        const half = Math.floor(s.length / 2);
        tone(s.subarray(0, half), 880, 880, 0.45, 'sine');
        tone(s.subarray(half), 1320, 1320, 0.4, 'sine');
      },
    },
    {
      id: 'sfx_hit',
      name: 'Hit',
      tags: ['sfx', 'damage', 'impact'],
      durationMs: 200,
      render: (s) => {
        noise(s, 0.5, 3);
        tone(s, 180, 60, 0.35, 'square');
      },
    },
    {
      id: 'sfx_explode',
      name: 'Explosion',
      tags: ['sfx', 'explosion', 'boom'],
      durationMs: 450,
      render: (s) => {
        noise(s, 0.7, 1.6);
        tone(s, 120, 40, 0.3, 'saw');
      },
    },
    {
      id: 'sfx_powerup',
      name: 'Power Up',
      tags: ['sfx', 'powerup', 'reward'],
      durationMs: 380,
      render: (s) => {
        const third = Math.floor(s.length / 3);
        tone(s.subarray(0, third), 440, 660, 0.35, 'sine');
        tone(s.subarray(third, third * 2), 660, 880, 0.35, 'sine');
        tone(s.subarray(third * 2), 880, 1320, 0.35, 'sine');
      },
    },
    {
      id: 'sfx_click',
      name: 'Click',
      tags: ['sfx', 'ui', 'click'],
      durationMs: 90,
      render: (s) => tone(s, 1400, 900, 0.25, 'square'),
    },
  ];
}

/** 16-bit mono WAV — the format FFmpeg is happiest to consume. */
export function renderSound(sound: StarterSound): Buffer {
  const length = Math.max(1, Math.round((sound.durationMs / 1000) * SR));
  const samples = new Float32Array(length);
  sound.render(samples, SR);

  const data = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.byteLength, 40);

  return Buffer.concat([header, data]);
}
