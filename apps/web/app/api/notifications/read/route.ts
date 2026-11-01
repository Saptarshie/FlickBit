import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { notifications } from '@playloop/db';
import { getDb } from '../../../../src/lib/db';
import {
  jsonError,
  jsonOk,
  parseValue,
  requireUser,
  wrap,
} from '../../../../src/lib/api-helpers';

const readSchema = z.object({
  all: z.boolean().optional(),
  ids: z.array(z.uuid()).optional(),
});

export const POST = wrap(async (req) => {
  const userId = await requireUser(req);

  // Empty body is treated as "mark everything read".
  const raw = await req.text();
  let input: z.infer<typeof readSchema>;
  if (raw.trim() === '') {
    input = { all: true };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw jsonError('bad_request', 'Invalid JSON body', 400);
    }
    input = parseValue(parsed, readSchema);
    if (input.all !== true && !(input.ids && input.ids.length > 0)) {
      return jsonError('bad_request', 'Provide ids or all: true', 400);
    }
  }

  const base = and(eq(notifications.userId, userId), isNull(notifications.readAt));
  const where =
    input.all === true
      ? base
      : and(base, inArray(notifications.id, input.ids ?? []));

  const updated = await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(where)
    .returning({ id: notifications.id });

  return jsonOk({ updated: updated.length });
});
