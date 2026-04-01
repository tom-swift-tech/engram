# Engram CPU-Based Entity Extraction (Tier 1) — Claude Code Spec

**Repo:** `G:\Projects\SIT\engram`
**Problem:** Entity extraction (`processExtractions()`) requires Ollama to load a 7B+ generation model, which blocks GPU VRAM for seconds, often fails when another model is loaded, and makes the knowledge graph unreliable in multi-model environments.
**Solution:** Add a CPU-based Tier 1 extractor that runs inline with `retain()` — zero LLM, zero model loads, instant entity linking. The existing LLM-based extraction becomes Tier 2 (deferred, additive refinement).

---

## Architecture: Two-Tier Extraction

```
CURRENT (single tier):
  retain() → queue chunk → [wait for processExtractions()] → LLM → entities
  Problem: Knowledge graph empty until LLM runs. LLM may never run (VRAM contention).

PROPOSED (two tiers):
  retain() → Tier 1 CPU extract (instant, inline) → entities linked immediately
           → queue remainder for Tier 2 (LLM, when GPU is available)

  Tier 1: CPU-only, runs on every retain(), catches 70-80% of entities
  Tier 2: LLM-based, runs via processExtractions(), catches remaining 20-30%
```

**Result:** Every `retain()` call immediately enriches the knowledge graph. The LLM tier is purely additive — it finds complex relationships and disambiguates entities that Tier 1 couldn't classify. If Ollama never runs, the graph still works.

---

## New File: `src/extract-cpu.ts`

Pure TypeScript, zero external dependencies. Runs synchronously (no async, no network).

### Core Functions

#### `extractEntitiesCpu(db, chunkId, text)`

Called inline during `retain()`, inside the existing insert transaction.

```typescript
/**
 * CPU-based entity extraction — runs inline with retain().
 * No LLM, no network, no model loads. Pure pattern matching + graph lookup.
 *
 * Strategy:
 *   1. Graph matching — check text against existing entity canonical_names and aliases
 *   2. Proper noun detection — capitalized words not at sentence start
 *   3. Technical term detection — camelCase, dotted paths, version numbers
 *   4. Relation template matching — "X uses Y", "X prefers Y", "X owns Y"
 *
 * Writes directly to entities, chunk_entities, and relations tables.
 * Returns count of entities and relations created/linked.
 */
export function extractEntitiesCpu(
  db: Database.Database,
  chunkId: string,
  text: string
): { entitiesLinked: number; relationsCreated: number }
```

### Extraction Strategies (in priority order)

#### Strategy 1: Graph Matching (highest value)

Check the incoming text against **every existing entity** in the database. If "Terraform" is already an entity (from a previous LLM extraction or prior Tier 1 match), any new chunk mentioning "Terraform" gets linked immediately.

```typescript
// Load all active entities once (cached per transaction)
const entities = db.prepare(`
  SELECT id, canonical_name, aliases FROM entities WHERE is_active = TRUE
`).all() as Array<{ id: string; canonical_name: string; aliases: string }>;

// For each entity, check if the text mentions it
for (const entity of entities) {
  const names = [entity.canonical_name, ...JSON.parse(entity.aliases || '[]')];
  const textLower = text.toLowerCase();
  
  for (const name of names) {
    if (textLower.includes(name.toLowerCase()) && name.length > 2) {
      // Link this chunk to the existing entity
      linkChunkEntity(db, chunkId, entity.id);
      // Update mention count + last_seen_at
      bumpEntityMention(db, entity.id);
      entitiesLinked++;
      break; // one link per entity per chunk
    }
  }
}
```

This is the highest-value strategy because it **leverages all prior LLM work**. Once Tier 2 identifies "Terraform" as a technology entity, Tier 1 links every future mention of "Terraform" instantly — no LLM needed.

#### Strategy 2: Proper Noun Detection

Extract capitalized words that appear mid-sentence (not at start, not ALL CAPS). These are likely entity candidates.

```typescript
const words = text.split(/\s+/);
const properNouns: string[] = [];

for (let i = 1; i < words.length; i++) {
  const word = words[i].replace(/[^a-zA-Z0-9-]/g, '');
  // Capitalized, not ALL CAPS, at least 2 chars, not a common word
  if (/^[A-Z][a-z]{1,}/.test(word) && !COMMON_WORDS.has(word.toLowerCase())) {
    properNouns.push(word);
  }
}
```

For detected proper nouns that don't match existing entities: **create a provisional entity** with `entity_type = 'concept'` and low confidence. Tier 2 can reclassify later.

