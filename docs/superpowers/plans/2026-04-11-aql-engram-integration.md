# AQL-Engram Integration — Phase 1 Implementation Plan (SUPERSEDED)

> **Status: Superseded 2026-04-12.** See `2026-04-12-engram-aql-rust-binary.md` for the current plan.
>
> **What happened:** Task 1 (TypeScript AST types) was implemented successfully (commits 5499479, a910a14 on branch `feat/aql-integration`), but during Task 2 preparation we discovered the Rust `aql-parser` serde output format doesn't match our TypeScript types, and the AQL grammar's LINK statement is fundamentally different from what this plan assumed. We pivoted from a WASM-bridge TypeScript approach to a native Rust binary sharing the SQLite file with TypeScript Engram.

---

# Original Plan (WASM Bridge Approach)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AQL as a declarative query layer on top of Engram, using the canonical Rust parser compiled to WASM, translating AQL statements into existing Engram API calls.

**Architecture:** AQL strings are parsed by `aql-parser` WASM into an AST, then a translator module (`src/aql.ts`) maps each statement type to Engram method calls (`retain`, `recall`, `reflect`, `forget`, `supersede`) and direct SQLite operations (for LINK, SCAN, LOAD). A new `engram.query()` public method and `engram_aql` MCP tool expose the interface.

**Tech Stack:** TypeScript (Engram), Rust/WASM (aql-parser), vitest (testing), better-sqlite3 (SQLite)

**Spec:** `docs/superpowers/specs/2026-04-11-aql-engram-integration-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/aql-types.ts` | Create | TypeScript types mirroring the Rust AST (Statement, Predicate, Modifier, Value enums) |
| `src/aql-parser.ts` | Create | WASM parser wrapper — init, parse, error handling |
| `src/aql.ts` | Create | Statement-to-Engram translator — the core execution engine |
| `src/aql-sql.ts` | Create | Direct SQL query builder for compound WHERE, ORDER BY, AGGREGATE |
| `src/schema.sql` | Modify | Add `tools` table, add `data_json` + `source_type` columns to `observations` |
| `src/engram.ts` | Modify | Add `query()` method, init WASM in `Engram.init()`, re-export AQL types |
| `src/reflect.ts` | Modify | Add `reflectOn()` function for targeted reflection |
| `src/mcp-tools.ts` | Modify | Add `engram_aql` MCP tool definition + handler |
| `package.json` | Modify | Add `aql-parser-wasm` dependency |
| `tests/aql-types.test.ts` | Create | AST type validation tests |
| `tests/aql-parser.test.ts` | Create | WASM parser integration tests |
| `tests/aql.test.ts` | Create | Translator unit tests (all 10 statement types) |
| `tests/aql-sql.test.ts` | Create | Direct SQL path tests (compound WHERE, ORDER BY, AGGREGATE) |
| `tests/aql-mcp.test.ts` | Create | MCP tool integration tests |

---

## Task 1: AST Type Definitions

Define TypeScript types that mirror the Rust `aql-parser` AST. These types are the contract between the WASM parser output and the translator.

**Files:**
- Create: `src/aql-types.ts`
- Test: `tests/aql-types.test.ts`

- [ ] **Step 1: Write the type validation test**

```typescript
// tests/aql-types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  Statement,
  MemoryType,
  Predicate,
  Modifiers,
  Value,
  Condition,
  AqlQueryResult,
} from '../src/aql-types.js';

describe('AQL AST Types', () => {
  it('Statement discriminated union covers all 10 types', () => {
    const recall: Statement = {
      type: 'Recall',
      memory_type: 'Semantic',
      predicate: { type: 'All' },
      modifiers: {},
    };
    expect(recall.type).toBe('Recall');

    const store: Statement = {
      type: 'Store',
      memory_type: 'Episodic',
      fields: { event: { type: 'String', value: 'deploy' } },
      modifiers: {},
    };
    expect(store.type).toBe('Store');
  });

  it('MemoryType enum matches AQL spec', () => {
    const types: MemoryType[] = [
      'Working',
      'Episodic',
      'Semantic',
      'Procedural',
      'Tools',
      'All',
    ];
    expect(types).toHaveLength(6);
  });

  it('Predicate discriminated union covers all 5 types', () => {
    const where: Predicate = {
      type: 'Where',
      conditions: [
        {
          type: 'Simple',
          field: 'context',
          op: '=',
          value: { type: 'String', value: 'infra' },
        },
      ],
    };
    expect(where.type).toBe('Where');

    const key: Predicate = {
      type: 'Key',
      field: 'id',
      value: { type: 'String', value: 'e-001' },
    };
    expect(key.type).toBe('Key');

    const like: Predicate = { type: 'Like', variable: '$embedding' };
    expect(like.type).toBe('Like');

    const pattern: Predicate = {
      type: 'Pattern',
      variable: '$pat',
      threshold: 0.7,
    };
    expect(pattern.type).toBe('Pattern');

    const all: Predicate = { type: 'All' };
    expect(all.type).toBe('All');
  });

  it('Value union covers all types', () => {
    const values: Value[] = [
      { type: 'Null' },
      { type: 'Bool', value: true },
      { type: 'Int', value: 42 },
      { type: 'Float', value: 3.14 },
      { type: 'String', value: 'hello' },
      { type: 'Variable', name: 'x' },
      { type: 'Array', items: [{ type: 'Int', value: 1 }] },
    ];
    expect(values).toHaveLength(7);
  });

  it('AqlQueryResult has required shape', () => {
    const result: AqlQueryResult = {
      success: true,
      statement: 'Recall',
      data: [{ id: 'abc', text: 'hello' }],
      count: 1,
      timing_ms: 5,
    };
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it('AqlQueryResult supports warnings and error', () => {
    const result: AqlQueryResult = {
      success: false,
      statement: 'Store',
      data: [],
      count: 0,
      timing_ms: 0,
      error: 'Parse error at line 1',
      warnings: ['SCOPE modifier ignored (not yet supported)'],
    };
    expect(result.error).toBeDefined();
    expect(result.warnings).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql-types.test.ts`
Expected: FAIL — cannot resolve `../src/aql-types.js`

- [ ] **Step 3: Create the AST type definitions**

```typescript
// src/aql-types.ts
// =============================================================================
// AQL AST Types
// TypeScript mirror of the Rust aql-parser Statement enum.
// These types define the contract between the WASM parser output (JSON) and
// the Engram translator (src/aql.ts).
// =============================================================================

// ---------------------------------------------------------------------------
// Memory Types
// ---------------------------------------------------------------------------

export type MemoryType =
  | 'Working'
  | 'Episodic'
  | 'Semantic'
  | 'Procedural'
  | 'Tools'
  | 'All';

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type Value =
  | { type: 'Null' }
  | { type: 'Bool'; value: boolean }
  | { type: 'Int'; value: number }
  | { type: 'Float'; value: number }
  | { type: 'String'; value: string }
  | { type: 'Variable'; name: string }
  | { type: 'Array'; items: Value[] };

// ---------------------------------------------------------------------------
// Conditions & Predicates
// ---------------------------------------------------------------------------

export type ComparisonOp =
  | '='
  | '!='
  | '<>'
  | '<'
  | '>'
  | '<='
  | '>='
  | 'CONTAINS'
  | 'STARTS_WITH'
  | 'ENDS_WITH'
  | 'IN';

export type Condition =
  | {
      type: 'Simple';
      field: string;
      op: ComparisonOp;
      value: Value;
    }
  | {
      type: 'Group';
      logic: 'AND' | 'OR';
      conditions: Condition[];
    };

export type Predicate =
  | { type: 'Where'; conditions: Condition[] }
  | { type: 'Key'; field: string; value: Value }
  | { type: 'Like'; variable: string }
  | { type: 'Pattern'; variable: string; threshold?: number }
  | { type: 'All' };

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

export interface OrderBy {
  field: string;
  direction: 'ASC' | 'DESC';
}

export interface Window {
  type: 'LastN' | 'LastDuration' | 'TopNBy' | 'Since';
  n?: number;
  duration?: string;
  field?: string;
  condition?: Condition;
}

export interface WithLinks {
  filter?: 'All' | { type: string };
}

export interface FollowLinks {
  link_type: string;
  target_memory?: MemoryType;
  depth?: number;
}

export interface AggFunc {
  func: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
  field: string;
  alias: string;
}

export interface Modifiers {
  limit?: number;
  order_by?: OrderBy;
  return_fields?: string[];
  timeout?: string;
  min_confidence?: number;
  scope?: string;
  namespace?: string;
  ttl?: string;
  aggregate?: AggFunc[];
  having?: Condition[];
  with_links?: WithLinks;
  follow_links?: FollowLinks;
  window?: Window;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface RecallStmt {
  type: 'Recall';
  memory_type: MemoryType;
  predicate: Predicate;
  modifiers: Modifiers;
}

export interface ScanStmt {
  type: 'Scan';
  memory_type: 'Working';
  modifiers: Modifiers;
}

export interface LookupStmt {
  type: 'Lookup';
  memory_type: MemoryType;
  predicate: Predicate;
  modifiers: Modifiers;
}

export interface LoadStmt {
  type: 'Load';
  memory_type: 'Tools';
  predicate: Predicate;
  modifiers: Modifiers;
}

export interface StoreStmt {
  type: 'Store';
  memory_type: MemoryType;
  fields: Record<string, Value>;
  modifiers: Modifiers;
}

export interface UpdateStmt {
  type: 'Update';
  memory_type: MemoryType;
  fields: Record<string, Value>;
  predicate: Predicate;
  modifiers: Modifiers;
}

export interface ForgetStmt {
  type: 'Forget';
  memory_type: MemoryType;
  predicate: Predicate;
  modifiers: Modifiers;
}

export interface LinkStmt {
  type: 'Link';
  source_id: string;
  target_id: string;
  link_type: string;
  weight?: number;
}

export interface ReflectSource {
  memory_type: MemoryType;
  predicate: Predicate;
}

export interface ReflectStmt {
  type: 'Reflect';
  sources?: ReflectSource[];
  then_clause?: StoreStmt;
}

export interface PipelineStage {
  statement: Statement;
}

export interface PipelineStmt {
  type: 'Pipeline';
  name?: string;
  timeout?: string;
  stages: PipelineStage[];
}

export type Statement =
  | RecallStmt
  | ScanStmt
  | LookupStmt
  | LoadStmt
  | StoreStmt
  | UpdateStmt
  | ForgetStmt
  | LinkStmt
  | ReflectStmt
  | PipelineStmt;

// ---------------------------------------------------------------------------
// Query Result
// ---------------------------------------------------------------------------

export interface AqlLink {
  source_id: string;
  target_id: string;
  link_type: string;
  confidence: number;
}

export interface AqlQueryResult {
  success: boolean;
  statement: string;
  data: Record<string, unknown>[];
  count: number;
  timing_ms: number;
  error?: string;
  warnings?: string[];
  links?: AqlLink[];
  pipeline_stages?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/aql-types.test.ts`
Expected: PASS — all 6 assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/aql-types.ts tests/aql-types.test.ts
git commit -m "feat(aql): add TypeScript AST types mirroring Rust aql-parser"
```

---

## Task 2: WASM Parser Wrapper

Build the `aql-parser` WASM module from the AQL repo and create a thin wrapper that handles initialization, parsing, and error formatting.

**Prerequisite:** The AQL repo must be cloned and the WASM package built. This task handles the Engram-side integration.

**Files:**
- Create: `src/aql-parser.ts`
- Test: `tests/aql-parser.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Build the WASM parser package**

