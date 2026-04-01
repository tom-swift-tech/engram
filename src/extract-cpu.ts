// =============================================================================
// extract-cpu.ts - CPU-Based Entity Extraction (Tier 1)
//
// Zero LLM dependency. Runs inline during retain() inside the SQLite
// transaction. Purely synchronous — no async, no network calls.
//
// Four strategies extract entities and relations from text:
//   1. Graph Matching    — link existing entities mentioned in text
//   2. Proper Noun       — detect capitalized mid-sentence words
//   3. Technical Terms   — camelCase, kebab-case, dotted paths, versions
//   4. Relation Templates — pattern-match "X uses Y", "X prefers Y", etc.
//
// Tier 1 extractions get confidence 0.4. The Ollama-based Tier 2 extractor
// (processExtractions) can later refine, reclassify, and boost confidence.
// =============================================================================

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// =============================================================================
// Constants
// =============================================================================

/** Common English words that appear capitalized at sentence boundaries */
const COMMON_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'when', 'where', 'how', 'why', 'also', 'just', 'only', 'very', 'much',
  'some', 'many', 'most', 'such', 'each', 'every', 'both', 'few', 'more',
  'other', 'another', 'still', 'already', 'here', 'there', 'then', 'now',
  'after', 'before', 'since', 'while', 'because', 'although', 'however',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

/** Words to skip in technical term detection */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'not', 'but', 'this', 'that',
  'http', 'https', 'www', 'com', 'org', 'net',
]);

// =============================================================================
// Helper Functions (private)
// =============================================================================

function upsertEntity(
  db: Database.Database,
  entity: {
    id: string;
    name: string;
    canonical_name: string;
    entity_type: string;
    aliases?: string[];
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO entities (id, name, canonical_name, entity_type, aliases, trust_score, source_type, mention_count)
    VALUES (?, ?, ?, ?, ?, 0.3, 'inferred', 1)
    ON CONFLICT(id) DO UPDATE SET
      mention_count = mention_count + 1,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(
    entity.id,
    entity.name,
    entity.canonical_name,
    entity.entity_type,
    JSON.stringify(entity.aliases ?? []),
  );
}

function linkChunkEntity(
  db: Database.Database,
  chunkId: string,
  entityId: string
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, mention_type)
    VALUES (?, ?, 'reference')
  `);
  stmt.run(chunkId, entityId);
}

function bumpEntityMention(db: Database.Database, entityId: string): void {
  const stmt = db.prepare(`
    UPDATE entities
    SET mention_count = mention_count + 1,
        last_seen_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(entityId);
}

function findEntity(
  db: Database.Database,
  canonical: string
): string | undefined {
  const row = db.prepare(
    `SELECT id FROM entities WHERE canonical_name = ? AND is_active = TRUE`
  ).get(canonical) as { id: string } | undefined;
  return row?.id;
}

function createRelation(
  db: Database.Database,
  rel: {
    sourceEntityId: string;
    targetEntityId: string;
    relationType: string;
    description: string;
    sourceChunkId: string;
    confidence: number;
  }
): boolean {
  try {
    const stmt = db.prepare(`
      INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, description, source_chunk_id, confidence, trust_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0.3)
    `);
    stmt.run(
      `rel-${randomUUID()}`,
      rel.sourceEntityId,
      rel.targetEntityId,
      rel.relationType,
      rel.description,
      rel.sourceChunkId,
      rel.confidence,
    );
    return true;
  } catch {
    // Duplicate constraint or other DB error — safe to ignore
    return false;
  }
}

// =============================================================================
// Strategy 1: Graph Matching
// =============================================================================

function strategyGraphMatching(
  db: Database.Database,
  chunkId: string,
  text: string,
  linked: Set<string>
): number {
  let count = 0;
  const textLower = text.toLowerCase();

  // Canonical name matching — push substring search into SQLite
  const byName = db.prepare(`
    SELECT id FROM entities
    WHERE is_active = TRUE
      AND LENGTH(canonical_name) > 2
      AND INSTR(?, canonical_name) > 0
  `).all(textLower) as { id: string }[];

  // Alias matching — json_each unpacks the aliases array in SQL
  const byAlias = db.prepare(`
    SELECT DISTINCT e.id
    FROM entities e, json_each(e.aliases) AS a
    WHERE e.is_active = TRUE
      AND LENGTH(a.value) > 2
      AND INSTR(?, LOWER(a.value)) > 0
  `).all(textLower) as { id: string }[];

  const matched = new Set([...byName, ...byAlias].map(r => r.id));
  for (const id of matched) {
    if (linked.has(id)) continue;
    linkChunkEntity(db, chunkId, id);
    bumpEntityMention(db, id);
    linked.add(id);
    count++;
  }

  return count;
}

// =============================================================================
// Strategy 2: Proper Noun Detection
// =============================================================================