```typescript
for (const noun of properNouns) {
  const canonical = noun.toLowerCase();
  const entityId = `ent-${canonical.replace(/[^a-z0-9]/g, '-').substring(0, 30)}`;
  
  // Upsert — if it already exists, just bump mention count
  upsertEntity(db, {
    id: entityId,
    name: noun,
    canonical_name: canonical,
    entity_type: 'concept',  // provisional — Tier 2 can reclassify
    aliases: '[]',
  });
  linkChunkEntity(db, chunkId, entityId);
}
```

#### Strategy 3: Technical Term Detection

Identify technical tokens: camelCase, dotted paths, version strings, file extensions.

```typescript
const TECH_PATTERNS = [
  /\b[a-z]+[A-Z][a-zA-Z]+\b/g,           // camelCase: memoryType, trustScore
  /\b[A-Za-z][\w]*\.[A-Za-z][\w.]*\b/g,  // dotted: better-sqlite3, next.js
  /\b[a-z]+-[a-z]+(?:-[a-z]+)*\b/g,       // kebab: sqlite-vec, claude-code
  /\bv?\d+\.\d+(?:\.\d+)?\b/g,            // versions: v0.1.6, 3.1:8b
];

for (const pattern of TECH_PATTERNS) {
  const matches = text.matchAll(pattern);
  for (const match of matches) {
    const term = match[0];
    if (term.length < 3 || STOP_WORDS.has(term.toLowerCase())) continue;
    
    const canonical = term.toLowerCase();
    const entityId = `ent-${canonical.replace(/[^a-z0-9]/g, '-').substring(0, 30)}`;
    
    upsertEntity(db, {
      id: entityId,
      name: term,
      canonical_name: canonical,
      entity_type: 'technology',
      aliases: '[]',
    });
    linkChunkEntity(db, chunkId, entityId);
  }
}
```

#### Strategy 4: Relation Template Matching

Detect common relationship patterns using regex templates.

```typescript
const RELATION_TEMPLATES: Array<{
  pattern: RegExp;
  relationType: string;
  description: (match: RegExpMatchArray) => string;
}> = [
  {
    // "X uses Y", "X using Y"
    pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:uses?|using)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g,
    relationType: 'uses',
    description: (m) => `${m[1]} uses ${m[2]}`,
  },
  {
    // "X prefers Y", "X prefer Y"
    pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:prefers?|preferring)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g,
    relationType: 'prefers',
    description: (m) => `${m[1]} prefers ${m[2]}`,
  },
  {
    // "X owns Y", "X owns a Y"
    pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+owns?\s+(?:a\s+)?(.+?)(?:\.|$)/g,
    relationType: 'owns',
    description: (m) => `${m[1]} owns ${m[2]}`,
  },
  {
    // "X switched to Y", "X switched from A to B"
    pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+switched\s+to\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g,
    relationType: 'prefers',
    description: (m) => `${m[1]} switched to ${m[2]}`,
  },
  {
    // "X depends on Y", "X built on Y"
    pattern: /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:depends?\s+on|built\s+on|runs?\s+on)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g,
    relationType: 'depends_on',
    description: (m) => `${m[1]} depends on ${m[2]}`,
  },
  {
    // "X is a Y" — entity type classification
    pattern: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+is\s+(?:a|an|the)\s+(.+?)(?:\.|,|$)/g,
    relationType: 'related_to',
    description: (m) => `${m[1]} is ${m[2]}`,
  },
];

for (const template of RELATION_TEMPLATES) {
  const matches = text.matchAll(template.pattern);
  for (const match of matches) {
    const sourceName = match[1].trim();
    const targetName = match[2].trim();
    
    const sourceCanonical = sourceName.toLowerCase();
    const targetCanonical = targetName.toLowerCase();
    
    // Only create relation if both entities exist (from graph match or proper noun detection)
    const sourceEntity = findEntity(db, sourceCanonical);
    const targetEntity = findEntity(db, targetCanonical);
    
    if (sourceEntity && targetEntity) {
      createRelation(db, {
        sourceEntityId: sourceEntity.id,
        targetEntityId: targetEntity.id,
        relationType: template.relationType,
        description: template.description(match),
        sourceChunkId: chunkId,
        confidence: 0.4,  // lower than LLM-extracted (0.5) — provisional
      });
    }
  }
}
```

### Constants

