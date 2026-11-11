-- Handle accounts need a credential: a handle is public (every URL contains it),
-- so it cannot authenticate anyone on its own.
ALTER TABLE "users" ADD COLUMN "password_hash" text;