function strategyProperNouns(
  db: Database.Database,
  chunkId: string,
  text: string,
  linked: Set<string>
): number {
  let count = 0;
  const words = text.split(/\s+/);

  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^a-zA-Z]/g, '');
    if (!word || word.length < 2) continue;

    // Must start with uppercase, rest lowercase — not ALL CAPS
    if (!/^[A-Z][a-z]{1,}$/.test(word)) continue;

    const lower = word.toLowerCase();
    if (COMMON_WORDS.has(lower)) continue;

    const canonical = lower;
    const entityId = `ent-${canonical.replace(/[^a-z0-9]/g, '-').substring(0, 30)}`;

    if (linked.has(entityId)) continue;

    upsertEntity(db, {
      id: entityId,
      name: word,
      canonical_name: canonical,
      entity_type: 'concept',
    });

    linkChunkEntity(db, chunkId, entityId);
    linked.add(entityId);
    count++;
  }

  return count;
}

// =============================================================================
// Strategy 3: Technical Term Detection
// =============================================================================

function strategyTechnicalTerms(
  db: Database.Database,
  chunkId: string,
  text: string,
  linked: Set<string>
): number {
  let count = 0;
  const terms = new Set<string>();

  // camelCase: e.g. fetchData, getElementById
  const camelCase = text.match(/\b[a-z]+[A-Z][a-zA-Z]+\b/g);
  if (camelCase) camelCase.forEach(t => terms.add(t));

  // kebab-case: e.g. my-component, vue-router, better-sqlite3
  const kebab = text.match(/\b[a-z]+-[a-z0-9]+(?:-[a-z0-9]+)*\b/g);
  if (kebab) kebab.forEach(t => terms.add(t));

  // dotted paths: e.g. process.env, console.log, @xenova/transformers
  const dotted = text.match(/\b[A-Za-z][\w]*\.[A-Za-z][\w.]*\b/g);
  if (dotted) dotted.forEach(t => terms.add(t));

  // version strings: e.g. v1.2.3, 3.11
  const versions = text.match(/\bv?\d+\.\d+(?:\.\d+)?\b/g);
  if (versions) versions.forEach(t => terms.add(t));

  for (const term of terms) {
    if (term.length < 3) continue;
    if (STOP_WORDS.has(term.toLowerCase())) continue;

    const canonical = term.toLowerCase();
    const entityId = `ent-${canonical.replace(/[^a-z0-9]/g, '-').substring(0, 30)}`;

    if (linked.has(entityId)) continue;

    upsertEntity(db, {
      id: entityId,
      name: term,
      canonical_name: canonical,
      entity_type: 'technology',
    });

    linkChunkEntity(db, chunkId, entityId);
    linked.add(entityId);
    count++;
  }

  return count;
}

// =============================================================================
// Strategy 4: Relation Template Matching
// =============================================================================

interface RelationTemplate {
  pattern: RegExp;
  relationType: string;
}

const RELATION_TEMPLATES: RelationTemplate[] = [
  { pattern: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:uses|using)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, relationType: 'uses' },
  { pattern: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:prefers?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, relationType: 'prefers' },
  { pattern: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:owns)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, relationType: 'owns' },
  { pattern: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:switched\s+to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, relationType: 'prefers' },
  { pattern: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:depends\s+on|built\s+on|runs\s+on)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, relationType: 'depends_on' },
  { pattern: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:is\s+an?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, relationType: 'related_to' },
];

function strategyRelationTemplates(
  db: Database.Database,
  chunkId: string,
  text: string
): number {
  let count = 0;

  for (const template of RELATION_TEMPLATES) {
    // Reset regex lastIndex for each template
    template.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = template.pattern.exec(text)) !== null) {
      const subjectName = match[1];
      const objectName = match[2];

      const subjectCanonical = subjectName.toLowerCase();
      const objectCanonical = objectName.toLowerCase();

      // Both entities must exist in the DB
      const sourceId = findEntity(db, subjectCanonical);
      const targetId = findEntity(db, objectCanonical);

      if (sourceId && targetId && sourceId !== targetId) {
        const created = createRelation(db, {
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relationType: template.relationType,
          description: `${subjectName} ${template.relationType} ${objectName}`,
          sourceChunkId: chunkId,
          confidence: 0.4,
        });
        if (created) count++;
      }
    }
  }

  return count;
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * CPU-based entity extraction (Tier 1). Runs synchronously inside the
 * retain() SQLite transaction. Zero LLM dependency.
 *
 * Extracts entities via proper noun detection, technical term matching,
 * and graph matching against existing entities. Discovers relations via
 * template patterns ("X uses Y", "X prefers Y", etc.).
 */
export function extractEntitiesCpu(
  db: Database.Database,
  chunkId: string,
  text: string
): { entitiesLinked: number; relationsCreated: number } {
  const linked = new Set<string>();

  // Strategy 1: Match against existing entities in the graph
  const graphMatches = strategyGraphMatching(db, chunkId, text, linked);

  // Strategy 2: Detect proper nouns (capitalized mid-sentence words)
  const properNouns = strategyProperNouns(db, chunkId, text, linked);

  // Strategy 3: Detect technical terms (camelCase, kebab-case, etc.)
  const techTerms = strategyTechnicalTerms(db, chunkId, text, linked);

  // Strategy 4: Extract relations from template patterns
  const relationsCreated = strategyRelationTemplates(db, chunkId, text);

  return {
    entitiesLinked: graphMatches + properNouns + techTerms,
    relationsCreated,
  };
}
