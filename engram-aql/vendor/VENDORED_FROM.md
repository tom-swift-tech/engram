# Vendored Dependencies

## aql-parser

**Upstream:** https://github.com/srirammails/AQL
**Commit:** 3e809435dcc9942bb09e9a5a14cff9ee26051145
**Path in upstream:** `crates/aql-parser/`
**License:** Apache-2.0 (preserved)
**Vendored on:** 2026-04-12

### Why vendored

This engram repo vendors `aql-parser` rather than pulling it as a git or
path dependency. Reasons:

1. engram repo is self-contained — `cargo build` works without internet
   and without sibling directory conventions
2. We pin an exact version of the AQL grammar — upstream grammar changes
   don't silently break our executor
3. No need to contribute back or maintain a fork for this project

### How to update

1. Note the new commit hash from upstream
2. `rm -rf engram-aql/vendor/aql-parser && cp -r <upstream>/crates/aql-parser engram-aql/vendor/aql-parser`
3. Update this file with the new commit hash and date
4. Run `cargo test -p aql-parser` (from inside the crate) to verify upstream didn't break anything
5. Update integration tests in `engram-aql/tests/` if the parser AST changed

### License

aql-parser is licensed under Apache-2.0. We retain the upstream LICENSE
file (if present) in the vendored directory. Currently no modifications
are made to the source.
