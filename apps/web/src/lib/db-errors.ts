/**
 * Turn a driver error into something a player can act on.
 *
 * A raw `Failed query: insert into "games" … params: …` used to be printed
 * straight into the studio chat: it leaks the schema, the ids and the values,
 * and tells the user nothing. The technical detail goes to the server log; the
 * client gets a short sentence, a stable code and whether retrying can help.
 */
export type HumanError = {
  code: string;
  message: string;
  retryable: boolean;
  /** Server-side only: never sent to the client. */
  detail: string;
};

export function humanizeDbError(err: unknown): HumanError {
  const e = err as { code?: string; message?: string; constraint?: string; detail?: string } | null;
  const code = e?.code ?? '';
  const detail = String(e?.message ?? err ?? 'unknown error').slice(0, 2000);

  if (code === '23503') {
    // Foreign key: in this app the only realistic cause is a signed-in id that
    // no longer exists, or a game that was deleted under a remix.
    return {
      code: 'foreign_key',
      message: 'A record this build points at no longer exists. Sign in again and retry — your work up to the last step is safe.',
      retryable: true,
      detail,
    };
  }
  if (code === '23505') {
    return { code: 'duplicate', message: 'That build already exists — nothing to do.', retryable: false, detail };
  }
  if (code === '23514' || code === '22P02' || code === '22001') {
    return { code: 'invalid_value', message: 'The generated details could not be stored. Retrying usually fixes it.', retryable: true, detail };
  }
  if (code === '53300' || code === '08006' || code === '08003' || code === 'ECONNRESET') {
    return { code: 'db_unavailable', message: 'The database is not reachable right now. Nothing was lost — retry in a moment.', retryable: true, detail };
  }
  return {
    code: 'internal',
    message: 'Something went wrong while saving this build. Retry, and if it keeps failing the details are in the server log.',
    retryable: true,
    detail,
  };
}
