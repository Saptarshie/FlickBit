/**
 * Is a PGlite data directory readable?
 *
 *   node scripts/pglite-probe.mjs <dataDir>
 *
 * Standalone on purpose: PGlite's wasm module cannot be re-initialised after an
 * abort, so a corrupt directory has to be diagnosed in a *separate* process —
 * exactly the rule the server bootstrap now follows.
 */
import { PGlite } from '@electric-sql/pglite';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/pglite-probe.mjs <dataDir>');
  process.exit(2);
}

const db = new PGlite(dir);
try {
  const res = await db.query('select count(*)::int as games from games');
  console.log(`OK ${dir} games=${res.rows[0]?.games ?? '?'}`);
  await db.close();
  process.exit(0);
} catch (err) {
  console.error(`BROKEN ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
