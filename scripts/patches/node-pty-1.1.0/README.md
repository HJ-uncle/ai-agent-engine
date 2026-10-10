# node-pty 1.1.0 system ConPTY close patch

This patch fixes a demonstrated console helper / native close race without changing
native binaries or selecting the experimental bundled ConPTY DLL. The DLL option
failed four of five real lifecycle probes and remains outside this patch's support.

The default Windows system ConPTY path queries the console before native close,
waits for the helper's message and actual exit with a two-second deadline, coalesces
duplicate kills, and waits for the output worker's actual termination. Natural
terminal exit also disposes that worker. Unknown query, native, process-kill and
worker errors retain their original diagnostic stderr.

`onExit` keeps its existing fields and adds optional `cleanupError`. Windows also
exposes an optional `onCleanup` event that fires after the close attempt even if
process exit does not arrive. Its payload is `{ cleanupError?: IPtyCleanupError }`.
Applications must observe both exit and cleanup and must not report cleanup success
when this field is present. Consumers never access the private agent.

`IPtyCleanupError` has `code: 'PTY_CLEANUP_FAILED'`, a message and `errors`, whose
entries contain `phase`, `code`, `name`, `message`, and optional original `stack`.
An observed natural shell exit, or a confirmed `ESRCH` for the original shell,
normalizes only the known `AttachConsole failed` race; other failures stay visible.

Apply from the repository or installed engine root:

```powershell
node scripts/apply-node-pty-patch.mjs --root D:\dev\ai-agent-engine
node scripts/apply-node-pty-patch.mjs --root D:\dev\ai-agent-engine --check
```

For an SDK/staged copy, pass `--package-dir <absolute node-pty directory>`.
Add `--lockfile <package-lock.json>` when checking a source installation. Installed
artifacts without a lock are guarded by exact package metadata and file hashes.

The applicator preflights all exact original/patched hashes, package name/version,
asset hashes, optional lock version, real paths and symlinks before writing anything.
It atomically replaces only known files and writes a deterministic receipt last.
Known partially applied copies can resume; unknown bytes or receipts are rejected.
`--check` never writes. Source maps remain upstream and are not accurate maps for
the patched JavaScript. The dependency's MIT copyright notices are retained.

Independent tests (already excluded from Vitest discovery):

```powershell
node --test scripts/longrun/node-pty-patch.test.mjs
```

During formal R2 this patch exists only as repository script assets and `.tmp`
clones. Product package/build/runtime entry points must be integrated after the
freeze is released, then new engine/SDK/client artifacts and a new TGZ must be
built, hash-checked and exercised through real terminal creation and closing.
