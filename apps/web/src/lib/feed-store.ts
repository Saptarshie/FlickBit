import { create } from 'zustand';

/**
 * Feed/session UI state (Zustand). Server state (the feed page itself) lives
 * in TanStack Query; everything transient about the viewing session is here.
 */
export type FeedState = {
  /** Index of the card currently snapped into view. */
  activeIndex: number;
  /** Whether the active game should be running (Space toggles on desktop). */
  isPlaying: boolean;
  /** Global mute toggle (M on desktop); persists across cards. */
  muted: boolean;
  /** Total number of cards in the feed (set by FeedScreen when data arrives). */
  itemCount: number;
  /** True once the user tapped at least once (audio unlock gesture). */
  audioUnlocked: boolean;
  /**
   * Id of the card whose game currently owns touch input ("engaged"). While a
   * card is engaged every pointer event is replayed inside the game and the
   * feed does not scroll from the play area; scrolling resumes from the rail,
   * wheel, keyboard, or by leaving play mode (✕ / Esc). Null = browse mode.
   */
  engagedGameId: string | null;
  /** Registered by FeedScreen so keyboard/Next can scroll the snap container. */
  scrollToIndex: ((index: number) => void) | null;

  setActiveIndex: (index: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setMuted: (muted: boolean) => void;
  toggleMuted: () => void;
  setItemCount: (count: number) => void;
  unlockAudio: () => void;
  setEngaged: (gameId: string | null) => void;
  registerScrollToIndex: (fn: ((index: number) => void) | null) => void;
};

export const useFeedStore = create<FeedState>((set) => ({
  activeIndex: 0,
  isPlaying: true,
  muted: false,
  itemCount: 0,
  audioUnlocked: false,
  engagedGameId: null,
  scrollToIndex: null,

  setActiveIndex: (index) => set({ activeIndex: index }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  togglePlaying: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setMuted: (muted) => set({ muted }),
  toggleMuted: () => set((s) => ({ muted: !s.muted })),
  setItemCount: (count) => set({ itemCount: count }),
  unlockAudio: () => set({ audioUnlocked: true }),
  setEngaged: (gameId) => set({ engagedGameId: gameId }),
  registerScrollToIndex: (fn) => set({ scrollToIndex: fn }),
}));
