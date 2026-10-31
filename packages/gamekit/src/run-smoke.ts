/**
 * CLI entry for the game-artifact smoke test.
 *
 *   npx tsx src/run-smoke.ts <file.html | template-id>
 *
 * Prints the SmokeReport as JSON and exits non-zero when pass is false.
 */
import { readFileSync } from 'node:fs';
import { getTemplate } from './index';
import { runSmokeTest } from './smoke';

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    fail('usage: run-smoke <file.html | template-id>', 2);
  }
  let html: string | null = null;
  try {
    html = readFileSync(arg, 'utf8');
  } catch {
    html = null;
  }
  if (html === null) {
    const template = getTemplate(arg);
    if (!template) {
      fail(`not an html file or template id: ${arg}`, 2);
    }
    html = template.code;
  }
  const report = await runSmokeTest(html);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err), 1);
});
