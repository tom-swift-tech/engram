# Lessons

Format: `[date] | what went wrong | rule to follow next time`

- 2026-06-19 | When a native addon (better-sqlite3) failed to load under the active Node (ABI mismatch / missing prebuild), my first proposed fix was to pin the repo *backward* to an old Node major via .nvmrc. The user rejected pinning as unacceptable. | For a dependency/runtime ABI gap, prefer upgrading the dependency to a version that supports the *current* runtime (and add a CI version matrix to lock it in) over pinning the runtime backward. Pinning is a last resort, not a first fix.
- 2026-06-19 | Treated `require('better-sqlite3')` succeeding as proof the native binary loaded. It doesn't — better-sqlite3 lazily dlopen's the addon on first `new Database()`, so a missing/incompatible binary still passes a bare require. | To verify a native addon actually works, instantiate it (`new Database(':memory:')` + a real query), not just `require()`.
- 2026-06-19 | Ran `npm rebuild --build-from-source`, which *deleted* the existing working prebuilt binary before failing to compile a replacement — leaving the project more broken than I found it. | Don't run a from-source rebuild as a diagnostic when a working prebuilt binary exists; it's destructive on failure. Restore via `prebuild-install` / `npm install` first, and confirm the toolchain can build before forcing source builds.
