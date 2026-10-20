import { readdir } from 'node:fs/promises';
import { initializeLogger } from '@livekit/agents';
import { join } from 'node:path';
import { generateReport, REPORT_MODEL } from './generate.js';
import { REPORTS_DIR, writeRecord } from './recorder.js';

/**
 * Builds records and reports outside the agent.
 *   report <investigationId> [--force] [--model <model>]   (re)generate one report
 *   report --all [--model <model>]                         fill in every missing record and report
 */
// The LiveKit SDK logs through its own logger, which the agent runtime normally sets up.
initializeLogger({ pretty: true, level: 'warn' });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : REPORT_MODEL;
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--model');

const targets = flag('--all')
  ? (await readdir(REPORTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  : ids;
if (targets.length === 0) {
  console.error('Usage: report <investigationId> [--force] [--model <model>] | report --all [--model <model>]');
  process.exit(1);
}

let failed = 0;
for (const id of targets.sort()) {
  const dir = join(REPORTS_DIR, id);
  // Rebuilding the record also marks a crashed investigation (no session_end) as incomplete.
  const facts = await writeRecord(dir);
  const result = await generateReport(dir, { model, force: flag('--force') });
  if (!result.ok) failed += 1;
  console.log(
    `${id}: ${facts.status}, ${result.ok ? (result.skipped ?? 'report written') : `failed: ${result.error}`}`,
  );
}
process.exit(failed ? 1 : 0);
