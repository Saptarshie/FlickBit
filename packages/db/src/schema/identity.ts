import { pgTable, uuid, text, timestamp, boolean, primaryKey, pgEnum, uniqueIndex, integer, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRole = pgEnum('user_role', ['user', 'mod', 'admin']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  handle: text('handle').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  /** scrypt hash (see apps/web/src/lib/password.ts). Null until the account sets one. */
  passwordHash: text('password_hash'),
  email: text('email').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  role: userRole('role').notNull().default('user'),
  ageGate: boolean('age_gate').notNull().default(false),
  onboardingVibes: text('onboarding_vibes').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('users_handle_lower_uq').on(sql`lower(${t.handle})`),
  uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
]);

// Auth.js adapter tables (database sessions)
export const accounts = pgTable('accounts', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refreshToken: text('refresh_token'),
  accessToken: text('access_token'),
  expiresAt: integer('expires_at'),
  tokenType: text('token_type'),
  scope: text('scope'),
  idToken: text('id_token'),
}, (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })]);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable('verification_tokens', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.identifier, t.token] })]);

export const follows = pgTable('follows', {
  followerId: uuid('follower_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  followeeId: uuid('followee_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.followerId, t.followeeId] }),
  // Counting a creator's followers/checking "do I follow X" scans by followee;
  // the PK only covers (follower, followee). Measured 522 index searches for one
  // follower count before this.
  index('follows_followee_idx').on(t.followeeId),
]);

export const blocks = pgTable('blocks', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  blockedUserId: uuid('blocked_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.blockedUserId] })]);
