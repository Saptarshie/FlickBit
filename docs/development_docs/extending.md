# Extending PlayLoop

Each recipe lists every file you must touch. Skipping one is how "it works
locally but the card is blank" happens.

## Add a screen

1. `apps/web/src/components/<Name>Screen.tsx` — `'use client'`, import
   `BottomNav`/`TopBar` from `./AppNav`, respect the chrome paddings:
   `paddingTop: calc(48px + env(safe-area-inset-top))`,
   `paddingBottom: calc(56px + env(safe-area-inset-bottom))`.
2. `apps/web/app/<route>/page.tsx` — a thin wrapper; use `<Suspense>` around any
   component that calls `useSearchParams` (Next 15 requirement, or the build
   fails).
3. Add a nav entry in `AppNav.tsx` if it is a top-level destination (max five).
4. If it fetches, add a route handler under `app/api/…` wrapped with `wrap()` and
   export the method (`export const GET = wrap(async (req) => …)`, never
   `return wrap(...)`).
5. Test the handler in `apps/web/test/api.test.ts`.

## Add an API route

```ts
import { wrap, jsonOk, jsonError, requireUser } from '@/lib/api-helpers';

export const POST = wrap<{ id: string }>(async (req, ctx) => {
  const userId = await requireUser(req);       // 401s on its own
  const { id } = await ctx.params;             // params is a promise
  if (!id) return jsonError('bad_request', 'missing id', 400);
  return jsonOk({ ok: true });
});
```

- `getDb()` for the pooled client; never construct a new `postgres()`.
- Filter soft-deleted games (`isNull(games.deletedAt)`).
- Return the standard envelope `{ data }` / `{ error: { code, message } }`.

## Add a game archetype

1. `packages/gamekit/src/templates/<id>.ts` — a complete, self-contained game
   that validates (`pnpm --filter @playloop/gamekit run test` covers all
   templates).
2. Register it in `packages/gamekit/src/templates/index.ts`.
3. Add the archetype to `packages/ai/src/prompts.ts` (planner vocabulary) so the
   planner can choose it.
4. Re-run `pnpm --filter @playloop/db run db:seed` to publish the template.

## Add an SDK capability

Guest→host (telemetry):

1. Add the type to `GuestToHost` in `packages/sdk/src/protocol.ts` (and to
   `GUEST_TYPES`, or it is rejected).
2. Emit it from the shim (`api.<name>`), and handle it in `GameHost.dispatch`.
3. Surface it in `GameCardView`'s `onMessage`.

Host→guest (control):

1. Add to `HostToGuest` in `protocol.ts`.
2. Add a `GameHost` method that calls `this.post('…', payload)`.
3. Handle it in `shim-source.ts`'s message switch.
4. **Remember the traps:** the shim validates by origin, not `event.source`; and
   anything that pauses must respect the first-frame rule.

## Change the comment/like/save UI

The rail buttons live in `GameCardView`; the sheet in `CommentsSheet`. Both use
TanStack Query with `queryKey: ['game', id, …]`. After a mutation, either
`invalidateQueries` that key or write an optimistic update **and** roll it back in
`onError`. Never mutate local state without a server confirmation path.

## Change styling

- The feed and screens use inline styles (design-system-in-a-file).
- The **studio** uses Tailwind v4 (`apps/web/app/globals.css`,
  `postcss.config.mjs`). Adding a Tailwind class elsewhere works, but keep new
  screens consistent with their neighbours.
- Use the `var(--…)` tokens only inside chat widgets; the app itself is dark by
  design (`#0b0b10`).

## Add a database table

See [data-model.md](./data-model.md#adding-a-column-or-table).

## Checklist before you commit

- [ ] `pnpm run typecheck` clean
- [ ] affected package tests green
- [ ] `pnpm --filter @playloop/web run build` clean (stop dev first)
- [ ] new behaviour described in the relevant `docs/development_docs/*` page
- [ ] feature checklist (`docs/14-feature-checklist.md`) updated if user-visible
