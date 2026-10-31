import { pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, index, primaryKey, boolean, numeric } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { games, gameVersions } from './games';

export const genKind = pgEnum('gen_kind', ['create', 'edit', 'remix_edit', 'polish']);
export const genStatus = pgEnum('gen_status', ['queued', 'running', 'succeeded', 'failed', 'canceled']);

export const generationJobs = pgTable('generation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  gameId: uuid('game_id').references(() => games.id),
  kind: genKind('kind').notNull(),
  prompt: text('prompt').notNull(),
  baseVersionId: uuid('base_version_id').references(() => gameVersions.id),
  status: genStatus('status').notNull().default('queued'),
  stage: text('stage'),
  attempts: integer('attempts').notNull().default(0),
  error: jsonb('error'),
  resultVersionId: uuid('result_version_id').references(() => gameVersions.id),
  costUsd: numeric('cost_usd').notNull().default('0'),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  promptVersions: jsonb('prompt_versions'),
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [index('gen_jobs_user_idx').on(t.userId, t.createdAt)]);

export const genEvents = pgTable('gen_events', {
  jobId: uuid('job_id').notNull().references(() => generationJobs.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.jobId, t.seq] })]);

export const chatRole = pgEnum('chat_role', ['user', 'assistant', 'system']);
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  gameId: uuid('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id),
  role: chatRole('role').notNull(),
  content: text('content').notNull(),
  versionId: uuid('version_id').references(() => gameVersions.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('chat_game_idx').on(t.gameId, t.createdAt)]);

export const modelRuns = pgTable('model_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').references(() => generationJobs.id, { onDelete: 'set null' }),
  stage: text('stage').notNull(),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: numeric('cost_usd').notNull().default('0'),
  latencyMs: integer('latency_ms'),
  ok: boolean('ok').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditReason = pgEnum('credit_reason', ['daily_grant', 'generate', 'edit', 'refund', 'purchase', 'admin']);
export const creditLedger = pgTable('credit_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  delta: integer('delta').notNull(),
  reason: creditReason('reason').notNull(),
  jobId: uuid('job_id').references(() => generationJobs.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('credit_user_idx').on(t.userId, t.createdAt)]);
