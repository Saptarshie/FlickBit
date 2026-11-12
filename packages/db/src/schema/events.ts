import { sql } from 'drizzle-orm';
import { pgTable, bigserial, timestamp, uuid, text, integer, real, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { games, gameVersions } from './games';

/**
 * Append-only event log for the recsys. Monthly range partitions are created by
 * `events.sql` (applied via `pnpm --filter @playloop/db db:events`), NOT by drizzle-kit,
 * because drizzle-kit cannot express PARTITION BY. The Drizzle table below is the
 * query/mapping shape only; never run drizzle-kit generate against it.
 */
export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  anonId: text('anon_id'),
  sessionId: text('session_id'),
  type: text('type').notNull(),
  gameId: uuid('game_id').references(() => games.id, { onDelete: 'set null' }),
  versionId: uuid('version_id').references(() => gameVersions.id, { onDelete: 'set null' }),
  position: integer('position'),
  source: text('source'),
  propensity: real('propensity'),
  modelVersion: text('model_version'),
  props: jsonb('props'),
}, (t) => [
  index('events_user_ts_idx').on(t.userId, t.ts),
  index('events_game_ts_idx').on(t.gameId, t.ts),
]);

/** Impression/view/play/etc event types (kept as text, not an enum, so new ones need no migration). */
export const EVENT_TYPES = [
  'impression', 'view', 'play_start', 'play_15s', 'play_end', 'gameover', 'replay',
  'like', 'save', 'comment', 'share', 'remix', 'follow_creator', 'skip_fast', 'report', 'hide',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type EventRow = {
  ts?: Date;
  userId?: string | null;
  anonId?: string | null;
  sessionId?: string | null;
  type: EventType;
  gameId?: string | null;
  versionId?: string | null;
  position?: number | null;
  source?: string | null;
  propensity?: number | null;
  modelVersion?: string | null;
  props?: Record<string, unknown> | null;
};

/**
 * A `Date` object handed straight to the driver came back as
 * ERR_INVALID_ARG_TYPE ("The \"string\" argument must be of type string") on
 * every batched insert, so events silently failed and the feed had no signal.
 * Send an ISO string instead: postgres casts it with ::timestamptz.
 */
function tsParam(ts: Date | string | null | undefined): string | null {
  if (!ts) return null;
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts.toISOString();
  return String(ts);
}

/** Batch insert. Uses raw SQL so it works against the partitioned table. */
export async function insertEvents(
  exec: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  rows: EventRow[],
): Promise<void> {
  if (rows.length === 0) return;
  // One INSERT for the whole batch. This is the write path of every play and
  // skip, so 50 round trips per beacon was both slow and a connection hog.
  const values = rows.map(
    (r) => sql`(
      coalesce(${tsParam(r.ts)}::timestamptz, now()),
      ${r.userId ?? null}, ${r.anonId ?? null}, ${r.sessionId ?? null}, ${r.type},
      ${r.gameId ?? null}, ${r.versionId ?? null}, ${r.position ?? null},
      ${r.source ?? null}, ${r.propensity ?? null}, ${r.modelVersion ?? null},
      ${r.props ? JSON.stringify(r.props) : null}::jsonb
    )`,
  );
  await exec.execute(sql`
    insert into events (ts, user_id, anon_id, session_id, type, game_id, version_id, position, source, propensity, model_version, props)
    values ${sql.join(values, sql`, `)}
  `);
}