```typescript
// Common English words that look like proper nouns at sentence boundaries
const COMMON_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'what', 'which', 'who',
  'when', 'where', 'how', 'why', 'not', 'but', 'and', 'for', 'with',
  'from', 'into', 'about', 'after', 'before', 'during', 'between',
  'also', 'just', 'only', 'very', 'much', 'each', 'every', 'some',
  'any', 'all', 'both', 'few', 'more', 'most', 'other', 'such',
  'than', 'too', 'then', 'now', 'here', 'there', 'still', 'already',
  'yes', 'hey', 'sure', 'well', 'actually', 'basically', 'currently',
  'however', 'although', 'instead', 'otherwise', 'therefore', 'meanwhile',
  // Months and days often appear capitalized
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

// Stop words for technical term extraction
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'not', 'but', 'this', 'that',
  'http', 'https', 'www', 'com', 'org', 'net',
]);
```

---

## Integration Point: Modify `retain()` in `src/retain.ts`

Add Tier 1 extraction **inside the existing insert transaction**, immediately after the chunk INSERT and before the extraction queue INSERT:

```typescript
import { extractEntitiesCpu } from './extract-cpu.js';

// In the insertTransaction:
const insertTransaction = db.transaction(() => {
  // Insert chunk (existing code)
  db.prepare(`INSERT INTO chunks ...`).run(...);

  // ── NEW: Tier 1 CPU extraction (instant, inline) ──
  if (!skipExtraction && (memoryType === 'world' || memoryType === 'experience')) {
    extractEntitiesCpu(db, chunkId, text);
  }

  // Queue for Tier 2 LLM extraction (existing code — unchanged)
  if (!skipExtraction && (memoryType === 'world' || memoryType === 'experience')) {
    db.prepare(`INSERT OR IGNORE INTO extraction_queue (chunk_id) VALUES (?)`).run(chunkId);
  }
});
```

**Key point:** Tier 1 runs inside the same SQLite transaction as the chunk insert. No extra roundtrips, no async, no network. The transaction either commits everything (chunk + entity links) or nothing.

**Tier 2 still queues.** When `processExtractions()` eventually runs (via agent-tick, cron, or manual trigger), it processes the same chunks again with the LLM. The LLM extraction will:
- Find entities that Tier 1 missed (uncommon names, implied entities)
- Reclassify provisional `concept` entities to proper types (`person`, `technology`, etc.)
- Extract complex relationships that templates can't catch
- The entity upsert (`ON CONFLICT DO UPDATE SET mention_count = mention_count + 1`) means duplicate entity creation is safe

---

## Helper Functions

These go in `extract-cpu.ts`:

```typescript
function upsertEntity(db: Database.Database, entity: {
  id: string;
  name: string;
  canonical_name: string;
  entity_type: string;
  aliases: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO entities (id, name, canonical_name, entity_type, aliases, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mention_count = mention_count + 1,
      last_seen_at = excluded.last_seen_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(entity.id, entity.name, entity.canonical_name, entity.entity_type, entity.aliases, now, now, now);
}

function linkChunkEntity(db: Database.Database, chunkId: string, entityId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, mention_type)
    VALUES (?, ?, 'reference')
  `).run(chunkId, entityId);
}

