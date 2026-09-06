# Linux backup validation — 2026-09-06

Validated the local working-tree implementation using synthetic databases in an isolated WSL directory. These results do not describe a published npm release. The initial results below precede the schema-upgrade extension; see the follow-up section for its latest checks.

## Environment

- WSL2 Kali Linux, x86_64, kernel `6.6.87.2-microsoft-standard-WSL2`.
- Node.js `22.23.2`, npm `12.0.2`, SQLite `3.53.2`.
- Independent Linux dependencies and native binaries; no Windows `node_modules` reuse.
- Linux source and tests matched the Windows working tree at completion. Lockfiles matched exactly. The isolated Linux package manifest differed only by npm install-script approvals for `better-sqlite3` and `esbuild`.
- Test root: `/tmp/lemma-linux-validation-h8X8Hy`; test processes used isolated homes. No personal memory database was restored during this validation.

## Results

| Check | Result |
| --- | --- |
| Linux typecheck and build | Passed |
| Full Linux automated suite | 853 passed, 0 failed, 0 skipped; 81 files, 226 suites |
| Actual MCP backup smoke, clean and legacy-vector databases | 19 checks each; 38 passed |
| Windows export to Linux restore | All 4 source/receiver combinations passed |
| Linux export to Windows restore | All 4 source/receiver combinations passed |
| Per cross-platform case | Every row/value in 18 ordinary tables matched; safety-backup undo passed |
| MCP smoke, C2 quality, wave2, wave3 | Passed after correcting obsolete tool-count assertions from 26 to 29 |
| Confirmation, deep and injection exploratory scripts | Completed with exit code 0 |
| New portability script and optional GLM script syntax | Passed |

Cross-platform cases cover clean and recognized unused legacy-vector schema on both sides. Fixtures include Unicode, integers beyond JavaScript's safe-integer range, archived/invalidated records, versions, evidence, relations, guides, sessions, attempts and suggestions. MCP smoke checks also cover concurrent-process restore blocking, explicit confirmation, safety undo and writes after restoration.

## Repeat the cross-platform check

Build on both systems first. Export on the producer, copy the entire bundle directory to the other operating system, then import there. Use an absolute bundle path appropriate to each system:

```sh
node tests/manual/backup-portability.mjs export /absolute/bundle-directory
node tests/manual/backup-portability.mjs import /absolute/copied-bundle-directory
node tests/manual/backup-portability.mjs import /absolute/copied-bundle-directory --legacy-vectors
```

Repeat export with `--legacy-vectors` and run both import variants. Reverse producer and receiver to complete all eight cases. The script requires producer and receiver operating systems to differ and creates isolated temporary database homes.

## Evidence boundaries

- Linux was tested under WSL2, not a separate physical Linux machine.
- macOS was not run locally; a portability CI matrix is configured for Ubuntu, Windows and macOS, but no remote CI result is claimed here.
- The optional live GLM-agent test was not run because `ZAI_API_KEY` was absent on both systems. Its syntax check passed; external model behavior remains unverified.
- Corrected smoke/wave3 assertions were rerun successfully. No application source changed after the full automated suite passed.
- No commit, push or npm publication was performed as part of this validation.

## Schema-upgrade follow-up — 2026-09-06

Added exact-schema validation and in-memory upgrades for backup-format version 1 containing known schema versions 1–8. Original files are unchanged. Preview reports the version range and notes before confirmation, including the project-key normalization applied when upgrading schema 1 or 2. The legitimate `schema_version=-1` decay timestamp is preserved; other unknown or missing history rows are rejected.

- Linux typecheck/build and full automated suite: **871/871 passed**, 226 suites, no failures or skips.
- Windows typecheck/build and focused backup suite: **57/57 passed**.
- The 18 new tests include all eight source schemas with and without the recognized legacy-vector scaffold, plus rejection/confirmation regressions. They check Unicode, 64-bit IDs and counters, migration defaults, project normalization, maintenance timestamps, search, original-file preservation and safety undo.
- Actual stdio MCP smoke on Windows and Linux, clean and legacy variants: **76/76 checks passed** after correcting the maintenance-timestamp handling discovered by these tests.
- Previously generated cross-platform bundles were restored again with the updated reader: **8/8 passed**, each comparing all rows of 18 tables and verifying safety undo. These bundles use schema 8; historical-schema cases were exercised independently on both systems.
- Historical fixtures are generated from bundled schema definitions. This is evidence for those exact schemas in the supported backup envelope, not a claim that arbitrary files from every historical npm release are compatible.
- The latest application source and tests were copied to the same isolated Linux project. Its earlier package manifest was retained; the full suite explicitly included all test globs, including the new upgrade test. The primary `test:backup` command now includes that test for the CI portability matrix.

macOS and the optional external GLM test remain unmeasured as described above. No user database was restored or published during this follow-up.
