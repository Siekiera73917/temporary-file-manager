import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TemporaryFileManager } from '../src/index.js';

// A scratch tmpdir per test to avoid cross-test interference. We create one
// shared parent for the whole suite and clean it up at the end.
const scratchParent = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-test-'));

function newTmpdir() {
  return fs.mkdtempSync(path.join(scratchParent, 'case-'));
}

test('createFile produces an existing empty file', () => {
  const dir = newTmpdir();
  const m = new TemporaryFileManager({ autoCleanup: false, tmpdir: dir });
  const p = m.createFile();
  assert.ok(fs.existsSync(p), 'file should exist');
  assert.equal(fs.statSync(p).size, 0, 'file should be empty');
  assert.equal(path.dirname(p), dir, 'file should be inside tmpdir');
  m.cleanupSync();
});

test('createDir produces an existing directory', () => {
  const dir = newTmpdir();
  const m = new TemporaryFileManager({ autoCleanup: false, tmpdir: dir });
  const p = m.createDir();
  assert.ok(fs.existsSync(p), 'dir should exist');
  assert.ok(fs.statSync(p).isDirectory(), 'should be a directory');
  assert.equal(path.dirname(p), dir, 'dir should be inside tmpdir');
  m.cleanupSync();
});

test('cleanupSync removes tracked file and dir', () => {
  const dir = newTmpdir();
  const m = new TemporaryFileManager({ autoCleanup: false, tmpdir: dir });
  const f = m.createFile();
  const d = m.createDir();
  // Put a file inside the dir to prove recursive removal.
  fs.writeFileSync(path.join(d, 'nested.txt'), 'x');
  const { removed, errors } = m.cleanupSync();
  assert.equal(errors.length, 0);
  assert.deepEqual(removed.sort(), [d, f].sort());
  assert.ok(!fs.existsSync(f));
  assert.ok(!fs.existsSync(d));
});

test('register is idempotent and tracks arbitrary paths', () => {
  const dir = newTmpdir();
  const m = new TemporaryFileManager({ autoCleanup: false, tmpdir: dir });
  const f = m.createFile();
  m.register(f); // no-op duplicate
  assert.equal(m.paths.size, 1);
  m.cleanupSync();
});

test('forget removes a path from tracking without deleting', () => {
  const dir = newTmpdir();
  const m = new TemporaryFileManager({ autoCleanup: false, tmpdir: dir });
  const f = m.createFile();
  assert.equal(m.forget(f), true);
  assert.equal(m.forget(f), false); // already forgotten
  assert.ok(fs.existsSync(f), 'file should still be on disk');
  // Cleanup should not touch the forgotten file.
  m.cleanupSync();
  assert.ok(fs.existsSync(f), 'forgotten file survives cleanup');
  fs.rmSync(f, { force: true });
});

test('cleanupSync reports per-path errors but continues', () => {
  const dir = newTmpdir();
  const m = new TemporaryFileManager({ autoCleanup: false, tmpdir: dir });
  const f1 = m.createFile();
  // Create a directory whose removal will fail because it is busy: we make a
  // child directory whose mode is read-only so rmSync cannot unlink entries
  // inside it. This produces a real EPERM/ENOTEMPTY-style error.
  const lockedDir = path.join(dir, 'locked');
  fs.mkdirSync(lockedDir);
  const inner = path.join(lockedDir, 'inner');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'child.txt'), 'x');
  fs.chmodSync(inner, 0o400); // read-only: removal of its contents fails
  m.register(lockedDir);
  const { removed, errors } = m.cleanupSync();
  assert.ok(removed.includes(f1), 'real file should be removed');
  assert.ok(errors.some(e => e.path === lockedDir), 'locked dir should error');
  // Restore mode so the suite teardown can delete scratchParent.
  fs.chmodSync(inner, 0o700);
});

test('register throws on non-string or empty string', () => {
  const m = new TemporaryFileManager({ autoCleanup: false });
  assert.throws(() => m.register(123), TypeError);
  assert.throws(() => m.register(''), TypeError);
});

test('dispose detaches from process listeners without deleting paths', () => {
  const dir = newTmpdir();
  const m = new TemporaryFileManager({ autoCleanup: true, tmpdir: dir });
  const f = m.createFile();
  m.dispose();
  assert.ok(fs.existsSync(f), 'file survives dispose');
  // Manually clean since the manager is now detached.
  fs.rmSync(f, { force: true });
});

test('prefix option is honoured', () => {
  const dir = newTmpdir();
  const m = new TemporaryFileManager({ autoCleanup: false, tmpdir: dir, prefix: 'custom-' });
  const p = m.createFile();
  assert.ok(path.basename(p).startsWith('custom-'), `basename ${path.basename(p)} should start with custom-`);
  m.cleanupSync();
});

// Final sweep so the suite leaves nothing behind.
test('teardown scratch parent', () => {
  fs.rmSync(scratchParent, { force: true, recursive: true });
  assert.ok(!fs.existsSync(scratchParent));
});