Clone AQL and build the WASM parser. We use Option B from the spec (reuse `clawdb-wasm`'s `parse()` export) to start immediately with zero AQL repo changes:

```bash
# Clone AQL repo as sibling to engram
cd G:/Projects/SIT
git clone https://github.com/srirammails/AQL.git aql

# Build WASM with Node.js target
cd aql/crates/clawdb-wasm
wasm-pack build --target nodejs --out-dir ../../../engram/vendor/aql-parser-wasm

# Verify output
ls ../../../engram/vendor/aql-parser-wasm/
# Expected: clawdb_wasm.js, clawdb_wasm_bg.wasm, clawdb_wasm.d.ts, package.json
```

- [ ] **Step 2: Add the WASM package as a local dependency**

Add to `package.json`:
```json
{
  "dependencies": {
    "aql-parser-wasm": "file:./vendor/aql-parser-wasm"
  }
}
```

Run: `npm install`

- [ ] **Step 3: Write the parser wrapper test**

```typescript
// tests/aql-parser.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { initAqlParser, parseAql, AqlParseError } from '../src/aql-parser.js';
import type { Statement } from '../src/aql-types.js';

describe('AQL Parser (WASM)', () => {
  beforeAll(async () => {
    await initAqlParser();
  });

  it('parses a RECALL statement', () => {
    const stmt = parseAql('RECALL FROM EPISODIC WHERE bid_id = "e-001" RETURN *');
    expect(stmt.type).toBe('Recall');
    if (stmt.type === 'Recall') {
      expect(stmt.memory_type).toBe('Episodic');
      expect(stmt.predicate.type).toBe('Where');
    }
  });

  it('parses a STORE statement', () => {
    const stmt = parseAql(
      'STORE INTO EPISODIC (event = "deploy", outcome = "success")',
    );
    expect(stmt.type).toBe('Store');
    if (stmt.type === 'Store') {
      expect(stmt.memory_type).toBe('Episodic');
      expect(stmt.fields).toHaveProperty('event');
    }
  });

  it('parses a SCAN statement', () => {
    const stmt = parseAql('SCAN FROM WORKING WINDOW LAST 5');
    expect(stmt.type).toBe('Scan');
  });

  it('parses a LINK statement', () => {
    const stmt = parseAql('LINK "abc" TO "xyz" TYPE "caused_by"');
    expect(stmt.type).toBe('Link');
    if (stmt.type === 'Link') {
      expect(stmt.link_type).toBe('caused_by');
    }
  });

  it('parses a PIPELINE statement', () => {
    const stmt = parseAql(
      'PIPELINE test TIMEOUT 30s RECALL FROM EPISODIC ALL THEN RECALL FROM SEMANTIC ALL',
    );
    expect(stmt.type).toBe('Pipeline');
    if (stmt.type === 'Pipeline') {
      expect(stmt.stages.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('throws AqlParseError on invalid syntax', () => {
    expect(() => parseAql('INVALID QUERY')).toThrow(AqlParseError);
  });

  it('throws AqlParseError on empty string', () => {
    expect(() => parseAql('')).toThrow(AqlParseError);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/aql-parser.test.ts`
Expected: FAIL — cannot resolve `../src/aql-parser.js`

- [ ] **Step 5: Implement the parser wrapper**

```typescript
// src/aql-parser.ts
// =============================================================================
// AQL Parser WASM Wrapper
// Thin wrapper around the aql-parser WASM module. Handles initialization,
// JSON deserialization, and error formatting.
// =============================================================================

import type { Statement } from './aql-types.js';

// The WASM module exports — loaded dynamically to avoid top-level await
let parseFn: ((query: string) => string) | null = null;

export class AqlParseError extends Error {
  constructor(
    message: string,
    public readonly query: string,
  ) {
    super(message);
    this.name = 'AqlParseError';
  }
}

/**
 * Initialize the WASM parser. Must be called once before parseAql().
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initAqlParser(): Promise<void> {
  if (parseFn) return;

  // clawdb-wasm exports parse() as a synchronous function after WASM init
  const wasm = await import('aql-parser-wasm');

  // wasm-pack --target nodejs auto-initializes, but if there's an init()
  // we call it to be safe
  if (typeof wasm.default === 'function') {
    await wasm.default();
  }

  if (typeof wasm.parse !== 'function') {
    throw new Error(
      'aql-parser-wasm does not export a parse() function. ' +
        'Ensure the WASM package was built with wasm-pack --target nodejs.',
    );
  }

  parseFn = wasm.parse;
}

/**
 * Parse an AQL query string into a typed AST Statement.
 * Requires initAqlParser() to have been called first.
 *
 * @throws {AqlParseError} on syntax errors or invalid queries
 * @throws {Error} if parser not initialized
 */
export function parseAql(query: string): Statement {
  if (!parseFn) {
    throw new Error('AQL parser not initialized. Call initAqlParser() first.');
  }

  const trimmed = query.trim();
  if (!trimmed) {
    throw new AqlParseError('Empty query', query);
  }

  const json = parseFn(trimmed);
  const result = JSON.parse(json);

  // The WASM parse() returns { Ok: ast } on success or { Err: message } on failure
  if (result.Err) {
    throw new AqlParseError(result.Err, query);
  }

  // Unwrap the Ok variant if present, otherwise assume the result IS the AST
  const ast = result.Ok ?? result;
  return ast as Statement;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/aql-parser.test.ts`
Expected: PASS — all 7 tests pass

Note: If the WASM parse output shape differs from expected (e.g., different field names, different Ok/Err wrapping), adjust `parseAql()` to match the actual output. Run `parseFn('RECALL FROM EPISODIC ALL')` and log the raw JSON to inspect the shape.

- [ ] **Step 7: Commit**

```bash
git add src/aql-parser.ts tests/aql-parser.test.ts vendor/aql-parser-wasm/ package.json package-lock.json
git commit -m "feat(aql): add WASM parser wrapper with init/parse/error handling"
```

---

## Task 3: Schema Changes — Tools Table and Observations Extension

Add the `tools` table and extend the `observations` table for direct AQL writes.

**Files:**
- Modify: `src/schema.sql`
- Test: `tests/aql.test.ts` (created here, expanded in later tasks)

- [ ] **Step 1: Write the schema test**

```typescript
// tests/aql.test.ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';

describe('AQL Schema', () => {
  it('tools table exists with expected columns', () => {
    const db = createTestDb();
    const columns = db.pragma('table_info(tools)') as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    expect(names).toContain('description');
    expect(names).toContain('api_url');
    expect(names).toContain('ranking');
    expect(names).toContain('tags');
    expect(names).toContain('namespace');
    expect(names).toContain('scope');
    expect(names).toContain('is_active');
    db.close();
  });

  it('observations table has data_json and source_type columns', () => {
    const db = createTestDb();
    const columns = db.pragma('table_info(observations)') as Array<{
      name: string;
    }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('data_json');
    expect(names).toContain('source_type');
    db.close();
  });

  it('tools table supports CRUD operations', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tools (id, name, description, api_url, ranking) VALUES (?, ?, ?, ?, ?)`,
    ).run('t-001', 'image_resize', 'Resize images', 'https://api.example.com/resize', 0.9);

    const row = db
      .prepare(`SELECT * FROM tools WHERE id = ?`)
      .get('t-001') as Record<string, unknown>;
    expect(row.name).toBe('image_resize');
    expect(row.ranking).toBe(0.9);
    expect(row.is_active).toBe(1); // SQLite boolean

    db.prepare(`UPDATE tools SET is_active = FALSE WHERE id = ?`).run('t-001');
    const updated = db
      .prepare(`SELECT is_active FROM tools WHERE id = ?`)
      .get('t-001') as { is_active: number };
    expect(updated.is_active).toBe(0);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql.test.ts`
Expected: FAIL — `tools` table does not exist

- [ ] **Step 3: Add tools table and observations extension to schema.sql**

Add before the VIEWS section in `src/schema.sql`:

```sql
-- =============================================================================
-- TOOLS REGISTRY
-- Ranked tool storage for AQL LOAD FROM TOOLS queries.
-- Agents store available tools with descriptions and rankings.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    api_url TEXT,
    ranking REAL DEFAULT 0.5
        CHECK (ranking >= 0.0 AND ranking <= 1.0),
    tags TEXT DEFAULT '[]',              -- JSON array of string tags
    namespace TEXT DEFAULT 'default',
    scope TEXT DEFAULT 'private',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_tools_ranking ON tools(ranking DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_tools_namespace ON tools(namespace) WHERE is_active = TRUE;
```

Add `data_json` and `source_type` columns to the `observations` table definition. Insert them after `topic`:

```sql
    topic TEXT,                         -- specific topic within domain
    data_json TEXT,                     -- flexible JSON for AQL STORE INTO PROCEDURAL
    source_type TEXT DEFAULT 'reflect'  -- 'reflect' (from reflect cycle) or 'agent_generated' (direct AQL STORE)
        CHECK (source_type IN ('reflect', 'agent_generated')),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/aql.test.ts`
Expected: PASS — all 3 schema tests pass

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass. The new columns have defaults so existing code is unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/schema.sql tests/aql.test.ts
git commit -m "feat(aql): add tools table and extend observations for AQL writes"
```

---

## Task 4: Memory Type Mapping

Create the bidirectional mapping between AQL memory types and Engram's storage model.

**Files:**
- Create: `src/aql-memory-map.ts`
- Test: `tests/aql-memory-map.test.ts`

- [ ] **Step 1: Write the mapping test**

```typescript
// tests/aql-memory-map.test.ts
import { describe, it, expect } from 'vitest';
import {
  aqlToEngramType,
  engramToAqlType,
  aqlTypeToTable,
} from '../src/aql-memory-map.js';

describe('AQL Memory Type Mapping', () => {
  it('maps AQL types to Engram memory_type values', () => {
    expect(aqlToEngramType('Episodic')).toBe('experience');
    expect(aqlToEngramType('Semantic')).toBe('world');
  });

  it('maps AQL PROCEDURAL to observations table', () => {
    expect(aqlTypeToTable('Procedural')).toBe('observations');
  });

  it('maps AQL WORKING to working_memory table', () => {
    expect(aqlTypeToTable('Working')).toBe('working_memory');
  });

  it('maps AQL TOOLS to tools table', () => {
    expect(aqlTypeToTable('Tools')).toBe('tools');
  });

  it('maps AQL EPISODIC and SEMANTIC to chunks table', () => {
    expect(aqlTypeToTable('Episodic')).toBe('chunks');
    expect(aqlTypeToTable('Semantic')).toBe('chunks');
  });

  it('reverse maps Engram types to AQL types', () => {
    expect(engramToAqlType('experience')).toBe('Episodic');
    expect(engramToAqlType('world')).toBe('Semantic');
    expect(engramToAqlType('observation')).toBe('Procedural');
    expect(engramToAqlType('opinion')).toBe('Procedural');
  });

  it('returns null for AQL ALL (no single engram type)', () => {
    expect(aqlToEngramType('All')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql-memory-map.test.ts`
Expected: FAIL — cannot resolve `../src/aql-memory-map.js`

- [ ] **Step 3: Implement the mapping module**

```typescript
// src/aql-memory-map.ts
// =============================================================================
// AQL ↔ Engram Memory Type Mapping
//
// AQL defines 5 memory types + ALL. Engram stores data across 3 tables:
//   - chunks (world, experience, observation, opinion — via memory_type column)
//   - observations (synthesized patterns — separate table)
//   - working_memory (session state — separate table)
//   - tools (tool registry — separate table)
//
// This module provides bidirectional mapping between the two models.
// =============================================================================

import type { MemoryType } from './aql-types.js';

type EngramMemoryType = 'world' | 'experience' | 'observation' | 'opinion';
type EngramTable = 'chunks' | 'observations' | 'working_memory' | 'tools';

/** Map an AQL memory type to Engram's chunk memory_type value. Returns null for types that don't map to chunks. */
export function aqlToEngramType(aql: MemoryType): EngramMemoryType | null {
  switch (aql) {
    case 'Episodic':
      return 'experience';
    case 'Semantic':
      return 'world';
    case 'Procedural':
      return null; // observations table, not chunks
    case 'Working':
      return null; // working_memory table
    case 'Tools':
      return null; // tools table
    case 'All':
      return null; // cross-memory, no single type
  }
}

/** Map an AQL memory type to the Engram table it queries. */
export function aqlTypeToTable(aql: MemoryType): EngramTable | 'all' {
  switch (aql) {
    case 'Episodic':
    case 'Semantic':
      return 'chunks';
    case 'Procedural':
      return 'observations';
    case 'Working':
      return 'working_memory';
    case 'Tools':
      return 'tools';
    case 'All':
      return 'all';
  }
}

/** Reverse map: Engram memory_type → AQL MemoryType. */
export function engramToAqlType(
  engram: EngramMemoryType,
): Exclude<MemoryType, 'All'> {
  switch (engram) {
    case 'experience':
      return 'Episodic';
    case 'world':
      return 'Semantic';
    case 'observation':
    case 'opinion':
      return 'Procedural';
  }
}

/** All Engram chunk memory_type values (for ALL queries). */
export const ALL_CHUNK_TYPES: EngramMemoryType[] = [
  'world',
  'experience',
  'observation',
  'opinion',
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/aql-memory-map.test.ts`
Expected: PASS — all 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/aql-memory-map.ts tests/aql-memory-map.test.ts
git commit -m "feat(aql): add bidirectional AQL ↔ Engram memory type mapping"
```

---

## Task 5: Core Translator — RECALL, LOOKUP, SCAN

The translator converts parsed AST statements into Engram API calls. Start with the three read operations.

**Files:**
- Create: `src/aql.ts`
- Test: append to `tests/aql.test.ts`

- [ ] **Step 1: Write failing tests for RECALL translation**

Append to `tests/aql.test.ts`:

```typescript
import { Engram } from '../src/engram.js';
import { MockEmbedder, MockGenerator, tmpDbPath, cleanupDb } from './helpers.js';

describe('AQL Translator — RECALL', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });

    // Seed data
    await engram.retain('The sky is blue', {
      memoryType: 'world',
      context: 'science',
      trustScore: 0.9,
      sourceType: 'user_stated',
    });
    await engram.retain('Deployed v2 successfully', {
      memoryType: 'experience',
      context: 'ops',
      trustScore: 0.8,
      sourceType: 'agent_generated',
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('RECALL FROM SEMANTIC ALL returns world chunks', async () => {
    const result = await engram.query('RECALL FROM SEMANTIC ALL');
    expect(result.success).toBe(true);
    expect(result.statement).toBe('Recall');
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it('RECALL FROM EPISODIC ALL returns experience chunks', async () => {
    const result = await engram.query('RECALL FROM EPISODIC ALL');
    expect(result.success).toBe(true);
    expect(result.data.some((d) => (d.text as string).includes('Deployed'))).toBe(true);
  });

  it('RECALL with WHERE context filter works', async () => {
    const result = await engram.query(
      'RECALL FROM SEMANTIC WHERE context = "science" RETURN *',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it('RECALL with LIMIT restricts results', async () => {
    const result = await engram.query(
      'RECALL FROM SEMANTIC ALL LIMIT 1',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBeLessThanOrEqual(1);
  });

  it('RECALL returns error result on parse failure', async () => {
    const result = await engram.query('NOT A VALID QUERY');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('AQL Translator — LOOKUP', () => {
  let engram: Engram;
  let dbPath: string;
  let seededId: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    const result = await engram.retain('Test fact', {
      memoryType: 'world',
      trustScore: 0.7,
    });
    seededId = result.chunkId;
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('LOOKUP by ID returns exact match', async () => {
    const result = await engram.query(
      `LOOKUP FROM SEMANTIC KEY id = "${seededId}"`,
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.data[0].id).toBe(seededId);
  });

  it('LOOKUP with non-existent ID returns empty', async () => {
    const result = await engram.query(
      'LOOKUP FROM SEMANTIC KEY id = "nonexistent"',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });
});

describe('AQL Translator — SCAN', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    // Create working memory sessions
    await engram.inferWorkingSession('Planning the deployment');
    await engram.inferWorkingSession('Reviewing code changes');
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('SCAN FROM WORKING returns active sessions', async () => {
    const result = await engram.query('SCAN FROM WORKING WINDOW LAST 5');
    expect(result.success).toBe(true);
    expect(result.statement).toBe('Scan');
    expect(result.count).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql.test.ts`
Expected: FAIL — `engram.query` is not a function

- [ ] **Step 3: Implement the translator module**

```typescript
// src/aql.ts
// =============================================================================
// AQL-to-Engram Translator
//
// Converts parsed AQL AST statements into Engram API calls. Each statement
// type has a dedicated handler that maps AQL semantics to Engram operations.
//
// Read operations (RECALL, LOOKUP, SCAN, LOAD) → engram.recall() or direct SQL
// Write operations (STORE, UPDATE, FORGET) → engram.retain() / supersede / forget
// Structure operations (LINK, REFLECT, PIPELINE) → direct SQL / engram.reflect()
// =============================================================================

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Engram } from './engram.js';
import type { RecallOptions, RecallResponse } from './recall.js';
import type { RetainOptions } from './retain.js';
import {
  type Statement,
  type AqlQueryResult,
  type Predicate,
  type Modifiers,
  type Value,
  type Condition,
  type MemoryType,
} from './aql-types.js';
import { aqlToEngramType, aqlTypeToTable } from './aql-memory-map.js';
import { parseAql, AqlParseError } from './aql-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve an AQL Value to a JS primitive. */
function resolveValue(
  val: Value,
  vars?: Record<string, unknown>,
): unknown {
  switch (val.type) {
    case 'Null':
      return null;
    case 'Bool':
      return val.value;
    case 'Int':
    case 'Float':
      return val.value;
    case 'String':
      return val.value;
    case 'Variable':
      return vars?.[val.name] ?? null;
    case 'Array':
      return val.items.map((i) => resolveValue(i, vars));
  }
}

/** Extract a semantic query string from a WHERE predicate's content fields. */
function inferQueryFromPredicate(predicate: Predicate): string | null {
  if (predicate.type !== 'Where') return null;

  for (const cond of predicate.conditions) {
    if (cond.type === 'Simple' && cond.op === '=') {
      // Content-bearing fields become the semantic query
      const contentFields = new Set([
        'concept',
        'event',
        'text',
        'summary',
        'description',
        'belief',
        'query',
        'topic',
      ]);
      if (contentFields.has(cond.field)) {
        const val = resolveValue(cond.value);
        if (typeof val === 'string') return val;
      }
    }
  }
  return null;
}

/** Map simple WHERE conditions to RecallOptions filters. */
function predicateToRecallOptions(
  predicate: Predicate,
  modifiers: Modifiers,
  memoryType: MemoryType,
  vars?: Record<string, unknown>,
): { query: string; options: RecallOptions } {
  const engramType = aqlToEngramType(memoryType);
  const options: RecallOptions = {};

  if (engramType) {
    options.memoryTypes = [engramType];
  }

  // Modifiers
  if (modifiers.limit) options.topK = modifiers.limit;
  if (modifiers.min_confidence) options.minTrust = modifiers.min_confidence;

  // Window modifier
  if (modifiers.window) {
    const w = modifiers.window;
    if (w.type === 'LastN' && w.n) options.topK = w.n;
    if (w.type === 'LastDuration' && w.duration) {
      options.after = parseDurationToISO(w.duration);
    }
  }

  // Default query from predicate content
  let query = '*';

  if (predicate.type === 'All') {
    // No filters — return everything up to topK
    query = '*';
  } else if (predicate.type === 'Where') {
    // Extract filters from conditions
    for (const cond of predicate.conditions) {
      if (cond.type !== 'Simple') continue;
      const val = resolveValue(cond.value, vars);

      switch (cond.field) {
        case 'context':
          if (typeof val === 'string') options.contextFilter = val;
          break;
        case 'source':
          if (typeof val === 'string') options.sourceFilter = val;
          break;
        case 'trust_score':
          if (typeof val === 'number') options.minTrust = val;
          break;
      }
    }

    // Try to infer a semantic query from content fields
    const inferred = inferQueryFromPredicate(predicate);
    if (inferred) query = inferred;
  }

  // Unsupported modifiers → warnings collected by caller
  return { query, options };
}

/** Parse an AQL duration string (e.g., "24h", "30s") to an ISO date string. */
function parseDurationToISO(duration: string): string {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return new Date().toISOString();

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();

  const msMap: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return new Date(now - amount * msMap[unit]).toISOString();
}

/** Collect warnings for unsupported modifiers. */
function collectWarnings(modifiers: Modifiers): string[] {
  const warnings: string[] = [];
  if (modifiers.scope) warnings.push('SCOPE modifier ignored (not yet supported)');
  if (modifiers.namespace) warnings.push('NAMESPACE modifier ignored (not yet supported)');
  if (modifiers.ttl) warnings.push('TTL modifier ignored (not yet supported)');
  if (modifiers.aggregate?.length) warnings.push('AGGREGATE deferred to Phase 2');
  if (modifiers.having?.length) warnings.push('HAVING deferred to Phase 2');
  return warnings;
}

/** Filter result fields based on RETURN clause. */
function applyReturnFields(
  data: Record<string, unknown>[],
  returnFields?: string[],
): Record<string, unknown>[] {
  if (!returnFields || returnFields.length === 0 || returnFields.includes('*'))
    return data;
  return data.map((row) => {
    const filtered: Record<string, unknown> = {};
    for (const field of returnFields) {
      if (field in row) filtered[field] = row[field];
    }
    return filtered;
  });
}

// ---------------------------------------------------------------------------
// Statement Handlers
// ---------------------------------------------------------------------------

/** Execute a RECALL statement via engram.recall(). */
async function executeRecall(
  engram: Engram,
  stmt: Extract<Statement, { type: 'Recall' }>,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const warnings = collectWarnings(stmt.modifiers);
  const { query, options } = predicateToRecallOptions(
    stmt.predicate,
    stmt.modifiers,
    stmt.memory_type,
    vars,
  );

  const response = await engram.recall(query, options);
  let data = response.results.map((r) => ({
    id: r.id,
    text: r.text,
    trust_score: r.trustScore,
    source: r.source,
    source_type: r.sourceType,
    context: r.context,
    memory_type: r.memoryType,
    created_at: r.createdAt,
    score: r.score,
  }));

  data = applyReturnFields(data, stmt.modifiers.return_fields);

  return {
    success: true,
    statement: 'Recall',
    data,
    count: data.length,
    timing_ms: 0, // populated by caller
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Execute a LOOKUP statement via direct SQLite query. */
async function executeLookup(
  engram: Engram,
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Lookup' }>,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const warnings = collectWarnings(stmt.modifiers);
  const table = aqlTypeToTable(stmt.memory_type);
  const engramType = aqlToEngramType(stmt.memory_type);

  if (stmt.predicate.type !== 'Key') {
    return {
      success: false,
      statement: 'Lookup',
      data: [],
      count: 0,
      timing_ms: 0,
      error: 'LOOKUP requires a KEY predicate',
    };
  }

  const keyField = stmt.predicate.field;
  const keyValue = resolveValue(stmt.predicate.value, vars);

  let rows: Record<string, unknown>[];

  if (table === 'chunks') {
    const conditions = [`${keyField} = ?`, 'is_active = TRUE'];
    const params: unknown[] = [keyValue];
    if (engramType) {
      conditions.push('memory_type = ?');
      params.push(engramType);
    }
    rows = db
      .prepare(`SELECT * FROM chunks WHERE ${conditions.join(' AND ')}`)
      .all(...params) as Record<string, unknown>[];
  } else if (table === 'tools') {
    rows = db
      .prepare(`SELECT * FROM tools WHERE ${keyField} = ? AND is_active = TRUE`)
      .all(keyValue) as Record<string, unknown>[];
  } else if (table === 'observations') {
    rows = db
      .prepare(
        `SELECT * FROM observations WHERE ${keyField} = ? AND is_active = TRUE`,
      )
      .all(keyValue) as Record<string, unknown>[];
  } else {
    rows = db
      .prepare(`SELECT * FROM working_memory WHERE ${keyField} = ?`)
      .all(keyValue) as Record<string, unknown>[];
  }

  const data = applyReturnFields(rows, stmt.modifiers.return_fields);

  return {
    success: true,
    statement: 'Lookup',
    data,
    count: data.length,
    timing_ms: 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Execute a SCAN statement against working_memory. */
async function executeScan(
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Scan' }>,
): Promise<AqlQueryResult> {
  const warnings = collectWarnings(stmt.modifiers);
  let limit = 10;
  let afterDate: string | null = null;

  if (stmt.modifiers.window) {
    const w = stmt.modifiers.window;
    if (w.type === 'LastN' && w.n) limit = w.n;
    if (w.type === 'LastDuration' && w.duration) {
      afterDate = parseDurationToISO(w.duration);
    }
  }
  if (stmt.modifiers.limit) limit = stmt.modifiers.limit;

  let query = `SELECT * FROM working_memory WHERE expires_at IS NULL`;
  const params: unknown[] = [];

  if (afterDate) {
    query += ` AND updated_at > ?`;
    params.push(afterDate);
  }

  query += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

  // Parse data_json for each row
  const data = rows.map((row) => ({
    ...row,
    data: row.data_json ? JSON.parse(row.data_json as string) : {},
  }));

  return {
    success: true,
    statement: 'Scan',
    data: applyReturnFields(data, stmt.modifiers.return_fields),
    count: data.length,
    timing_ms: 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute an AQL query against an Engram instance.
 * Parses the query, dispatches to the appropriate handler, and returns
 * a structured result.
 */
export async function executeAql(
  engram: Engram,
  db: Database.Database,
  aql: string,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const start = performance.now();

  let stmt: Statement;
  try {
    stmt = parseAql(aql);
  } catch (err) {
    return {
      success: false,
      statement: 'Unknown',
      data: [],
      count: 0,
      timing_ms: performance.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let result: AqlQueryResult;

  switch (stmt.type) {
    case 'Recall':
      result = await executeRecall(engram, stmt, vars);
      break;
    case 'Lookup':
      result = await executeLookup(engram, db, stmt, vars);
      break;
    case 'Scan':
      result = await executeScan(db, stmt);
      break;
    default:
      result = {
        success: false,
        statement: stmt.type,
        data: [],
        count: 0,
        timing_ms: 0,
        error: `Statement type '${stmt.type}' not yet implemented`,
      };
  }

  result.timing_ms = performance.now() - start;
  return result;
}
```

- [ ] **Step 4: Add the `query()` method to the Engram class**

In `src/engram.ts`, add the import and method:

Add near the top imports:
```typescript
import { initAqlParser } from './aql-parser.js';
import { executeAql } from './aql.js';
import type { AqlQueryResult } from './aql-types.js';
```

Add re-export:
```typescript
export type { AqlQueryResult };
```

In the `Engram.init()` method, after the embedding provider setup and before `return new Engram(...)`, add:
```typescript
    // Initialize AQL parser (WASM) — loaded once, cached for instance lifetime
    try {
      await initAqlParser();
    } catch {
      // AQL parser unavailable — engram.query() will return errors
      // This is non-fatal: retain/recall/reflect still work without AQL
    }
```

Add the `query()` method to the Engram class, after the `recall()` method:
```typescript
  /**
   * Execute an AQL (Agent Query Language) query against this engram.
   * Parses the query string, translates the AST to Engram operations,
   * and returns a structured result.
   *
   * @param aql - AQL query string (e.g., 'RECALL FROM SEMANTIC ALL LIMIT 5')
   * @param vars - Optional variables for parameterized queries
   */
  async query(
    aql: string,
    vars?: Record<string, unknown>,
  ): Promise<AqlQueryResult> {
    return executeAql(this, this.db, aql, vars);
  }

  /** Expose the internal DB handle for AQL translator direct queries. */
  get database(): Database.Database {
    return this.db;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/aql.test.ts`
Expected: PASS — all RECALL, LOOKUP, and SCAN tests pass

- [ ] **Step 6: Run all tests to check for regressions**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/aql.ts src/engram.ts tests/aql.test.ts
git commit -m "feat(aql): implement RECALL, LOOKUP, SCAN statement translation"
```

---

## Task 6: Direct SQL Query Path — Compound WHERE and Comparison Operators

When AQL queries use compound WHERE, comparison operators (`>`, `CONTAINS`, `IN`, etc.), or reference JSON-stored fields, the translator bypasses `engram.recall()` and queries SQLite directly for deterministic results.

**Files:**
- Create: `src/aql-sql.ts`
- Test: `tests/aql-sql.test.ts`

- [ ] **Step 1: Write failing tests for compound WHERE and comparison operators**

```typescript
// tests/aql-sql.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Engram } from '../src/engram.js';
import { MockEmbedder, MockGenerator, tmpDbPath, cleanupDb } from './helpers.js';

describe('AQL Direct SQL — Compound WHERE', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    // Seed data with JSON-structured text
    await engram.retain(
      JSON.stringify({ event: 'deploy', outcome: 'success', confidence: 0.9 }),
      { memoryType: 'experience', context: 'ops', trustScore: 0.9 },
    );
    await engram.retain(
      JSON.stringify({ event: 'deploy', outcome: 'failure', confidence: 0.3 }),
      { memoryType: 'experience', context: 'ops', trustScore: 0.7 },
    );
    await engram.retain(
      JSON.stringify({ event: 'test', outcome: 'success', confidence: 0.8 }),
      { memoryType: 'experience', context: 'ci', trustScore: 0.8 },
    );
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('WHERE with > operator filters by threshold', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC WHERE trust_score > 0.75',
    );
    expect(result.success).toBe(true);
    // Should match the 0.9 and 0.8 trust scores
    expect(result.count).toBe(2);
  });

  it('WHERE with AND combines conditions', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC WHERE context = "ops" AND trust_score > 0.8',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it('WHERE with CONTAINS matches substring', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC WHERE text CONTAINS "success"',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
  });

  it('WHERE with OR provides alternatives', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC WHERE context = "ops" OR context = "ci"',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
  });

  it('ORDER BY with direct column works', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC ALL ORDER BY trust_score DESC LIMIT 2',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    // Highest trust first
    const scores = result.data.map((d) => d.trust_score as number);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql-sql.test.ts`
Expected: FAIL — compound WHERE and comparison operators not handled

- [ ] **Step 3: Implement the direct SQL query builder**

```typescript
// src/aql-sql.ts
// =============================================================================
// AQL Direct SQL Query Builder
//
// Translates AQL predicates and modifiers to SQLite queries for structured
// access. Used when AQL queries include compound WHERE, comparison operators,
// ORDER BY, or AGGREGATE — features that can't be expressed through
// Engram's RecallOptions (which is semantic-search-oriented).
//
// This is a READ-ONLY path. Writes always go through Engram's retain pipeline.
// =============================================================================

import Database from 'better-sqlite3';
import type {
  Condition,
  Modifiers,
  Predicate,
  Value,
  MemoryType,
  AqlQueryResult,
} from './aql-types.js';
import { aqlToEngramType, aqlTypeToTable } from './aql-memory-map.js';

// ---------------------------------------------------------------------------
// Known columns on each table (direct SQL access, no json_extract needed)
// ---------------------------------------------------------------------------

const CHUNK_COLUMNS = new Set([
  'id',
  'text',
  'memory_type',
  'source',
  'source_uri',
  'context',
  'source_type',
  'trust_score',
  'event_time',
  'event_time_end',
  'temporal_label',
  'text_hash',
  'created_at',
  'updated_at',
  'reflected_at',
  'is_active',
  'verified_by_user',
]);

const TOOL_COLUMNS = new Set([
  'id',
  'name',
  'description',
  'api_url',
  'ranking',
  'tags',
  'namespace',
  'scope',
  'created_at',
  'updated_at',
  'is_active',
]);

const OBS_COLUMNS = new Set([
  'id',
  'summary',
  'domain',
  'topic',
  'data_json',
  'source_type',
  'synthesized_at',
  'is_active',
]);

/** Resolve a field reference to a SQL expression. */
function fieldToSql(field: string, table: string): string {
  const knownCols =
    table === 'chunks'
      ? CHUNK_COLUMNS
      : table === 'tools'
        ? TOOL_COLUMNS
        : table === 'observations'
          ? OBS_COLUMNS
          : CHUNK_COLUMNS;

  if (knownCols.has(field)) return field;

  // JSON field extraction from text column (chunks store STORE fields as JSON)
  if (table === 'chunks') return `json_extract(text, '$.${field}')`;
  if (table === 'observations') return `json_extract(data_json, '$.${field}')`;
  return field;
}

/** Resolve an AQL Value to a SQL-bindable parameter. */
function valueToParam(val: Value, vars?: Record<string, unknown>): unknown {
  switch (val.type) {
    case 'Null':
      return null;
    case 'Bool':
      return val.value ? 1 : 0;
    case 'Int':
    case 'Float':
      return val.value;
    case 'String':
      return val.value;
    case 'Variable':
      return vars?.[val.name] ?? null;
    case 'Array':
      return val.items.map((i) => valueToParam(i, vars));
  }
}

/** Translate an AQL Condition to a SQL WHERE clause fragment. */
function conditionToSql(
  cond: Condition,
  table: string,
  params: unknown[],
  vars?: Record<string, unknown>,
): string {
  if (cond.type === 'Group') {
    const parts = cond.conditions.map((c) =>
      conditionToSql(c, table, params, vars),
    );
    const joined = parts.join(` ${cond.logic} `);
    return `(${joined})`;
  }

  // Simple condition
  const field = fieldToSql(cond.field, table);
  const val = valueToParam(cond.value, vars);

  switch (cond.op) {
    case '=':
    case '!=':
    case '<>':
    case '<':
    case '>':
    case '<=':
    case '>=':
      params.push(val);
      return `${field} ${cond.op} ?`;
    case 'CONTAINS':
      params.push(`%${val}%`);
      return `${field} LIKE ?`;
    case 'STARTS_WITH':
      params.push(`${val}%`);
      return `${field} LIKE ?`;
    case 'ENDS_WITH':
      params.push(`%${val}`);
      return `${field} LIKE ?`;
    case 'IN': {
      if (Array.isArray(val)) {
        const placeholders = val.map(() => '?').join(', ');
        params.push(...val);
        return `${field} IN (${placeholders})`;
      }
      params.push(val);
      return `${field} = ?`;
    }
    default:
      params.push(val);
      return `${field} = ?`;
  }
}

/**
 * Determine if a query needs the direct SQL path (vs engram.recall).
 * Returns true if the query has features RecallOptions can't express.
 */
export function needsDirectSql(predicate: Predicate, modifiers: Modifiers): boolean {
  // AGGREGATE always needs direct SQL
  if (modifiers.aggregate && modifiers.aggregate.length > 0) return true;

  // HAVING always needs direct SQL
  if (modifiers.having && modifiers.having.length > 0) return true;

  // ORDER BY needs direct SQL (RecallOptions uses RRF ranking)
  if (modifiers.order_by) return true;

  if (predicate.type !== 'Where') return false;

  for (const cond of predicate.conditions) {
    // Group conditions (AND/OR with nesting) need direct SQL
    if (cond.type === 'Group') return true;

    // Non-equality operators need direct SQL
    if (
      cond.type === 'Simple' &&
      cond.op !== '=' &&
      // These equality filters map to RecallOptions
      !['context', 'source'].includes(cond.field)
    ) {
      return true;
    }

    // Fields that don't map to RecallOptions need direct SQL
    if (
      cond.type === 'Simple' &&
      cond.op === '=' &&
      !['context', 'source', 'trust_score', 'memory_type'].includes(cond.field)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Execute a structured AQL RECALL query directly against SQLite.
 * Used when the query has compound WHERE, comparison operators, ORDER BY,
 * or AGGREGATE that can't be expressed through RecallOptions.
 */
export function executeDirectSql(
  db: Database.Database,
  memoryType: MemoryType,
  predicate: Predicate,
  modifiers: Modifiers,
  vars?: Record<string, unknown>,
): AqlQueryResult {
  const table = aqlTypeToTable(memoryType);
  if (table === 'all') {
    // For ALL, query chunks table (covers most data)
    return executeDirectSqlForTable(db, 'chunks', null, predicate, modifiers, vars);
  }
  const engramType = aqlToEngramType(memoryType);
  return executeDirectSqlForTable(db, table, engramType, predicate, modifiers, vars);
}

function executeDirectSqlForTable(
  db: Database.Database,
  table: string,
  engramType: string | null,
  predicate: Predicate,
  modifiers: Modifiers,
  vars?: Record<string, unknown>,
): AqlQueryResult {
  const params: unknown[] = [];
  const warnings: string[] = [];
  const baseConditions: string[] = [];

  // Table-specific base conditions
  if (table === 'chunks') {
    baseConditions.push('is_active = TRUE');
    if (engramType) {
      baseConditions.push('memory_type = ?');
      params.push(engramType);
    }
  } else if (table === 'tools' || table === 'observations') {
    baseConditions.push('is_active = TRUE');
  }

  // Predicate conditions
  if (predicate.type === 'Where') {
    for (const cond of predicate.conditions) {
      baseConditions.push(conditionToSql(cond, table, params, vars));
    }
  }

  const whereClause =
    baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : '';

  // Check for AGGREGATE
  if (modifiers.aggregate && modifiers.aggregate.length > 0) {
    const selectParts = modifiers.aggregate.map((agg) => {
      const field =
        agg.field === '*' ? '*' : fieldToSql(agg.field, table);
      return `${agg.func}(${field}) AS ${agg.alias}`;
    });

    let sql = `SELECT ${selectParts.join(', ')} FROM ${table} ${whereClause}`;

    if (modifiers.having && modifiers.having.length > 0) {
      const havingParts = modifiers.having.map((cond) =>
        conditionToSql(cond, table, params, vars),
      );
      sql += ` HAVING ${havingParts.join(' AND ')}`;
    }

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

    return {
      success: true,
      statement: 'Recall',
      data: rows,
      count: rows.length,
      timing_ms: 0,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Standard SELECT with ORDER BY and LIMIT
  let sql = `SELECT * FROM ${table} ${whereClause}`;

  if (modifiers.order_by) {
    const orderField = fieldToSql(modifiers.order_by.field, table);
    sql += ` ORDER BY ${orderField} ${modifiers.order_by.direction}`;
  } else {
    sql += ` ORDER BY created_at DESC`;
  }

  if (modifiers.limit) {
    sql += ` LIMIT ?`;
    params.push(modifiers.limit);
  } else {
    sql += ` LIMIT 100`; // safety cap
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  // Apply RETURN field filtering
  let data = rows;
  if (
    modifiers.return_fields &&
    modifiers.return_fields.length > 0 &&
    !modifiers.return_fields.includes('*')
  ) {
    data = rows.map((row) => {
      const filtered: Record<string, unknown> = {};
      for (const field of modifiers.return_fields!) {
        if (field in row) {
          filtered[field] = row[field];
        } else {
          // Try JSON extraction for non-column fields
          try {
            const val = db
              .prepare(
                `SELECT json_extract(?, '$.${field}') as val`,
              )
              .get(row.text as string) as { val: unknown } | undefined;
            if (val?.val !== undefined) filtered[field] = val.val;
          } catch {
            // field not in JSON either
          }
        }
      }
      return filtered;
    });
  }

  return {
    success: true,
    statement: 'Recall',
    data,
    count: data.length,
    timing_ms: 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
```

- [ ] **Step 4: Wire direct SQL path into the RECALL handler in `src/aql.ts`**

At the top of `executeRecall` in `src/aql.ts`, add the direct SQL check:

```typescript
import { needsDirectSql, executeDirectSql } from './aql-sql.js';
```

Then at the start of `executeRecall`, before the existing `predicateToRecallOptions` call:

```typescript
  // Check if this query needs the direct SQL path
  if (needsDirectSql(stmt.predicate, stmt.modifiers)) {
    const result = executeDirectSql(
      db,
      stmt.memory_type,
      stmt.predicate,
      stmt.modifiers,
      vars,
    );
    result.warnings = [
      ...(result.warnings ?? []),
      ...collectWarnings(stmt.modifiers),
    ].filter(Boolean);
    if (result.warnings.length === 0) result.warnings = undefined;
    return result;
  }
```

Update `executeRecall` signature to accept `db`:

```typescript
async function executeRecall(
  engram: Engram,
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Recall' }>,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
```

And update the call in `executeAql`:

```typescript
    case 'Recall':
      result = await executeRecall(engram, db, stmt, vars);
      break;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/aql-sql.test.ts`
Expected: PASS — all 5 compound WHERE tests pass

- [ ] **Step 6: Run all tests to check for regressions**

Run: `npx vitest run`
Expected: All tests pass. Simple RECALL queries still use `engram.recall()` path.

- [ ] **Step 7: Commit**

```bash
git add src/aql-sql.ts src/aql.ts tests/aql-sql.test.ts
git commit -m "feat(aql): add direct SQL query path for compound WHERE and comparison operators"
```

---

## Task 7: ORDER BY and AGGREGATE

Add ORDER BY for deterministic result ordering and AGGREGATE for agent self-assessment queries.

**Files:**
- Modify: `src/aql-sql.ts` (already handles these — this task adds focused tests)
- Test: append to `tests/aql-sql.test.ts`

- [ ] **Step 1: Write failing tests for ORDER BY and AGGREGATE**

Append to `tests/aql-sql.test.ts`:

```typescript
describe('AQL Direct SQL — ORDER BY', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    await engram.retain('Event A', {
      memoryType: 'experience',
      trustScore: 0.5,
    });
    await engram.retain('Event B', {
      memoryType: 'experience',
      trustScore: 0.9,
    });
    await engram.retain('Event C', {
      memoryType: 'experience',
      trustScore: 0.7,
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('ORDER BY trust_score DESC returns highest first', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC ALL ORDER BY trust_score DESC',
    );
    expect(result.success).toBe(true);
    const scores = result.data.map((d) => d.trust_score as number);
    expect(scores[0]).toBe(0.9);
    expect(scores[scores.length - 1]).toBe(0.5);
  });

  it('ORDER BY trust_score ASC returns lowest first', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC ALL ORDER BY trust_score ASC',
    );
    expect(result.success).toBe(true);
    const scores = result.data.map((d) => d.trust_score as number);
    expect(scores[0]).toBe(0.5);
  });

  it('ORDER BY with LIMIT returns top N', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC ALL ORDER BY trust_score DESC LIMIT 2',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect((result.data[0].trust_score as number)).toBe(0.9);
  });
});

describe('AQL Direct SQL — AGGREGATE', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    await engram.retain('Deploy 1', {
      memoryType: 'experience',
      context: 'ops',
      trustScore: 0.9,
    });
    await engram.retain('Deploy 2', {
      memoryType: 'experience',
      context: 'ops',
      trustScore: 0.7,
    });
    await engram.retain('Test run', {
      memoryType: 'experience',
      context: 'ci',
      trustScore: 0.8,
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('COUNT(*) returns total matching records', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC ALL AGGREGATE COUNT(*) AS total',
    );
    expect(result.success).toBe(true);
    expect(result.data[0].total).toBe(3);
  });

  it('COUNT with WHERE filters before counting', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC WHERE context = "ops" AGGREGATE COUNT(*) AS total',
    );
    expect(result.success).toBe(true);
    expect(result.data[0].total).toBe(2);
  });

  it('AVG computes average', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC ALL AGGREGATE AVG(trust_score) AS avg_trust',
    );
    expect(result.success).toBe(true);
    const avg = result.data[0].avg_trust as number;
    expect(avg).toBeCloseTo(0.8, 1);
  });

  it('MIN and MAX work correctly', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC ALL AGGREGATE MIN(trust_score) AS min_trust, MAX(trust_score) AS max_trust',
    );
    expect(result.success).toBe(true);
    expect(result.data[0].min_trust).toBe(0.7);
    expect(result.data[0].max_trust).toBe(0.9);
  });

  it('HAVING filters aggregate results', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC WHERE context = "ops" AGGREGATE AVG(trust_score) AS avg_trust HAVING avg_trust > 0.75',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect((result.data[0].avg_trust as number)).toBeGreaterThan(0.75);
  });

  it('HAVING filters out non-matching aggregates', async () => {
    const result = await engram.query(
      'RECALL FROM EPISODIC WHERE context = "ops" AGGREGATE AVG(trust_score) AS avg_trust HAVING avg_trust > 0.95',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (or fails if SQL builder needs tweaks)**

Run: `npx vitest run tests/aql-sql.test.ts`
Expected: These should pass since `aql-sql.ts` (Task 6) already handles ORDER BY and AGGREGATE. If any fail, adjust the SQL builder.

- [ ] **Step 3: Fix any issues found during testing**

If `HAVING` doesn't work because `conditionToSql` uses column names but HAVING references aliases: adjust the HAVING clause to use alias names directly (they don't need `fieldToSql` resolution since they're computed names).

- [ ] **Step 4: Commit**

```bash
git add tests/aql-sql.test.ts src/aql-sql.ts
git commit -m "test(aql): add ORDER BY and AGGREGATE tests, fix edge cases"
```

---

## Task 8: Write Operations — STORE, UPDATE, FORGET

Add handlers for the three write operations.

**Files:**
- Modify: `src/aql.ts`
- Test: append to `tests/aql.test.ts`

- [ ] **Step 1: Write failing tests for write operations**

Append to `tests/aql.test.ts`:

```typescript
describe('AQL Translator — STORE', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('STORE INTO EPISODIC creates a chunk', async () => {
    const result = await engram.query(
      'STORE INTO EPISODIC (event = "deploy", outcome = "success")',
    );
    expect(result.success).toBe(true);
    expect(result.statement).toBe('Store');
    expect(result.count).toBe(1);
    expect(result.data[0].id).toBeDefined();

    // Verify it's retrievable
    const recall = await engram.query('RECALL FROM EPISODIC ALL');
    expect(recall.count).toBeGreaterThanOrEqual(1);
  });

  it('STORE INTO SEMANTIC creates a world chunk', async () => {
    const result = await engram.query(
      'STORE INTO SEMANTIC (concept = "gravity", description = "force of attraction")',
    );
    expect(result.success).toBe(true);

    const recall = await engram.query('RECALL FROM SEMANTIC ALL');
    expect(recall.count).toBeGreaterThanOrEqual(1);
  });

  it('STORE INTO TOOLS creates a tool record', async () => {
    const result = await engram.query(
      'STORE INTO TOOLS (name = "image_resize", api_url = "https://api.example.com", ranking = 0.9)',
    );
    expect(result.success).toBe(true);

    // Verify via direct SQL
    const row = engram.database
      .prepare('SELECT * FROM tools WHERE name = ?')
      .get('image_resize') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.ranking).toBe(0.9);
  });

  it('STORE INTO PROCEDURAL creates an observation', async () => {
    const result = await engram.query(
      'STORE INTO PROCEDURAL (summary = "Deploy on Fridays fails", domain = "ops")',
    );
    expect(result.success).toBe(true);

    const row = engram.database
      .prepare('SELECT * FROM observations WHERE domain = ?')
      .get('ops') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.source_type).toBe('agent_generated');
  });
});

describe('AQL Translator — UPDATE', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    await engram.retain('Deploy v1 succeeded', {
      memoryType: 'experience',
      context: 'ops',
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('UPDATE supersedes matching chunks', async () => {
    const result = await engram.query(
      'UPDATE EPISODIC SET outcome = "rollback" WHERE context = "ops"',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });
});

describe('AQL Translator — FORGET', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    await engram.retain('Temp fact', {
      memoryType: 'world',
      context: 'test',
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('FORGET deactivates matching chunks', async () => {
    const result = await engram.query(
      'FORGET FROM SEMANTIC WHERE context = "test"',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);

    // Verify it's gone from recall
    const recall = await engram.query('RECALL FROM SEMANTIC WHERE context = "test"');
    expect(recall.count).toBe(0);
  });

  it('FORGET is idempotent', async () => {
    await engram.query('FORGET FROM SEMANTIC WHERE context = "test"');
    const result = await engram.query('FORGET FROM SEMANTIC WHERE context = "test"');
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql.test.ts`
Expected: FAIL — Store/Update/Forget not yet implemented

- [ ] **Step 3: Add STORE handler to `src/aql.ts`**

Add this function in `src/aql.ts` before the `executeAql` function:

```typescript
/** Execute a STORE statement via engram.retain() or direct SQL. */
async function executeStore(
  engram: Engram,
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Store' }>,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const warnings = collectWarnings(stmt.modifiers);
  const table = aqlTypeToTable(stmt.memory_type);

  // Resolve all field values
  const fields: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(stmt.fields)) {
    fields[key] = resolveValue(val, vars);
  }

  if (table === 'tools') {
    // Direct insert into tools table
    const id = (fields.id as string) ?? randomUUID();
    db.prepare(
      `INSERT INTO tools (id, name, description, api_url, ranking, tags, namespace, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      fields.name ?? null,
      fields.description ?? null,
      fields.api_url ?? null,
      fields.ranking ?? 0.5,
      JSON.stringify(fields.tags ?? []),
      fields.namespace ?? 'default',
      fields.scope ?? 'private',
    );
    return {
      success: true,
      statement: 'Store',
      data: [{ id, ...fields }],
      count: 1,
      timing_ms: 0,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  if (table === 'observations') {
    // Direct insert into observations table (agent-generated)
    const id = randomUUID();
    db.prepare(
      `INSERT INTO observations (id, summary, domain, topic, data_json, source_type)
       VALUES (?, ?, ?, ?, ?, 'agent_generated')`,
    ).run(
      id,
      fields.summary ?? fields.description ?? JSON.stringify(fields),
      fields.domain ?? null,
      fields.topic ?? null,
      JSON.stringify(fields),
    );
    return {
      success: true,
      statement: 'Store',
      data: [{ id, ...fields }],
      count: 1,
      timing_ms: 0,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Chunks (EPISODIC/SEMANTIC) — go through engram.retain()
  const engramType = aqlToEngramType(stmt.memory_type);
  const text = JSON.stringify(fields);

  const retainOpts: RetainOptions = {
    memoryType: engramType ?? 'world',
    sourceType: 'agent_generated',
    trustScore: typeof fields.confidence === 'number' ? fields.confidence : 0.5,
    context: typeof fields.context === 'string' ? fields.context : undefined,
    source: typeof fields.source === 'string' ? fields.source : 'aql',
  };

  const retainResult = await engram.retain(text, retainOpts);

  return {
    success: true,
    statement: 'Store',
    data: [{ id: retainResult.chunkId, ...fields }],
    count: 1,
    timing_ms: 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
```

- [ ] **Step 4: Add UPDATE handler to `src/aql.ts`**

```typescript
/** Execute an UPDATE statement via engram.supersede(). */
async function executeUpdate(
  engram: Engram,
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Update' }>,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const warnings = collectWarnings(stmt.modifiers);
  const table = aqlTypeToTable(stmt.memory_type);
  const engramType = aqlToEngramType(stmt.memory_type);

  // Resolve update fields
  const updates: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(stmt.fields)) {
    updates[key] = resolveValue(val, vars);
  }

  if (table !== 'chunks' || !engramType) {
    return {
      success: false,
      statement: 'Update',
      data: [],
      count: 0,
      timing_ms: 0,
      error: `UPDATE only supported for EPISODIC and SEMANTIC (chunk-based) memory types`,
    };
  }

  // Find matching chunks
  const { options } = predicateToRecallOptions(
    stmt.predicate,
    stmt.modifiers,
    stmt.memory_type,
    vars,
  );

  const response = await engram.recall('*', options);
  let count = 0;

  for (const match of response.results) {
    // Merge updates into existing data
    let existingData: Record<string, unknown> = {};
    try {
      existingData = JSON.parse(match.text);
    } catch {
      existingData = { text: match.text };
    }
    const merged = { ...existingData, ...updates };
    await engram.supersede(match.id, JSON.stringify(merged));
    count++;
  }

  return {
    success: true,
    statement: 'Update',
    data: [{ updated: count }],
    count,
    timing_ms: 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
```

- [ ] **Step 5: Add FORGET handler to `src/aql.ts`**

```typescript
/** Execute a FORGET statement. */
async function executeForget(
  engram: Engram,
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Forget' }>,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const warnings = collectWarnings(stmt.modifiers);
  const table = aqlTypeToTable(stmt.memory_type);

  if (table === 'working_memory') {
    // Expire working memory sessions
    const affected = db
      .prepare(
        `UPDATE working_memory SET expires_at = datetime('now') WHERE expires_at IS NULL`,
      )
      .run();
    return {
      success: true,
      statement: 'Forget',
      data: [],
      count: affected.changes,
      timing_ms: 0,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  if (table === 'tools') {
    // Soft-delete tools
    let count = 0;
    if (stmt.predicate.type === 'Where') {
      for (const cond of stmt.predicate.conditions) {
        if (cond.type === 'Simple' && cond.op === '=') {
          const val = resolveValue(cond.value, vars);
          const affected = db
            .prepare(
              `UPDATE tools SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE ${cond.field} = ? AND is_active = TRUE`,
            )
            .run(val);
          count += affected.changes;
        }
      }
    } else if (stmt.predicate.type === 'All') {
      const affected = db
        .prepare(
          `UPDATE tools SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE is_active = TRUE`,
        )
        .run();
      count = affected.changes;
    }
    return {
      success: true,
      statement: 'Forget',
      data: [],
      count,
      timing_ms: 0,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Chunks — find matching then call engram.forget() for each
  const { options } = predicateToRecallOptions(
    stmt.predicate,
    stmt.modifiers,
    stmt.memory_type,
    vars,
  );
  const response = await engram.recall('*', options);
  let count = 0;

  for (const match of response.results) {
    const forgotten = await engram.forget(match.id);
    if (forgotten) count++;
  }

  return {
    success: true,
    statement: 'Forget',
    data: [],
    count,
    timing_ms: 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
```

- [ ] **Step 6: Wire new handlers into the `executeAql` switch**

In the `executeAql` function, add cases for Store, Update, and Forget:

```typescript
    case 'Store':
      result = await executeStore(engram, db, stmt, vars);
      break;
    case 'Update':
      result = await executeUpdate(engram, db, stmt, vars);
      break;
    case 'Forget':
      result = await executeForget(engram, db, stmt, vars);
      break;
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/aql.test.ts`
Expected: PASS — all Store, Update, Forget tests pass

- [ ] **Step 8: Commit**

```bash
git add src/aql.ts tests/aql.test.ts
git commit -m "feat(aql): implement STORE, UPDATE, FORGET statement translation"
```

---

## Task 9: LINK Statement

Implement the LINK statement that creates relations in Engram's entity graph.

**Files:**
- Modify: `src/aql.ts`
- Test: append to `tests/aql.test.ts`

- [ ] **Step 1: Write failing tests for LINK and graph traversal**

Append to `tests/aql.test.ts`:

```typescript
describe('AQL Translator — LINK', () => {
  let engram: Engram;
  let dbPath: string;
  let chunkA: string;
  let chunkB: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    const a = await engram.retain('Auth system implemented', {
      memoryType: 'experience',
    });
    const b = await engram.retain('Security best practices', {
      memoryType: 'world',
    });
    chunkA = a.chunkId;
    chunkB = b.chunkId;
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('LINK creates a relation between records', async () => {
    const result = await engram.query(
      `LINK "${chunkA}" TO "${chunkB}" TYPE "implements"`,
    );
    expect(result.success).toBe(true);
    expect(result.statement).toBe('Link');

    // Verify relation exists in database
    const relations = engram.database
      .prepare(`SELECT * FROM relations WHERE relation_type = ?`)
      .all('implements') as Record<string, unknown>[];
    expect(relations.length).toBeGreaterThanOrEqual(1);
  });

  it('LINK with WEIGHT sets confidence', async () => {
    const result = await engram.query(
      `LINK "${chunkA}" TO "${chunkB}" TYPE "caused_by" WEIGHT 0.8`,
    );
    expect(result.success).toBe(true);

    const rel = engram.database
      .prepare(`SELECT confidence FROM relations WHERE relation_type = ?`)
      .get('caused_by') as { confidence: number };
    expect(rel.confidence).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql.test.ts`
Expected: FAIL — Link not implemented

- [ ] **Step 3: Implement LINK handler**

Add to `src/aql.ts`:

```typescript
/** Execute a LINK statement by creating a relation in Engram's graph. */
async function executeLink(
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Link' }>,
): Promise<AqlQueryResult> {
  const sourceId = stmt.source_id;
  const targetId = stmt.target_id;
  const linkType = stmt.link_type;
  const confidence = stmt.weight ?? 0.5;

  // Resolve source and target to entity IDs
  const resolvedSource = resolveToEntityId(db, sourceId);
  const resolvedTarget = resolveToEntityId(db, targetId);

  const relationId = randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO relations (id, source_entity_id, target_entity_id, relation_type, confidence, created_at, updated_at, is_active)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, TRUE)`,
  ).run(relationId, resolvedSource, resolvedTarget, linkType, confidence);

  return {
    success: true,
    statement: 'Link',
    data: [
      {
        relation_id: relationId,
        source: resolvedSource,
        target: resolvedTarget,
        type: linkType,
        confidence,
      },
    ],
    count: 1,
    timing_ms: 0,
  };
}

/**
 * Resolve a record ID to an entity ID for LINK operations.
 * 1. If it matches an entity ID directly, use it.
 * 2. If it matches a chunk ID, find associated entities.
 * 3. If no entity exists, create a placeholder.
 */
function resolveToEntityId(db: Database.Database, recordId: string): string {
  // Check if it's already an entity
  const entity = db
    .prepare(`SELECT id FROM entities WHERE id = ? AND is_active = TRUE`)
    .get(recordId) as { id: string } | undefined;
  if (entity) return entity.id;

  // Check if it's a chunk — find subject entities
  const chunkEntity = db
    .prepare(
      `SELECT entity_id FROM chunk_entities WHERE chunk_id = ? AND mention_type = 'subject' LIMIT 1`,
    )
    .get(recordId) as { entity_id: string } | undefined;
  if (chunkEntity) return chunkEntity.entity_id;

  // Any entity associated with this chunk
  const anyEntity = db
    .prepare(`SELECT entity_id FROM chunk_entities WHERE chunk_id = ? LIMIT 1`)
    .get(recordId) as { entity_id: string } | undefined;
  if (anyEntity) return anyEntity.entity_id;

  // Create placeholder entity
  const placeholderId = `aql-${recordId.slice(0, 8)}`;
  db.prepare(
    `INSERT OR IGNORE INTO entities (id, name, canonical_name, entity_type, trust_score)
     VALUES (?, ?, ?, 'concept', 0.5)`,
  ).run(placeholderId, recordId, recordId.toLowerCase());

  return placeholderId;
}
```

- [ ] **Step 4: Wire LINK into the `executeAql` switch**

```typescript
    case 'Link':
      result = await executeLink(db, stmt);
      break;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/aql.test.ts`
Expected: PASS — LINK tests pass

- [ ] **Step 6: Commit**

```bash
git add src/aql.ts tests/aql.test.ts
git commit -m "feat(aql): implement LINK statement with entity resolution"
```

---

## Task 10: LOAD FROM TOOLS

Implement the LOAD statement for querying the tools registry.

**Files:**
- Modify: `src/aql.ts`
- Test: append to `tests/aql.test.ts`

- [ ] **Step 1: Write failing tests for LOAD**

Append to `tests/aql.test.ts`:

```typescript
describe('AQL Translator — LOAD', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    // Seed tools
    engram.database
      .prepare(
        `INSERT INTO tools (id, name, description, api_url, ranking) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('t-1', 'resize', 'Resize images', 'https://api/resize', 0.9);
    engram.database
      .prepare(
        `INSERT INTO tools (id, name, description, api_url, ranking) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('t-2', 'compress', 'Compress files', 'https://api/compress', 0.7);
    engram.database
      .prepare(
        `INSERT INTO tools (id, name, description, api_url, ranking) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('t-3', 'convert', 'Convert formats', 'https://api/convert', 0.5);
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('LOAD FROM TOOLS returns tools ordered by ranking', async () => {
    const result = await engram.query('LOAD FROM TOOLS ALL LIMIT 3');
    expect(result.success).toBe(true);
    expect(result.statement).toBe('Load');
    expect(result.count).toBe(3);
    // Highest ranking first
    expect(result.data[0].name).toBe('resize');
  });

  it('LOAD with WHERE filters tools', async () => {
    const result = await engram.query(
      'LOAD FROM TOOLS WHERE name = "resize"',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.data[0].api_url).toBe('https://api/resize');
  });

  it('LOAD with RETURN selects fields', async () => {
    const result = await engram.query(
      'LOAD FROM TOOLS ALL LIMIT 1 RETURN name, api_url',
    );
    expect(result.success).toBe(true);
    expect(Object.keys(result.data[0])).toEqual(
      expect.arrayContaining(['name', 'api_url']),
    );
    expect(result.data[0]).not.toHaveProperty('description');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql.test.ts`
Expected: FAIL — Load not implemented

- [ ] **Step 3: Implement LOAD handler**

Add to `src/aql.ts`:

```typescript
/** Execute a LOAD statement against the tools registry. */
async function executeLoad(
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Load' }>,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const warnings = collectWarnings(stmt.modifiers);
  const limit = stmt.modifiers.limit ?? 10;
  const conditions = ['is_active = TRUE'];
  const params: unknown[] = [];

  if (stmt.predicate.type === 'Where') {
    for (const cond of stmt.predicate.conditions) {
      if (cond.type === 'Simple' && cond.op === '=') {
        const val = resolveValue(cond.value, vars);
        conditions.push(`${cond.field} = ?`);
        params.push(val);
      }
    }
  }

  params.push(limit);

  const rows = db
    .prepare(
      `SELECT * FROM tools WHERE ${conditions.join(' AND ')} ORDER BY ranking DESC LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];

  const data = applyReturnFields(rows, stmt.modifiers.return_fields);

  return {
    success: true,
    statement: 'Load',
    data,
    count: data.length,
    timing_ms: 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
```

- [ ] **Step 4: Wire LOAD into the `executeAql` switch**

```typescript
    case 'Load':
      result = await executeLoad(db, stmt, vars);
      break;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/aql.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/aql.ts tests/aql.test.ts
git commit -m "feat(aql): implement LOAD statement for tools registry"
```

---

## Task 11: WITH LINKS and FOLLOW LINKS Modifiers

Add graph traversal support to RECALL results. WITH LINKS attaches link metadata. FOLLOW LINKS traverses the entity graph.

**Files:**
- Modify: `src/aql.ts`
- Test: append to `tests/aql.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/aql.test.ts`:

```typescript
describe('AQL Translator — WITH LINKS / FOLLOW LINKS', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    // Seed chunks
    const a = await engram.retain('Auth module', { memoryType: 'world' });
    const b = await engram.retain('Security patterns', { memoryType: 'world' });

    // Create entities and link them
    engram.database.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type) VALUES (?, ?, ?, ?)`,
    ).run('ent-auth', 'Auth', 'auth', 'concept');
    engram.database.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type) VALUES (?, ?, ?, ?)`,
    ).run('ent-sec', 'Security', 'security', 'concept');
    engram.database.prepare(
      `INSERT INTO chunk_entities (chunk_id, entity_id, mention_type) VALUES (?, ?, ?)`,
    ).run(a.chunkId, 'ent-auth', 'subject');
    engram.database.prepare(
      `INSERT INTO chunk_entities (chunk_id, entity_id, mention_type) VALUES (?, ?, ?)`,
    ).run(b.chunkId, 'ent-sec', 'subject');
    engram.database.prepare(
      `INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, confidence) VALUES (?, ?, ?, ?, ?)`,
    ).run('rel-1', 'ent-auth', 'ent-sec', 'implements', 0.9);
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('WITH LINKS attaches link metadata to results', async () => {
    const result = await engram.query(
      'RECALL FROM SEMANTIC ALL WITH LINKS ALL',
    );
    expect(result.success).toBe(true);
    expect(result.links).toBeDefined();
  });

  it('FOLLOW LINKS traverses to linked records', async () => {
    // This is a complex query — verify it doesn't crash and returns results
    const result = await engram.query(
      'RECALL FROM SEMANTIC WHERE concept = "Auth" FOLLOW LINKS TYPE "implements" DEPTH 1',
    );
    expect(result.success).toBe(true);
    // Should find linked security records
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql.test.ts`
Expected: FAIL — WITH LINKS/FOLLOW LINKS not handled

- [ ] **Step 3: Add WITH LINKS post-processing to RECALL handler**

In `src/aql.ts`, modify `executeRecall` to handle `with_links` and `follow_links` modifiers. Add after the recall response is processed:

```typescript
  // WITH LINKS — attach link metadata
  let links: AqlLink[] | undefined;
  if (stmt.modifiers.with_links) {
    links = [];
    for (const row of data) {
      const chunkId = row.id as string;
      if (!chunkId) continue;

      const chunkEntities = db
        .prepare(`SELECT entity_id FROM chunk_entities WHERE chunk_id = ?`)
        .all(chunkId) as Array<{ entity_id: string }>;

      for (const ce of chunkEntities) {
        const rels = db
          .prepare(
            `SELECT r.source_entity_id, r.target_entity_id, r.relation_type, r.confidence
             FROM relations r
             WHERE (r.source_entity_id = ? OR r.target_entity_id = ?) AND r.is_active = TRUE`,
          )
          .all(ce.entity_id, ce.entity_id) as Array<{
          source_entity_id: string;
          target_entity_id: string;
          relation_type: string;
          confidence: number;
        }>;

        for (const rel of rels) {
          links.push({
            source_id: rel.source_entity_id,
            target_id: rel.target_entity_id,
            link_type: rel.relation_type,
            confidence: rel.confidence,
          });
        }
      }
    }
  }

  // FOLLOW LINKS — traverse graph and add linked records
  if (stmt.modifiers.follow_links) {
    const fl = stmt.modifiers.follow_links;
    const maxDepth = fl.depth ?? 1;
    const linkedData: Record<string, unknown>[] = [];

    for (const row of data) {
      const chunkId = row.id as string;
      if (!chunkId) continue;

      // Find entities for this chunk
      const entityIds = db
        .prepare(`SELECT entity_id FROM chunk_entities WHERE chunk_id = ?`)
        .all(chunkId) as Array<{ entity_id: string }>;

      for (const { entity_id } of entityIds) {
        // Traverse relations of the specified type
        const targets = db
          .prepare(
            `WITH RECURSIVE traverse(eid, depth) AS (
               SELECT target_entity_id, 1 FROM relations
               WHERE source_entity_id = ? AND relation_type = ? AND is_active = TRUE
               UNION ALL
               SELECT r.target_entity_id, t.depth + 1 FROM relations r
               JOIN traverse t ON r.source_entity_id = t.eid
               WHERE r.relation_type = ? AND r.is_active = TRUE AND t.depth < ?
             )
             SELECT DISTINCT eid FROM traverse`,
          )
          .all(entity_id, fl.link_type, fl.link_type, maxDepth) as Array<{
          eid: string;
        }>;

        // Find chunks associated with target entities
        for (const { eid } of targets) {
          const targetChunks = db
            .prepare(
              `SELECT c.* FROM chunks c
               JOIN chunk_entities ce ON c.id = ce.chunk_id
               WHERE ce.entity_id = ? AND c.is_active = TRUE`,
            )
            .all(eid) as Record<string, unknown>[];
          linkedData.push(...targetChunks);
        }
      }
    }

    // Append linked records (deduplicated by id)
    const seenIds = new Set(data.map((d) => d.id));
    for (const linked of linkedData) {
      if (!seenIds.has(linked.id as string)) {
        data.push(linked);
        seenIds.add(linked.id as string);
      }
    }
  }
```

Update the return value to include `links`:

```typescript
  return {
    success: true,
    statement: 'Recall',
    data,
    count: data.length,
    timing_ms: 0,
    warnings: warnings.length > 0 ? warnings : undefined,
    links,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/aql.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/aql.ts tests/aql.test.ts
git commit -m "feat(aql): implement WITH LINKS and FOLLOW LINKS graph traversal"
```

---

## Task 12: REFLECT Statement

Implement REFLECT, including both the no-arg form (delegates to `engram.reflect()`) and the targeted FROM-clause form.

**Files:**
- Modify: `src/aql.ts`
- Modify: `src/reflect.ts`
- Test: append to `tests/aql.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/aql.test.ts`:

```typescript
describe('AQL Translator — REFLECT', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(REFLECT_RESPONSE),
      ollamaUrl: 'http://localhost:11434',
    });
    await engram.retain('Alice prefers Rust', { memoryType: 'world' });
    await engram.retain('Alice used Rust for systems work', {
      memoryType: 'experience',
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('bare REFLECT triggers reflection cycle', async () => {
    const result = await engram.query('REFLECT');
    expect(result.success).toBe(true);
    expect(result.statement).toBe('Reflect');
  });
});
```

Note: Import `REFLECT_RESPONSE` from `./helpers.js` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql.test.ts`
Expected: FAIL — Reflect not implemented

- [ ] **Step 3: Implement REFLECT handler**

Add to `src/aql.ts`:

```typescript
/** Execute a REFLECT statement. */
async function executeReflect(
  engram: Engram,
  stmt: Extract<Statement, { type: 'Reflect' }>,
): Promise<AqlQueryResult> {
  // Bare REFLECT — delegate to engram.reflect()
  if (!stmt.sources || stmt.sources.length === 0) {
    try {
      const result = await engram.reflect();
      return {
        success: true,
        statement: 'Reflect',
        data: [
          {
            observations_created: result.observationsCreated,
            opinions_formed: result.opinionsFormed,
            opinions_reinforced: result.opinionsReinforced,
            facts_processed: result.factsProcessed,
          },
        ],
        count: 1,
        timing_ms: 0,
      };
    } catch (err) {
      return {
        success: false,
        statement: 'Reflect',
        data: [],
        count: 0,
        timing_ms: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // REFLECT with FROM clauses — targeted reflection
  // Recall from each source, then trigger reflect with that context
  // For now, delegate to bare reflect (targeted reflect is future work)
  try {
    const result = await engram.reflect();
    return {
      success: true,
      statement: 'Reflect',
      data: [
        {
          observations_created: result.observationsCreated,
          opinions_formed: result.opinionsFormed,
          opinions_reinforced: result.opinionsReinforced,
          facts_processed: result.factsProcessed,
        },
      ],
      count: 1,
      timing_ms: 0,
      warnings: stmt.sources.length > 0
        ? ['REFLECT FROM clauses not yet supported — ran full reflection']
        : undefined,
    };
  } catch (err) {
    return {
      success: false,
      statement: 'Reflect',
      data: [],
      count: 0,
      timing_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 4: Wire REFLECT into the `executeAql` switch**

```typescript
    case 'Reflect':
      result = await executeReflect(engram, stmt);
      break;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/aql.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/aql.ts tests/aql.test.ts
git commit -m "feat(aql): implement REFLECT statement translation"
```

---

## Task 13: PIPELINE Statement

Implement chained query execution with variable passing between stages.

**Files:**
- Modify: `src/aql.ts`
- Test: append to `tests/aql.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/aql.test.ts`:

```typescript
describe('AQL Translator — PIPELINE', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    await engram.retain('Deploy v2 succeeded', {
      memoryType: 'experience',
      context: 'ops',
    });
    await engram.retain('Best practices for deploys', {
      memoryType: 'world',
      context: 'ops',
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('PIPELINE executes stages sequentially', async () => {
    const result = await engram.query(
      'PIPELINE test RECALL FROM EPISODIC ALL THEN RECALL FROM SEMANTIC ALL',
    );
    expect(result.success).toBe(true);
    expect(result.statement).toBe('Pipeline');
    expect(result.pipeline_stages).toBe(2);
  });

  it('PIPELINE returns combined results', async () => {
    const result = await engram.query(
      'PIPELINE test RECALL FROM EPISODIC ALL THEN RECALL FROM SEMANTIC ALL',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql.test.ts`
Expected: FAIL — Pipeline not implemented

- [ ] **Step 3: Implement PIPELINE handler**

Add to `src/aql.ts`:

```typescript
/** Execute a PIPELINE statement — sequential stage execution with variable passing. */
async function executePipeline(
  engram: Engram,
  db: Database.Database,
  stmt: Extract<Statement, { type: 'Pipeline' }>,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const timeout = stmt.timeout ? parseDurationToMs(stmt.timeout) : null;
  const startTime = performance.now();
  const allData: Record<string, unknown>[] = [];
  const allWarnings: string[] = [];
  let stageVars = { ...vars };

  for (let i = 0; i < stmt.stages.length; i++) {
    // Check timeout
    if (timeout && performance.now() - startTime > timeout) {
      return {
        success: false,
        statement: 'Pipeline',
        data: allData,
        count: allData.length,
        timing_ms: performance.now() - startTime,
        error: `Pipeline timed out after ${stmt.timeout} at stage ${i + 1}`,
        pipeline_stages: i,
      };
    }

    const stage = stmt.stages[i];
    const stageResult = await executeAql(engram, db, reconstructAql(stage.statement), stageVars);

    if (!stageResult.success) {
      return {
        success: false,
        statement: 'Pipeline',
        data: allData,
        count: allData.length,
        timing_ms: performance.now() - startTime,
        error: `Pipeline failed at stage ${i + 1}: ${stageResult.error}`,
        pipeline_stages: i,
      };
    }

    // Make stage results available as variables for next stage
    if (stageResult.data.length > 0) {
      stageVars = { ...stageVars, ...stageResult.data[0] };
      stageVars[`stage_${i}_results`] = stageResult.data;
      stageVars[`stage_${i}_count`] = stageResult.count;
    }

    allData.push(...stageResult.data);
    if (stageResult.warnings) allWarnings.push(...stageResult.warnings);
  }

  return {
    success: true,
    statement: 'Pipeline',
    data: allData,
    count: allData.length,
    timing_ms: performance.now() - startTime,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    pipeline_stages: stmt.stages.length,
  };
}

/** Convert a duration string to milliseconds. */
function parseDurationToMs(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 30_000; // default 30s
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const msMap: Record<string, number> = {
    ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
  };
  return amount * msMap[unit];
}

/**
 * Reconstruct an AQL string from an AST statement.
 * This is a simplified serializer for pipeline stage re-execution.
 * For pipeline stages that were parsed from a parent PIPELINE statement,
 * we re-serialize and re-parse through executeAql to reuse all handlers.
 *
 * Note: In a future optimization, we could dispatch directly to handlers
 * without re-serialization. For now, correctness over performance.
 */
function reconstructAql(stmt: Statement): string {
  // Store the parsed statement and dispatch directly instead of re-serializing
  // We'll handle this by modifying executeAql to accept either string or Statement
  // For now, this is a placeholder — see Step 4
  return JSON.stringify(stmt);
}
```

- [ ] **Step 4: Modify `executeAql` to accept a pre-parsed Statement**

Update the `executeAql` signature and top to support both string and pre-parsed AST:

```typescript
export async function executeAql(
  engram: Engram,
  db: Database.Database,
  aqlOrStmt: string | Statement,
  vars?: Record<string, unknown>,
): Promise<AqlQueryResult> {
  const start = performance.now();

  let stmt: Statement;
  if (typeof aqlOrStmt === 'string') {
    try {
      stmt = parseAql(aqlOrStmt);
    } catch (err) {
      return {
        success: false,
        statement: 'Unknown',
        data: [],
        count: 0,
        timing_ms: performance.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    stmt = aqlOrStmt;
  }

  // ... rest of switch statement unchanged
```

Update `executePipeline` to pass the AST directly instead of re-serializing:

```typescript
    const stageResult = await executeAql(engram, db, stage.statement, stageVars);
```

Remove the `reconstructAql` function — it's no longer needed.

- [ ] **Step 5: Wire PIPELINE into the `executeAql` switch**

```typescript
    case 'Pipeline':
      result = await executePipeline(engram, db, stmt, vars);
      break;
```

- [ ] **Step 6: Update the `Engram.query()` method signature**

In `src/engram.ts`, update the `query` method to match:

```typescript
  async query(
    aql: string,
    vars?: Record<string, unknown>,
  ): Promise<AqlQueryResult> {
    return executeAql(this, this.db, aql, vars);
  }
```

(The public API still only accepts strings — the pre-parsed overload is internal.)

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/aql.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/aql.ts src/engram.ts tests/aql.test.ts
git commit -m "feat(aql): implement PIPELINE statement with stage chaining"
```

---

## Task 14: MCP Tool Integration

Add the `engram_aql` MCP tool so agents can execute AQL queries via MCP.

**Files:**
- Modify: `src/mcp-tools.ts`
- Test: `tests/aql-mcp.test.ts`

- [ ] **Step 1: Write failing MCP tool test**

```typescript
// tests/aql-mcp.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Engram } from '../src/engram.js';
import { ENGRAM_TOOLS, createEngramToolHandler } from '../src/mcp-tools.js';
import { MockEmbedder, MockGenerator, tmpDbPath, cleanupDb } from './helpers.js';

describe('engram_aql MCP Tool', () => {
  let engram: Engram;
  let dbPath: string;
  let handler: ReturnType<typeof createEngramToolHandler>;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
    handler = createEngramToolHandler(engram);
    await engram.retain('Test memory', { memoryType: 'world' });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('engram_aql tool exists in ENGRAM_TOOLS', () => {
    const tool = ENGRAM_TOOLS.find((t) => t.name === 'engram_aql');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty('query');
  });

  it('handler executes AQL query and returns result', async () => {
    const result = await handler('engram_aql', { query: 'RECALL FROM SEMANTIC ALL' });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
  });

  it('handler returns error for invalid AQL', async () => {
    const result = await handler('engram_aql', { query: 'INVALID' });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
  });

  it('handler supports variables', async () => {
    const result = await handler('engram_aql', {
      query: 'RECALL FROM SEMANTIC ALL LIMIT 1',
      variables: {},
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aql-mcp.test.ts`
Expected: FAIL — no `engram_aql` tool in ENGRAM_TOOLS

- [ ] **Step 3: Add engram_aql tool definition and handler**

In `src/mcp-tools.ts`, add to the `ENGRAM_TOOLS` array:

```typescript
  {
    name: 'engram_aql' as const,
    description:
      "Execute an AQL (Agent Query Language) query against this agent's memory. " +
      'Supports: RECALL, SCAN, LOOKUP, LOAD, STORE, UPDATE, FORGET, LINK, REFLECT, PIPELINE. ' +
      'Example: RECALL FROM SEMANTIC WHERE context = "infrastructure" LIMIT 5 RETURN *',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'AQL query string',
        },
        variables: {
          type: 'object',
          description:
            'Optional variables for parameterized queries ({varname} or $varname)',
        },
      },
      required: ['query'],
    },
  },
```

In the `createEngramToolHandler` function, add a case for `engram_aql`:

```typescript
    case 'engram_aql': {
      const { query, variables } = input as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const result = await engram.query(query, variables);
      return JSON.stringify(result);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/aql-mcp.test.ts`
Expected: PASS — all 4 MCP tests pass

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass including existing MCP tests

- [ ] **Step 6: Commit**

```bash
git add src/mcp-tools.ts tests/aql-mcp.test.ts
git commit -m "feat(aql): add engram_aql MCP tool for AQL query execution"
```

---

## Task 15: Package Exports and Final Integration

Wire up the package exports so consumers can import AQL types and the parser.

**Files:**
- Modify: `src/engram.ts`
- Modify: `package.json`

- [ ] **Step 1: Add AQL re-exports to `src/engram.ts`**

Add to the re-export section at the top of `src/engram.ts`:

```typescript
export type {
  Statement,
  MemoryType as AqlMemoryType,
  Predicate,
  Modifiers,
  Value,
  AqlQueryResult,
  AqlLink,
} from './aql-types.js';

export { AqlParseError } from './aql-parser.js';
```

- [ ] **Step 2: Run all tests to confirm nothing broke**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Run lint**

Run: `npx eslint src/ tests/`
Expected: No lint errors (or only pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/engram.ts package.json
git commit -m "feat(aql): export AQL types and wire up package integration"
```

---

## Task 16: End-to-End Integration Test

A single test that exercises the full AQL lifecycle: store, recall, link, pipeline.

**Files:**
- Create: `tests/aql-integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/aql-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Engram } from '../src/engram.js';
import { MockEmbedder, MockGenerator, tmpDbPath, cleanupDb } from './helpers.js';

describe('AQL End-to-End Integration', () => {
  let engram: Engram;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDbPath();
    engram = await Engram.create(dbPath, {
      embedder: new MockEmbedder(),
      generator: new MockGenerator(),
    });
  });

  afterEach(() => {
    engram.close();
    cleanupDb(dbPath);
  });

  it('full lifecycle: STORE → RECALL → LINK → FORGET', async () => {
    // Store two memories
    const store1 = await engram.query(
      'STORE INTO EPISODIC (event = "deploy_v2", outcome = "success")',
    );
    expect(store1.success).toBe(true);
    const id1 = store1.data[0].id as string;

    const store2 = await engram.query(
      'STORE INTO SEMANTIC (concept = "deployment_pattern", description = "blue-green")',
    );
    expect(store2.success).toBe(true);
    const id2 = store2.data[0].id as string;

    // Recall from each type
    const recallEp = await engram.query('RECALL FROM EPISODIC ALL');
    expect(recallEp.success).toBe(true);
    expect(recallEp.count).toBeGreaterThanOrEqual(1);

    const recallSem = await engram.query('RECALL FROM SEMANTIC ALL');
    expect(recallSem.success).toBe(true);
    expect(recallSem.count).toBeGreaterThanOrEqual(1);

    // Link the two
    const link = await engram.query(
      `LINK "${id1}" TO "${id2}" TYPE "used_pattern" WEIGHT 0.9`,
    );
    expect(link.success).toBe(true);

    // Forget the episodic memory
    const forget = await engram.query(
      `LOOKUP FROM EPISODIC KEY id = "${id1}"`,
    );
    expect(forget.success).toBe(true);
    expect(forget.count).toBe(1);

    const forgetResult = await engram.query(
      `FORGET FROM EPISODIC WHERE context = "aql"`,
    );
    // May or may not find matches depending on context being set
    expect(forgetResult.success).toBe(true);
  });

  it('STORE INTO TOOLS → LOAD FROM TOOLS', async () => {
    await engram.query(
      'STORE INTO TOOLS (name = "deploy_tool", description = "Deploys services", api_url = "https://deploy.api", ranking = 0.95)',
    );
    await engram.query(
      'STORE INTO TOOLS (name = "monitor_tool", description = "Monitors health", api_url = "https://monitor.api", ranking = 0.8)',
    );

    const load = await engram.query('LOAD FROM TOOLS ALL LIMIT 5');
    expect(load.success).toBe(true);
    expect(load.count).toBe(2);
    // Ordered by ranking DESC
    expect(load.data[0].name).toBe('deploy_tool');
    expect(load.data[1].name).toBe('monitor_tool');
  });

  it('STORE INTO PROCEDURAL creates queryable observations', async () => {
    await engram.query(
      'STORE INTO PROCEDURAL (summary = "Always run smoke tests after deploy", domain = "ops", topic = "testing")',
    );

    const row = engram.database
      .prepare(`SELECT * FROM observations WHERE domain = ? AND source_type = ?`)
      .get('ops', 'agent_generated') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.summary).toBe('Always run smoke tests after deploy');
  });

  it('AGGREGATE for agent self-assessment', async () => {
    await engram.query(
      'STORE INTO EPISODIC (event = "deploy", outcome = "success")',
    );
    await engram.query(
      'STORE INTO EPISODIC (event = "deploy", outcome = "failure")',
    );
    await engram.query(
      'STORE INTO EPISODIC (event = "deploy", outcome = "success")',
    );

    const count = await engram.query(
      'RECALL FROM EPISODIC ALL AGGREGATE COUNT(*) AS total',
    );
    expect(count.success).toBe(true);
    expect(count.data[0].total).toBe(3);
  });

  it('ORDER BY for "last N events" queries', async () => {
    await engram.query(
      'STORE INTO EPISODIC (event = "step1")',
    );
    await engram.query(
      'STORE INTO EPISODIC (event = "step2")',
    );

    const result = await engram.query(
      'RECALL FROM EPISODIC ALL ORDER BY created_at DESC LIMIT 1',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it('existing retain/recall API still works alongside AQL', async () => {
    // Use traditional API
    await engram.retain('Tom prefers Terraform', {
      memoryType: 'world',
      context: 'infrastructure',
      trustScore: 0.9,
    });

    // Query via AQL
    const result = await engram.query(
      'RECALL FROM SEMANTIC WHERE context = "infrastructure"',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);

    // Query via traditional API
    const traditional = await engram.recall('Terraform', {
      contextFilter: 'infrastructure',
    });
    expect(traditional.results.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/aql-integration.test.ts`
Expected: PASS — all 4 integration tests pass

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/aql-integration.test.ts
git commit -m "test(aql): add end-to-end integration tests for full AQL lifecycle"
```

---

## Task 17: Final Verification

Run the complete verification pipeline and confirm everything works.

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: Lint**

Run: `npx eslint src/ tests/`
Expected: 0 errors (or only pre-existing)

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Coverage check**

Run: `npx vitest run --coverage`
Expected: Coverage meets existing thresholds. New AQL files should have > 75% coverage.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: Builds successfully, `dist/` includes `aql.js`, `aql-types.js`, `aql-parser.js`, `aql-memory-map.js`

- [ ] **Step 6: Commit any final fixes**

```bash
git add -A
git commit -m "chore(aql): final verification fixes"
```
