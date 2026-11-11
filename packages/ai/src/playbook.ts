/**
 * Gamedev playbook — distilled, opinionated rules the agents are told to follow.
 *
 * Sourced from commonly cited game-feel/perf practice (the "juice" literature:
 * trauma-based screen shake, hit-stop, squash & stretch, input buffering/coyote
 * time, importance-tiered feedback) and mobile canvas guidance. Kept as data
 * rather than prose in prompts so the designer, coder and reviewer all read the
 * same rules instead of three drifting copies.
 */

export const GAME_FEEL_RULES = `FEEDBACK IS LAYERED AND PROPORTIONAL
- One satisfying event fires 4-6 cheap things within ~100 ms (sound, particles,
  flash, small shake, number pop). Each is cheap; stacked they read as impact.
- Scale to importance in three tiers and never spend a large effect on a routine
  action:
    small  (pickup, tap): tick sound + 4-6 particles
    medium (hit, land)  : sound + 8-12 particles + 60ms hit-stop + trauma 0.35
    large  (death, boss): boom + 25-40 particles + 100-140ms hit-stop + trauma 0.8 + flash
- Juice is TRANSIENT: it must return to rest. A permanent scale offset or a
  shake that never decays becomes the new normal and stops reading.

SCREEN SHAKE BY TRAUMA (never random jitter per frame)
- Keep trauma 0..1; events ADD trauma (clamped), it decays ~1.2/s.
- offset = maxOffset * trauma^2 * sin(t * k) with two different frequencies per
  axis. Shake the CAMERA/visual transform only, never the simulated position.
- Random offsets per frame buzz like static and desync collision.

HIT-STOP
- Freeze by scaling simulation time (or skipping updates), restore with a
  REAL-TIME timer (~60-140 ms). Never gate restore on scaled time.
- Only the newest hit-stop may restore. Never trigger per frame during a held input.

MOTION
- Ease everything: ease-out for settles, overshoot (back/elastic) for pops.
  Linear motion reads as robotic.
- Squash & stretch on jump/land (stretch 0.85/1.2, settle back over ~140 ms).

RESPONSIVENESS
- Input must be acknowledged in the same frame it arrives (visual or audio).
- Buffer the jump/tap for ~120 ms before it is legal (input buffering) and allow
  it ~100 ms after leaving a ledge (coyote time).
- Never block input during feedback longer than ~150 ms.`;

export const MOBILE_RULES = `MOBILE ERGONOMICS (portrait 390x844 is the target)
- One finger, one thumb. Primary control lives in the bottom 40% of the screen.
- Every touch target is at least 48x48 CSS px with 8px spacing.
- Never require hover, right-click, multi-touch chords, or precise pixel taps.
- Keep HUD clear of window.PlayLoop.safeArea (top notch, bottom home bar) and of
  the bottom ~96px where the app's navigation rail sits.
- The whole screen is a valid input surface: a tap anywhere in the play area must
  do the primary action (players tap where they look, not on a button).
- Pause on tab blur, resume on focus, and re-arm audio on the next gesture.`;

export const PERFORMANCE_RULES = `PERFORMANCE BUDGET (mid-range phone, 60 fps)
- Allocate nothing inside the frame loop: pre-allocate particle pools and reuse
  objects; update particle arrays backwards when removing.
- Cap live particles (~150). Prefer pooled circles/rects over gradients created
  per frame — gradient creation is the single biggest per-frame cost.
- Cache the background: draw static scenery once into an offscreen canvas and
  blit it each frame.
- Clamp dt to 0.05 s and use it for every movement; never assume 16.7 ms.
- Cap devicePixelRatio at 2. Avoid shadowBlur/globalCompositeOperation in loops.
- Never let one bad value kill the frame: every radius passed to arc/ellipse/
  createRadialGradient must be finite and >= 0 (guard with Math.max(0, x) and
  Number.isFinite checks). A NaN freezes the entire game.
- Target under 300 KB of HTML and under ~900 lines.`;

export const QUALITY_BAR = `SHIP BAR
- Start screen with title, one-line how-to, best score, "TAP TO START".
- The simulation does not advance until the player's first input.
- HUD: score always; lives/timer only when the design needs them; best score.
- In-canvas game over: final score, best score, "NEW BEST" celebration, restart
  that does not reload the page.
- Audio: one AudioContext created on the first gesture, 4-6 short SFX, master
  gain, respects pause.
- Difficulty ramps with score and is survivable at t=0 (no unfair first second).
- Deterministic: same inputs produce the same run (seeded RNG from PlayLoop.rng).
- No console errors for a 60-second session of random input.`;

export const PLAYBOOK = [GAME_FEEL_RULES, MOBILE_RULES, PERFORMANCE_RULES, QUALITY_BAR].join('\n\n');