function bumpEntityMention(db: Database.Database, entityId: string): void {
  db.prepare(`
    UPDATE entities
    SET mention_count = mention_count + 1,
        last_seen_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(entityId);
}

function findEntity(db: Database.Database, canonical: string): { id: string } | undefined {
  return db.prepare(
    `SELECT id FROM entities WHERE canonical_name = ? AND is_active = TRUE`
  ).get(canonical) as { id: string } | undefined;
}

function createRelation(db: Database.Database, rel: {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  description: string;
  sourceChunkId: string;
  confidence: number;
}): void {
  const relId = `rel-${randomUUID().substring(0, 8)}`;
  try {
    db.prepare(`
      INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, description, source_chunk_id, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(relId, rel.sourceEntityId, rel.targetEntityId, rel.relationType, rel.description, rel.sourceChunkId, rel.confidence);
  } catch {
    // Duplicate edge (UNIQUE constraint) — safe to ignore
  }
}
```

---

## Update `RetainResult`

Add Tier 1 extraction stats to the return value:

```typescript
export interface RetainResult {
  chunkId: string;
  queued: boolean;
  deduplicated?: boolean;
  /** Tier 1 CPU extraction results (inline, no LLM) */
  tier1?: {
    entitiesLinked: number;
    relationsCreated: number;
  };
}
```

---

## Tests

Add `tests/extract-cpu.test.ts`:

1. **Graph matching** — create entity "terraform", retain chunk mentioning "Terraform" → chunk linked to entity
2. **Proper noun detection** — retain "Tom prefers Terraform" → "Tom" and "Terraform" created as entities
3. **Technical term detection** — retain "using better-sqlite3 with sqlite-vec" → both detected as technology entities
4. **Relation template: uses** — "Tom uses Terraform" → relation created (Tom → uses → Terraform)
5. **Relation template: owns** — "Tom owns a 1969 Barracuda" → relation created
6. **Relation template: prefers** — "Tom prefers SQLite over Postgres" → relation created
7. **Relation template: switched to** — "Tom switched to Pulumi" → relation created
8. **Case insensitivity** — "terraform" in text matches entity "Terraform"
9. **Alias matching** — entity with alias "rs" matches text containing "Rust (rs)"
10. **No false positives on common words** — "The Quick Brown Fox" doesn't create entities for "The", "Quick", etc.
11. **Dedup safety** — retain same text twice → entity mention_count incremented, not duplicated
12. **Tier 1 + Tier 2 coexistence** — Tier 1 creates entity, Tier 2 processes same chunk → entity reclassified, mention count correct
13. **Transaction safety** — if retain() fails after Tier 1 extract, no orphaned entities in DB
14. **Performance** — extracting from 100-char text with 50 existing entities completes in < 5ms

Use existing `MockEmbedder`, `createTestDb()` helpers. No Ollama dependency.

---

## Files Changed

| Action | File | What |
|--------|------|------|
| CREATE | `src/extract-cpu.ts` | Tier 1 CPU extractor — pattern matching, graph lookup, relation templates |
| MODIFY | `src/retain.ts` | Call `extractEntitiesCpu()` inside the insert transaction |
| CREATE | `tests/extract-cpu.test.ts` | 14 test cases |

## Files NOT Changed

| File | Why |
|------|-----|
| `src/recall.ts` | Graph search already works with entities from any source |
| `src/reflect.ts` | Reflection is unchanged — it reads chunks, not entities |
| `src/engram.ts` | No public API changes |
| `src/mcp-tools.ts` | No tool changes |
| `src/mcp-server.ts` | No server changes |
| `src/schema.sql` | Schema already supports everything needed |
| All existing tests | Tier 1 is additive — existing behavior unchanged |

---

## Verification

```bash
npm run typecheck  # clean
npm run build      # clean
npm test           # all existing 131 tests pass + 14 new tests

# Functional test: retain a fact and verify graph is populated immediately
npx tsx -e "
  const { Engram } = await import('./dist/engram.js');
  const e = await Engram.create('/tmp/test-tier1.engram', { useOllamaEmbeddings: true, ollamaUrl: 'http://192.168.1.57:11434' });
  
  // First retain creates entities
  const r1 = await e.retain('Tom uses Terraform for Proxmox IaC', { memoryType: 'world', sourceType: 'user_stated', trustScore: 0.9 });
  console.log('Retain 1:', r1);
  
  // Second retain should link to existing entities via graph matching
  const r2 = await e.retain('Terraform deployment planned for next week', { memoryType: 'world' });
  console.log('Retain 2:', r2);
  
  // Recall should now use graph strategy
  const recall = await e.recall('Terraform', { topK: 5 });
  console.log('Strategies used:', recall.strategiesUsed);
  console.log('Results:', recall.results.length);
  
  e.close();
"
```

Expected: `strategiesUsed` includes `'graph'` immediately after retain — no `processExtractions()` needed.

---

## Performance Budget

Tier 1 extraction must add **< 2ms** to `retain()` latency. Current `retain()` is ~5ms (embed + write). With Tier 1, target is < 7ms total.

The main cost is Strategy 1 (graph matching) — iterating all existing entities and checking for substring matches. For an engram with 1000 entities, this is ~1ms. For 10,000 entities, consider caching the entity list or using a prefix trie.

---

## Why This Matters

After this change:
- **Every `retain()` call enriches the knowledge graph.** No waiting for Ollama, no model loads, no extraction queue.
- **Graph search works from the first query.** Tracer's recall gets `semantic + graph` strategies immediately, not just after a manual `processExtractions()` call.
- **Ollama is optional for basic functionality.** Embeddings already work locally (Transformers.js). Extraction now works locally (Tier 1). Only reflection and complex extraction (Tier 2) need Ollama.
- **The knowledge graph compounds automatically.** Each new entity discovered by Tier 2 makes Tier 1 smarter — future mentions get linked instantly.
- **Zero VRAM impact.** No model loads, no GPU contention. The agent's conversation model stays hot.
