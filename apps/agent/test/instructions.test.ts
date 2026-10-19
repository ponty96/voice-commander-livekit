import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildInstructions, loadSystemContext } from '../src/instructions.js';

test('loads the system context file relative to the agent directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vic-ctx-'));
  await writeFile(join(dir, 'shop.md'), '# Shop\n\nSells telescopes.\n');
  assert.equal(loadSystemContext('shop.md', dir), '# Shop\n\nSells telescopes.');
  assert.equal(loadSystemContext(undefined, dir), undefined);
});

test('a configured but missing or empty file stops startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vic-ctx-'));
  await writeFile(join(dir, 'empty.md'), '  \n');
  assert.throws(() => loadSystemContext('missing.md', dir), /SYSTEM_CONTEXT_PATH=missing.md: could not read/);
  assert.throws(() => loadSystemContext('empty.md', dir), /is empty/);
});

test('instructions are persona, then system context, then tool knowledge', () => {
  assert.equal(buildInstructions('Persona.'), 'Persona.');
  assert.equal(
    buildInstructions('Persona.', '# Shop', '## How to use the grafana tools'),
    'Persona.\n\n# System context: the application you are investigating\n\n# Shop\n\n## How to use the grafana tools',
  );
});

test('the bundled Astronomy Shop context loads', () => {
  assert.match(loadSystemContext('context/astronomy-shop.md') ?? '', /^# Astronomy Shop/);
});
