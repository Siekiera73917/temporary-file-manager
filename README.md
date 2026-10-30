# temporary-file-manager

A small ESM TypeScript-flavoured JavaScript library that creates and tracks temporary files and directories, deleting them automatically on process exit, SIGINT, or SIGTERM.

## Usage

```js
import { TemporaryFileManager } from 'temporary-file-manager';

const mgr = new TemporaryFileManager();

const file = mgr.createFile();       // absolute path to an empty temp file
const dir  = mgr.createDir();        // absolute path to a temp directory

mgr.register('/some/existing/path'); // track an arbitrary path for cleanup
mgr.forget(file);                    // stop tracking, leave on disk

const { removed, errors } = mgr.cleanupSync(); // delete everything tracked
mgr.dispose();                       // detach from process exit/signal hooks
```

Pass `{ autoCleanup: false }` to the constructor if you do not want process-wide hooks installed — handy in tests or long-running services that manage their own lifecycle.

## Why

The `fs.mkdtempSync` and `os.tmpdir()` primitives are enough to *create* temp paths, but nothing deletes them for you. Long-running scripts and one-shot CLIs both tend to litter `/tmp`. This library keeps a per-instance `Set` of paths and wires a single set of process listeners (registered once, shared across all instances) that runs `fs.rmSync` with `recursive: true, force: true` on exit.

The trade-off: cleanup is **synchronous**. On `exit` Node forbids async work, and on `SIGINT`/`SIGTERM` we call `cleanupSync()` then `process.exit(128 + signum)` to force a synchronous exit. If your temp files are large or on a slow filesystem, the signal-handling path will block briefly. That is intentional — the alternative is leaking files when the process is killed.

## Edge cases worth knowing

- **Per-path errors do not abort the sweep.** `cleanupSync()` returns `{ removed, errors }`; a path that fails (locked, already gone in a race, permission denied) is reported in `errors` while the rest are still removed.
- **`forget(path)` does not delete.** It only stops tracking. Use it when you hand a temp file off to code that takes ownership of its lifetime.
- **Only `SIGINT` and `SIGTERM` are trapped.** `SIGHUP` and `SIGQUIT` are deliberately left alone so daemons behave predictably.
- **Multiple managers share one set of listeners.** The first manager with `autoCleanup: true` installs them; the last one to call `dispose()` removes them.
