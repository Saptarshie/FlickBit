import { z } from 'zod';
import { auth } from '../../auth';

/**
 * Shared plumbing for API route handlers.
 *
 * Success responses are `{"data": ...}`; failures are `{"error": {code, message}}`.
 * Validation/auth helpers THROW a ready-to-return `Response` so handlers can
 * stay linear; `wrap()` catches those (plus unexpected errors) at the edge.
 */

/** Minimal shape of the session returned by the auth instance. */
type SessionLike = { user?: { id?: string | null } | null } | null;

/** `{data}` success envelope. */
export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** `{error:{code,message}}` failure envelope. */
export function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Validate a value against a zod schema; throws a 400 JSON Response on failure. */
export function parseValue<S extends z.ZodType>(value: unknown, schema: S): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw jsonError('validation_error', issue ? issue.message : 'Invalid input', 400);
  }
  return result.data;
}

/** Parse and validate a JSON request body; throws a 400 JSON Response on failure. */
export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw jsonError('bad_request', 'Invalid JSON body', 400);
  }
  return parseValue(raw, schema);
}

/** Return the authenticated user id; throws a 401 JSON Response when unauthenticated. */
export async function requireUser(_req: Request): Promise<string> {
  const session = (await auth()) as SessionLike;
  const userId = session?.user?.id;
  if (!userId) throw jsonError('unauthorized', 'Authentication required', 401);
  return userId;
}

export type RouteParams = Record<string, string>;
export type RouteContext<P extends RouteParams = RouteParams> = { params: Promise<P> };
export type RouteHandler<P extends RouteParams = RouteParams> = (
  req: Request,
  ctx: RouteContext<P>,
) => Promise<Response> | Response;

/**
 * Wrap a route handler so thrown Responses (from requireUser/parseBody/…)
 * become their own JSON response and unexpected errors become a 500.
 */
export function wrap<P extends RouteParams = RouteParams>(
  handler: RouteHandler<P>,
): (req: Request, ctx: RouteContext<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof Response) return err;
      console.error(err);
      return jsonError('internal', 'Internal server error', 500);
    }
  };
}
