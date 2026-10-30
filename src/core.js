/**
 * TemporaryFileManager — creates and tracks temporary files/directories,
 * cleaning them up automatically on process exit or signal.
 *
 * Design decisions, stated plainly:
 *
 * 1. Each manager instance owns its own set of paths and its own cleanup hooks.
 *   The first instance to call install() registers process-wide listeners.
 *   Shared state across instances lives in module-level variables guarded by
 *   Set operations — this avoids duplicate listeners while keeping instance
 *   ownership of paths.
 *
 * 2. Cleanup runs synchronously on process exit and SIGINT/SIGTERM. We deliberately
 *   use process.on('exit') (synchronous-only handler) plus signal handlers that
 *   call cleanup then process.exit(128+signum) to force a synchronous exit.
 *   This means cleanup must be fast and must not schedule I/O via callbacks that
 *   the exit handler cannot wait for — we use fs.rmSync with force+recursive.
 *
 * 3. We listen for the standard terminating signals: SIGINT (Ctrl-C) and SIGTERM.
 *   We do NOT trap SIGHUP (often non-fatal in long-running daemons) or SIGQUIT,
 *   because trapping those can surprise callers in unexpected ways.
 *
 * 4. register() is idempotent — adding the same path twice is a no-op.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SIGNALS = ['SIGINT', 'SIGTERM'];

// Shared, module-level registration state. A single Set of listeners ensures
// we never register the same signal handler twice even if multiple managers exist.
let listenersInstalled = false;
const managers = new Set();

function uninstallListeners() {
  process.removeListener('exit', handleExit);
  for (const sig of SIGNALS) {
    process.removeListener(sig, handleSignal);
  }
  listenersInstalled = false;
}

function handleExit() {
  // process 'exit' handler: synchronous only. rmSync is fine here.
  for (const m of managers) {
    try {
      m.cleanupSync();
    } catch {
      // Swallow — a failure in one manager's cleanup must not prevent others.
    }
  }
}

function handleSignal(signal) {
  handleExit();
  // Signal exit code convention: 128 + signal number.
  // SIGINT = 2, SIGTERM = 15. We compute from the os.constants table so we
  // don't hardcode magic numbers that could drift on exotic platforms.
  const code = 128 + (os.constants.signals[signal] ?? 0);
  process.exit(code);
}

function installListeners() {
  if (listenersInstalled) return;
  process.on('exit', handleExit);
  for (const sig of SIGNALS) {
    process.on(sig, handleSignal);
  }
  listenersInstalled = true;
}

export class TemporaryFileManager {
  /**
   * Create a manager. Options:
   *   - autoCleanup (default true): if false, the manager will NOT install
   *     process-wide signal/exit hooks. Useful for tests or when the caller
   *     wants to drive cleanup manually via cleanupSync().
   *   - prefix (default 'tmp-mgr-'): prefix for generated temp basenames.
   *   - tmpdir (default os.tmpdir()): parent directory for temp paths.
   */
  constructor(opts = {}) {
    const o = opts || {};
    this.autoCleanup = o.autoCleanup !== false;
    this.prefix = typeof o.prefix === 'string' ? o.prefix : 'tmp-mgr-';
    this.tmpdir = typeof o.tmpdir === 'string' ? o.tmpdir : os.tmpdir();
    /** @type {Set<string>} */
    this.paths = new Set();
    if (this.autoCleanup) {
      managers.add(this);
      installListeners();
    }
  }

  /**
   * Create a temp file (empty) under tmpdir and register it for cleanup.
   * Returns the absolute path.
   *
   * We use fs.openSync with 'wx' (exclusive) to avoid clobbering an existing
   * file, which is the safe default for temp creation.
   */
  createFile() {
    const p = this._uniquePath();
    const fd = fs.openSync(p, 'wx');
    fs.closeSync(fd);
    this.register(p);
    return p;
  }

  /**
   * Create a temp directory and register it for cleanup. Returns absolute path.
   */
  createDir() {
    const p = fs.mkdtempSync(path.join(this.tmpdir, this.prefix));
    this.register(p);
    return p;
  }

  /**
   * Register an existing path for cleanup. Idempotent.
   */
  register(p) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new TypeError('register: path must be a non-empty string');
    }
    this.paths.add(p);
  }

  /**
   * Stop tracking a path WITHOUT deleting it. Returns true if the path was
   * tracked and is now forgotten; false if it was never tracked.
   */
  forget(p) {
    return this.paths.delete(p);
  }

  /**
   * Delete every tracked path synchronously, then clear the set. Errors are
   * swallowed per-path (returned in the errors array) so one missing or
   * locked file does not leave the rest behind.
   *
   * Returns { removed: string[], errors: { path: string, error: Error }[] }.
   */
  cleanupSync() {
    const removed = [];
    const errors = [];
    for (const p of this.paths) {
      try {
        fs.rmSync(p, { force: true, recursive: true });
        removed.push(p);
      } catch (err) {
        errors.push({ path: p, error: err });
      }
    }
    this.paths.clear();
    return { removed, errors };
  }

  /**
   * Detach this manager from the process-wide exit/signal handlers. After
   * calling this, an autoCleanup manager will no longer be triggered on exit.
   * Tracked paths are left untouched — call cleanupSync() if you want them gone.
   */
  dispose() {
    managers.delete(this);
    if (managers.size === 0 && listenersInstalled) {
      uninstallListeners();
    }
  }

  _uniquePath() {
    // Use crypto.randomUUID if available (Node >= 14.17), else a timestamp+random
    // fallback. Keeping the fallback avoids a hard dependency on a particular
    // Node minor version.
    let name;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      name = this.prefix + crypto.randomUUID();
    } else {
      name = this.prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    return path.join(this.tmpdir, name);
  }
}
