import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDurableLogProvider } from '../src/log/fileProvider.js';
import { NoneDurableLogProvider } from '../src/log/noneProvider.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'durable-log-test-'));
}

function readLines(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('appends JSONL entries that round-trip', async () => {
  const dir = tmpDir();
  const provider = new FileDurableLogProvider({ dir, file: 'events.jsonl', maxBytes: 10_000, maxFiles: 3 });

  await provider.write({ type: 'prompt_injection', sessionId: 'a', mode: 'log' });
  await provider.write({ type: 'unsafe_content', sessionId: 'b', mode: 'log' });

  const lines = readLines(path.join(dir, 'events.jsonl'));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'prompt_injection');
  assert.equal(lines[1].sessionId, 'b');
});

test('rotates the active file once maxBytes is crossed', async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'events.jsonl');
  // First entry is ~61 bytes; a cap just above that means the second entry
  // alone triggers exactly one rotation.
  const provider = new FileDurableLogProvider({ dir, file: 'events.jsonl', maxBytes: 65, maxFiles: 3 });

  await provider.write({ type: 'prompt_injection', sessionId: 'first', mode: 'log' });
  await provider.write({ type: 'prompt_injection', sessionId: 'second', mode: 'log' });

  assert.ok(fs.existsSync(`${filePath}.1`), 'expected a rotated file to exist');
  const rotated = readLines(`${filePath}.1`);
  const active = readLines(filePath);
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].sessionId, 'first');
  assert.equal(active.length, 1);
  assert.equal(active[0].sessionId, 'second');
});

test('retains at most maxFiles rotated files, oldest pruned first', async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, 'events.jsonl');
  const provider = new FileDurableLogProvider({ dir, file: 'events.jsonl', maxBytes: 40, maxFiles: 2 });

  for (let i = 0; i < 8; i += 1) {
    await provider.write({ type: 'prompt_injection', sessionId: `s${i}`, mode: 'log' });
  }

  assert.ok(fs.existsSync(`${filePath}.1`));
  assert.ok(fs.existsSync(`${filePath}.2`));
  assert.equal(fs.existsSync(`${filePath}.3`), false, 'a 3rd rotated file should have been pruned');
});

test('disables itself gracefully when the directory is unwritable', async () => {
  // A file used as the "directory" makes mkdirSync fail deterministically.
  const parent = tmpDir();
  const notADir = path.join(parent, 'blocked');
  fs.writeFileSync(notADir, 'not a directory');

  const provider = new FileDurableLogProvider({
    dir: path.join(notADir, 'sub'),
    file: 'events.jsonl',
    maxBytes: 1000,
    maxFiles: 2,
  });

  assert.equal(provider.disabled, true);
  await assert.doesNotReject(() => provider.write({ type: 'prompt_injection', sessionId: 'x', mode: 'log' }));
});

test('NoneDurableLogProvider is a true no-op', async () => {
  const provider = new NoneDurableLogProvider();
  await assert.doesNotReject(() => provider.write({ type: 'prompt_injection', sessionId: 'x', mode: 'log' }));
});
