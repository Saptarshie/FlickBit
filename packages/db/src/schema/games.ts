import { pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, index, uniqueIndex, real, boolean, vector, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { users } from './identity';

export const gameStatus = pgEnum('game_status', ['draft', 'processing', 'published', 'unlisted', 'removed']);
export const moderationState = pgEnum('moderation_state', ['pending', 'approved', 'rejected', 'review']);
export const createdBy = pgEnum('created_by', ['ai', 'user']);

export const games = pgTable('games', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').notNull().references(() => users.id),
  title: text('title').notNull().default(''),
  description: text('description').notNull().default(''),
  tags: text('tags').array().notNull().default([]),
  status: gameStatus('status').notNull().default('draft'),
  publishedVersionId: uuid('published_version_id').references((): AnyPgColumn => gameVersions.id),
  forkedFromGameId: uuid('forked_from_game_id').references((): AnyPgColumn => games.id),
  forkedFromVersionId: uuid('forked_from_version_id'),
  moderation: moderationState('moderation').notNull().default('pending'),
  orientation: text('orientation').notNull().default('portrait'),
  controls: text('controls'),
  likeCount: integer('like_count').notNull().default(0),
  saveCount: integer('save_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  remixCount: integer('remix_count').notNull().default(0),
  playCount: integer('play_count').notNull().default(0),
  play15Count: integer('play15_count').notNull().default(0),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  index('games_status_published_idx').on(t.status, t.publishedAt),
  index('games_creator_idx').on(t.creatorId),
  index('games_tags_gin').using('gin', t.tags),
]);

export const gameVersions = pgTable('game_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  gameId: uuid('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }),
  parentVersionId: uuid('parent_version_id').references((): AnyPgColumn => gameVersions.id),
  versionNo: integer('version_no').notNull(),
  artifactSha256: text('artifact_sha256').notNull(),
  artifactBytes: integer('artifact_bytes').notNull(),
  artifactKey: text('artifact_key').notNull(),
  posterKey: text('poster_key'),
  previewKey: text('preview_key'),
  manifest: jsonb('manifest').notNull().default({}),
  validateReport: jsonb('validate_report'),
  testReport: jsonb('test_report'),
  createdBy: createdBy('created_by').notNull().default('ai'),
  genJobId: uuid('gen_job_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('game_versions_game_no_uq').on(t.gameId, t.versionNo)]);

export const gameFeatures = pgTable('game_features', {
  gameVersionId: uuid('game_version_id').primaryKey().references(() => gameVersions.id, { onDelete: 'cascade' }),
  codeSummary: jsonb('code_summary'),
  descriptionText: text('description_text'),
  frameCaptions: text('frame_captions').array(),
  textVec: vector('text_vec', { dimensions: 1024 }),
  visualVec: vector('visual_vec', { dimensions: 768 }),
  contentVec: vector('content_vec', { dimensions: 1024 }),
  quality: jsonb('quality'),
  qualityScore: real('quality_score'),
  feedEligible: boolean('feed_eligible').notNull().default(false),
  embeddedAt: timestamp('embedded_at', { withTimezone: true }),
  modelVersions: jsonb('model_versions'),
}, (t) => [
  index('game_features_content_hnsw').using('hnsw', t.contentVec.op('vector_cosine_ops')),
]);
