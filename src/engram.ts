// =============================================================================
// engram.ts - Unified Engram Class
//
// Public API surface for the Engram library. Wraps retain/recall/reflect into
// a single class with a clean lifecycle:
//
//   const myAgent = await Engram.create('./myAgent.engram', { ... });
//   await myAgent.retain('Tom prefers Terraform', { memoryType: 'world', ... });
//   const context = await myAgent.recall('IaC tools?', { topK: 5 });
//   await myAgent.reflect();
//   myAgent.close();
//
// Schema bootstrap:
//   Reads schema.sql from the same directory as this compiled file (dist/).
//   The build step copies src/schema.sql → dist/schema.sql.
//   All CREATE TABLE statements are IF NOT EXISTS — safe to run on every open.
//
// Connection model:
//   Engram holds one persistent connection for retain/recall (low-latency).
//   reflect() opens a separate connection internally (reflect.ts pattern).
//   SQLite WAL mode allows concurrent readers alongside a single writer.
//   If both connections write simultaneously, the second blocks until the
//   first commits — writes serialize, they do not run in parallel.
//   reflect() is safe to call while retain/recall are active, but its
//   write transaction will wait for any in-progress retain() to finish.
// =============================================================================

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  retain,
  retainBatch,
  processExtractionQueue,
  recoverStalledExtractions,
  getQueueStats,
  OllamaEmbeddings,
  LocalEmbedder,
  shouldRetain,
  chunkText,
  computeTextHash,
  type RetainOptions,
  type ChunkOptions,
  type RetainResult,
  type EmbeddingProvider,
  type QueueStats,
} from './retain.js';

import {
  recall,
  formatForPrompt,
  type RecallOptions,
  type RecallResponse,
  type RecallResult,
  type FormatForPromptOptions,
} from './recall.js';
import { parseTemporalQuery, type TemporalRange } from './temporal-parser.js';
import { entityId as buildEntityId } from './extract-cpu.js';

import {
  reflect,
  ReflectScheduler,
  type ReflectConfig,
  type ReflectResult,
} from './reflect.js';

import {
  OllamaGeneration,
  OpenAICompatibleGeneration,
  AnthropicGeneration,
  DEFAULT_OLLAMA_URL,
  type GenerationProvider,
  type GenerationOptions,
} from './generation.js';

import type {
  WorkingMemoryState,
  WorkingMemoryOptions,
  WorkingSessionResult,
  SessionCandidate,
} from './working-memory-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Public API Types
// =============================================================================

// Re-export types so library consumers import only from 'engram'
export type {
  RetainOptions,
  RetainResult,
  EmbeddingProvider,
  RecallOptions,
  RecallResponse,
  RecallResult,
  ReflectConfig,
  ReflectResult,
  FormatForPromptOptions,
  WorkingMemoryState,
  WorkingMemoryOptions,
  WorkingSessionResult,
  SessionCandidate,
  GenerationProvider,
  GenerationOptions,
};
export {
  OllamaEmbeddings,
  LocalEmbedder,
  ReflectScheduler,
  shouldRetain,
  chunkText,
  formatForPrompt,
  OllamaGeneration,
  OpenAICompatibleGeneration,
  AnthropicGeneration,
  parseTemporalQuery,
  DEFAULT_OLLAMA_URL,
};
export type { TemporalRange, ChunkOptions };

export interface EngramOptions {
  /** Mission for the reflection engine: what to focus on during synthesis */
  reflectMission?: string;
  /** Mission for retain: what to prioritize when storing memories */
  retainMission?: string;
  /** Behavioral disposition for reflection (skepticism/literalism/empathy 0-1) */
  disposition?: {
    skepticism?: number;
    literalism?: number;
    empathy?: number;
  };
  /** Ollama endpoint (default: http://localhost:11434) */
  ollamaUrl?: string;
  /** Embedding model (default: nomic-embed-text) */
  embedModel?: string;
  /** Embedding dimensions (default: 768 for nomic-embed-text) */
  embedDimensions?: number;
  /** LLM for extraction + reflection (default: llama3.1:8b) */
  reflectModel?: string;
  /** Override the embedding provider — useful for testing without Ollama */
  embedder?: EmbeddingProvider;
  /** Use Ollama for embeddings instead of local Transformers.js (default: false) */
  useOllamaEmbeddings?: boolean;
  /** Override the generation provider for extraction + reflection */
  generator?: GenerationProvider;
  /** Shorthand: use OpenAI-compatible endpoint for generation */
  generationEndpoint?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
  /** Shorthand: use Anthropic API for generation */
  anthropicGeneration?: {
    apiKey: string;
    model?: string;
  };
}

// =============================================================================
// Engram Class
// =============================================================================

export class Engram {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  private readonly embedder: EmbeddingProvider;
  private readonly generator: GenerationProvider;

  private constructor(
    db: Database.Database,
    dbPath: string,
    embedder: EmbeddingProvider,
    generator: GenerationProvider,
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.embedder = embedder;
    this.generator = generator;
  }

  // ---------------------------------------------------------------------------
  // Internal factory — shared by create() and open()
  // ---------------------------------------------------------------------------

  private static async init(
    path: string,
    options: EngramOptions,
  ): Promise<Engram> {
    const {
      ollamaUrl = DEFAULT_OLLAMA_URL,
      embedModel,
      embedDimensions,
      reflectModel = 'llama3.1:8b',
      embedder: injectedEmbedder,
      useOllamaEmbeddings = false,
      generator: injectedGenerator,
    } = options;

    const db = new Database(path);

    // Load sqlite-vec for vector search. Graceful fallback: semantic strategy
    // is simply skipped (recall.ts catches the error) if the extension is absent.
    try {
      const mod = (await import('sqlite-vec')) as unknown as {
        load: (db: Database.Database) => void;
      };
      mod.load(db);
    } catch {
      // sqlite-vec not installed — semantic search disabled
    }

    // Bootstrap schema — idempotent, safe to run on every open
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf8');
    db.exec(schema);

    // Migration: add text_hash column to existing .engram files (pre-F4)
    const columns = db.pragma('table_info(chunks)') as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'text_hash')) {
      db.exec('ALTER TABLE chunks ADD COLUMN text_hash TEXT');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON chunks(text_hash) WHERE is_active = TRUE',
      );
    }

    // Backfill text_hash for any existing chunks that predate this migration
    const missing = db
      .prepare(
        `SELECT COUNT(*) as c FROM chunks WHERE text_hash IS NULL AND is_active = TRUE`,
      )
      .get() as { c: number };
    if (missing.c > 0) {
      const rows = db
        .prepare(
          `SELECT id, text FROM chunks WHERE text_hash IS NULL AND is_active = TRUE`,
        )
        .all() as Array<{ id: string; text: string }>;
      const updateHash = db.prepare(
        `UPDATE chunks SET text_hash = ? WHERE id = ?`,
      );
      const backfill = db.transaction(() => {
        for (const row of rows) {
          updateHash.run(computeTextHash(row.text), row.id);
        }
      });
      backfill();
    }

    // Migration: add next_retry_after column to existing .engram files
    const eqColumns = db.pragma('table_info(extraction_queue)') as Array<{
      name: string;
    }>;
    if (!eqColumns.some((c) => c.name === 'next_retry_after')) {
      db.exec(
        'ALTER TABLE extraction_queue ADD COLUMN next_retry_after TIMESTAMP',
      );
    }

    // Migration: re-key entity IDs to collision-resistant format (slug + hash).
    // Disables FK checks during the transaction because child rows (chunk_entities,
    // relations) reference entities.id — updating the parent first would violate
    // FK constraints. All rows are updated atomically within the transaction.
    const entityIdV2 = db
      .prepare(
        `SELECT value FROM bank_config WHERE key = 'entity_id_v2_migrated'`,
      )
      .get() as { value: string } | undefined;
    if (!entityIdV2) {
      const entities = db
        .prepare(`SELECT id, canonical_name FROM entities`)
        .all() as Array<{ id: string; canonical_name: string }>;
      if (entities.length > 0) {
        db.pragma('foreign_keys = OFF');
        const updateEntity = db.prepare(
          `UPDATE entities SET id = ? WHERE id = ?`,
        );
        const updateChunkEntity = db.prepare(
          `UPDATE chunk_entities SET entity_id = ? WHERE entity_id = ?`,
        );
        const updateRelSrc = db.prepare(
          `UPDATE relations SET source_entity_id = ? WHERE source_entity_id = ?`,
        );
        const updateRelTgt = db.prepare(
          `UPDATE relations SET target_entity_id = ? WHERE target_entity_id = ?`,
        );
        const migrate = db.transaction(() => {
          for (const ent of entities) {
            const newId = buildEntityId(ent.canonical_name);
            if (newId !== ent.id) {
              updateChunkEntity.run(newId, ent.id);
              updateRelSrc.run(newId, ent.id);
              updateRelTgt.run(newId, ent.id);
              updateEntity.run(newId, ent.id);
            }
          }
        });
        migrate();
        db.pragma('foreign_keys = ON');
      }
      db.prepare(
        `INSERT OR REPLACE INTO bank_config (key, value) VALUES ('entity_id_v2_migrated', 'true')`,
      ).run();
    }

    // Embedding provider selection (priority order):
    // 1. Injected embedder — caller controls everything (used in tests)
    // 2. Ollama embeddings — opt-in via useOllamaEmbeddings flag
    // 3. Local Transformers.js — default, zero network dependency
    let embedder: EmbeddingProvider;
    try {
      if (injectedEmbedder) {
        embedder = injectedEmbedder;
      } else if (useOllamaEmbeddings) {
        embedder = new OllamaEmbeddings(
          ollamaUrl,
          embedModel ?? 'nomic-embed-text',
          embedDimensions ?? 768,
        );
      } else {
        const localModel = embedModel ?? 'Xenova/nomic-embed-text-v1.5';
        const local = new LocalEmbedder(localModel);
        await local.init();
        embedder = local;
      }
    } catch (err) {
      db.close();
      throw err;
    }

    // Generation provider selection (priority order):
    // 1. Injected generator — caller controls everything (tests, custom providers)
    // 2. Anthropic generation — direct API
    // 3. OpenAI-compatible endpoint — OpenRouter, Herd, vLLM, etc.
    // 4. Ollama generation — default, uses ollamaUrl + reflectModel
    let generator: GenerationProvider;
    if (injectedGenerator) {
      generator = injectedGenerator;
    } else if (options.anthropicGeneration) {
      generator = new AnthropicGeneration(
        options.anthropicGeneration.apiKey,
        options.anthropicGeneration.model,
      );
    } else if (options.generationEndpoint) {
      generator = new OpenAICompatibleGeneration(
        options.generationEndpoint.baseUrl,
        options.generationEndpoint.model,
        options.generationEndpoint.apiKey,
      );
    } else {
      generator = new OllamaGeneration({ url: ollamaUrl, model: reflectModel });
    }

    // Validate embedding dimensions against existing data.
    // Legacy .engram files won't have embed_dimensions in bank_config,
    // so we derive it from existing embeddings before recording.
    const currentDim = embedder.dimensions;
    const storedDim = db
      .prepare(`SELECT value FROM bank_config WHERE key = 'embed_dimensions'`)
      .get() as { value: string } | undefined;

    let knownDim: number | null = storedDim
      ? parseInt(storedDim.value, 10)
      : null;

    // Legacy migration: no stored dimension — derive from existing embeddings
    if (knownDim === null) {
      const sample = db
        .prepare(
          `SELECT length(embedding) as len FROM chunks WHERE embedding IS NOT NULL LIMIT 1`,
        )
        .get() as { len: number } | undefined;
      if (sample && sample.len > 0) {
        // Float32 = 4 bytes per dimension
        knownDim = sample.len / 4;
      }
    }

    if (knownDim !== null && knownDim !== currentDim) {
      const hasEmbeddings = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM chunks WHERE embedding IS NOT NULL`,
          )
          .get() as { cnt: number }
      ).cnt;
      if (hasEmbeddings > 0) {
        db.close();
        throw new Error(
          `Embedding dimension mismatch: database contains ${hasEmbeddings} chunks with ${knownDim}d embeddings, ` +
            `but the current embedder produces ${currentDim}d vectors. ` +
            `Cosine similarity will be invalid. Use the same model or re-embed existing chunks.`,
        );
      }
    }

    // Record (or update) the current dimension
    db.prepare(
      `INSERT INTO bank_config (key, value) VALUES ('embed_dimensions', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).run(String(currentDim));

    return new Engram(db, path, embedder, generator);
  }

  private upsertBankConfig(options: EngramOptions): void {
    const upsert = this.db.prepare(`
      INSERT INTO bank_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    const tx = this.db.transaction(() => {
      if (options.reflectMission !== undefined)
        upsert.run('reflect_mission', options.reflectMission);
      if (options.retainMission !== undefined)
        upsert.run('retain_mission', options.retainMission);
      if (options.disposition !== undefined)
        upsert.run('disposition', JSON.stringify(options.disposition));
    });
    tx();
  }

  // ---------------------------------------------------------------------------
  // Public factory methods
  // ---------------------------------------------------------------------------

  /**
   * Create or reinitialize an engram at the given path.
   * All provided options are written to bank_config on every call.
   */
  static async create(
    path: string,
    options: EngramOptions = {},
  ): Promise<Engram> {
    const engram = await Engram.init(path, options);
    engram.upsertBankConfig(options);
    return engram;
  }

  /**
   * Open an existing engram. Schema is bootstrapped if missing (safe on new files too).
   * Bank config is updated only for options that are explicitly provided.
   */
  static async open(
    path: string,
    options: EngramOptions = {},
  ): Promise<Engram> {
    const engram = await Engram.init(path, options);
    const configKeys: Array<keyof EngramOptions> = [
      'reflectMission',
      'retainMission',
      'disposition',
    ];
    if (configKeys.some((k) => options[k] !== undefined)) {
      engram.upsertBankConfig(options);
    }
    return engram;
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  /** Store a memory trace. Fast path — embeds locally, no LLM call. ~5ms. */
  async retain(text: string, options?: RetainOptions): Promise<RetainResult> {
    return retain(this.db, text, this.embedder, options);
  }

  /**
   * Bulk store. Queues all entity extractions at the end rather than one-by-one.
   * Efficient for importing conversations or documents.
   */
  async retainBatch(
    items: Array<{ text: string; options?: RetainOptions }>,
    onProgress?: (current: number, total: number) => void,
  ): Promise<RetainResult[]> {
    return retainBatch(this.db, items, this.embedder, onProgress);
  }

  /**
   * Retrieve relevant memories via 4-way retrieval (semantic + keyword + graph + temporal),
   * fused via Reciprocal Rank Fusion and weighted by trust score.
   */
  async recall(
    query: string,
    options?: RecallOptions,
  ): Promise<RecallResponse> {
    return recall(this.db, query, this.embedder, options);
  }

  /**
   * Run a reflection cycle: processes unreflected facts through the LLM,
   * synthesizes observations, and reinforces/challenges opinions.
   *
   * Opens a separate DB connection internally (WAL mode: safe alongside
   * idle retain/recall connections).
   *
   * @remarks Only chunks with memoryType 'world' or 'experience' are processed.
   * Observations and opinions are outputs of reflection, not inputs.
   */
  async reflect(
    options?: Pick<ReflectConfig, 'batchSize' | 'minFactsThreshold'>,
  ): Promise<ReflectResult> {
    return reflect({
      dbPath: this.dbPath,
      generator: this.generator,
      ...options,
    });
  }

  /**
   * Drain the entity extraction queue. Calls Ollama to extract entities and
   * relations from retained chunks, building out the knowledge graph.
   */
  async processExtractions(
    batchSize: number = 10,
  ): Promise<{ processed: number; failed: number }> {
    return processExtractionQueue(this.db, this.generator, batchSize);
  }

  /**
   * Recover extraction queue items stuck in 'processing' state after a crash.
   * Called automatically by processExtractions(), but can be invoked manually.
   *
   * @param stallTimeoutMinutes — items processing longer than this are reset (default: 5)
   * @returns number of recovered items
   */
  recoverExtractions(stallTimeoutMinutes?: number): number {
    return recoverStalledExtractions(this.db, stallTimeoutMinutes);
  }

  /** Get extraction queue health stats (pending, completed, failed counts). */
  getQueueStats(): QueueStats {
    return getQueueStats(this.db);
  }

  /** Close the database connection. Call when the agent shuts down. */
  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Memory lifecycle — forget / supersede
  // ---------------------------------------------------------------------------

  /**
   * Soft-delete a memory chunk. Sets is_active = FALSE.
   * The chunk remains in the database for audit but is excluded from recall.
   * Returns true if the chunk was found and deactivated.
   */
  async forget(chunkId: string): Promise<boolean> {
    const result = this.db.transaction(() => {
      const chunkResult = this.db
        .prepare(
          `UPDATE chunks SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_active = TRUE`,
        )
        .run(chunkId);

      if (chunkResult.changes > 0) {
        this.db
          .prepare(
            `
          UPDATE extraction_queue
          SET status = 'completed', error = 'chunk deactivated'
          WHERE chunk_id = ? AND status IN ('pending', 'processing')
        `,
          )
          .run(chunkId);
      }

      return chunkResult;
    })();

    return result.changes > 0;
  }

  /**
   * Supersede an old fact with new text. The old chunk is soft-deleted and
   * linked to the new one via superseded_by. Use when correcting information:
   * supersede("Tom prefers Terraform" → "Tom switched to Pulumi").
   */
  async supersede(
    oldChunkId: string,
    newText: string,
    options?: RetainOptions,
  ): Promise<RetainResult> {
    const newResult = await this.retain(newText, options);
    this.db
      .prepare(
        `UPDATE chunks SET is_active = FALSE, superseded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(newResult.chunkId, oldChunkId);
    return newResult;
  }

  /**
   * Soft-delete all chunks whose source contains the given pattern.
   * Returns the count of deactivated chunks.
   * Useful for clearing out an entire conversation or document import.
   */
  async forgetBySource(sourcePattern: string): Promise<number> {
    const result = this.db.transaction(() => {
      const chunkIds = this.db
        .prepare(
          `
        SELECT id
        FROM chunks
        WHERE source LIKE ? AND is_active = TRUE
      `,
        )
        .all(`%${sourcePattern}%`) as Array<{ id: string }>;

      const chunkResult = this.db
        .prepare(
          `UPDATE chunks SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE source LIKE ? AND is_active = TRUE`,
        )
        .run(`%${sourcePattern}%`);

      if (chunkIds.length > 0) {
        const updateQueue = this.db.prepare(`
          UPDATE extraction_queue
          SET status = 'completed', error = 'chunk deactivated'
          WHERE chunk_id = ? AND status IN ('pending', 'processing')
        `);
        for (const chunk of chunkIds) {
          updateQueue.run(chunk.id);
        }
      }

      return chunkResult;
    })();

    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Working Memory — primitives
  // ---------------------------------------------------------------------------

  /**
   * Generate an embedding for arbitrary text using the configured provider.
   * Useful for agents that need embeddings for session matching without
   * going through retain() or recall().
   */
  async embedText(text: string): Promise<Float32Array> {
    return this.embedder.embed(text);
  }

  /**
   * Find active working memory sessions similar to the given embedding.
   * Returns candidates sorted by similarity (highest first).
   *
   * This is the low-level primitive — it does NOT make a match/new decision.
   * The agent's adapter layer uses these results to implement its own policy.
   */
  findSimilarSessions(
    embedding: Float32Array,
    limit: number = 3,
  ): SessionCandidate[] {
    const embeddingBuffer = Buffer.from(embedding.buffer);
    try {
      const rows = this.db
        .prepare(
          `
        SELECT id, data_json,
               vec_distance_cosine(topic_embedding, ?) AS distance
        FROM working_memory
        WHERE (expires_at IS NULL OR expires_at > datetime('now'))
          AND topic_embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT ?
      `,
        )
        .all(embeddingBuffer, limit) as Array<{
        id: string;
        data_json: string;
        distance: number;
      }>;

      return rows.map((c) => ({
        id: c.id,
        state: JSON.parse(c.data_json) as WorkingMemoryState,
        similarity: 1 - (c.distance ?? 1),
      }));
    } catch {
      // sqlite-vec not loaded — no vector matching available
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Working Memory — session management
  // ---------------------------------------------------------------------------

  /**
   * Infer which working memory session an incoming message belongs to.
   * Embeds the message, cosine-matches against active sessions, and either
   * resumes the best match or creates a new session. Then loads related
   * long-term context via recall().
   */
  async inferWorkingSession(
    message: string,
    options: WorkingMemoryOptions = {},
  ): Promise<WorkingSessionResult> {
    const maxActive = Math.max(1, options.maxActive ?? 5);
    const threshold = Math.max(0, Math.min(options.threshold ?? 0.55, 1));

    // 1. Embed the incoming message
    const msgEmbedding = await this.embedText(message);
    const embeddingBuffer = Buffer.from(msgEmbedding.buffer);

    // 2. Find active sessions and score by similarity
    const candidates = this.findSimilarSessions(msgEmbedding, 3);

    // 3. Pick best match or create new session
    let session: WorkingMemoryState;
    let confidence: number;
    let reason: 'match' | 'new';

    const best = candidates[0];
    if (best && best.similarity >= threshold) {
      // Resume existing session
      session = best.state;
      confidence = best.similarity;
      reason = 'match';

      // Touch the session timestamp
      this.db
        .prepare(
          `UPDATE working_memory SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .run(best.id);
    } else {
      // Create new session
      session = await this.createWorkingSession(message, embeddingBuffer);
      confidence = 1.0;
      reason = 'new';

      // Enforce maxActive — snapshot oldest if over the cap
      await this.enforceSessionCap(maxActive);
    }

    // 4. Load related long-term context using session goal as seed
    const recallResponse = await this.recall(session.goal, {
      topK: 8,
      snippetChars: 800,
    });
    const relatedContext = formatForPrompt(recallResponse, { maxChars: 1200 });

    return {
      session,
      relatedContext,
      confidence,
      diagnostics: {
        sessionId: session.id,
        reason,
        candidatesEvaluated: candidates.length,
      },
    };
  }

  /**
   * Create a new working memory session from a message and pre-computed embedding.
   * Called internally by inferWorkingSession, but exposed for agents that
   * implement custom session resolution using the primitives.
   */
  async createWorkingSession(
    message: string,
    embeddingBuffer: Buffer,
  ): Promise<WorkingMemoryState> {
    const id = `wm-${randomUUID().substring(0, 12)}`;
    const now = new Date().toISOString();

    const state: WorkingMemoryState = {
      id,
      goal: message.slice(0, 200),
      updated_at: now,
    };

    this.db
      .prepare(
        `
      INSERT INTO working_memory (id, data_json, seed_query, topic_embedding)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(id, JSON.stringify(state), message.slice(0, 200), embeddingBuffer);

    return state;
  }

  /**
   * Update an existing working memory session with new state.
   * Merges partial updates into the existing data_json and re-embeds
   * the seed query for future similarity matching.
   */
  async updateWorkingSession(
    sessionId: string,
    updates: Partial<WorkingMemoryState>,
  ): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT data_json FROM working_memory WHERE id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      )
      .get(sessionId) as { data_json: string } | undefined;

    if (!row)
      throw new Error(
        `Working memory session ${sessionId} not found or expired`,
      );

    const existing = JSON.parse(row.data_json) as WorkingMemoryState;
    const merged: WorkingMemoryState = {
      ...existing,
      ...updates,
      id: sessionId, // never overwrite ID
      updated_at: new Date().toISOString(),
    };

    const seedQuery = `${merged.goal}`.trim();
    const embedding = await this.embedder.embed(seedQuery);
    const embeddingBuffer = Buffer.from(embedding.buffer);

    this.db
      .prepare(
        `
      UPDATE working_memory
      SET data_json = ?, seed_query = ?, topic_embedding = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      )
      .run(JSON.stringify(merged), seedQuery, embeddingBuffer, sessionId);
  }

  /**
   * Get the current state of a working memory session.
   * Returns null if the session doesn't exist or has expired.
   */
  getWorkingSession(sessionId: string): WorkingMemoryState | null {
    const row = this.db
      .prepare(
        `SELECT data_json FROM working_memory WHERE id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      )
      .get(sessionId) as { data_json: string } | undefined;

    return row ? (JSON.parse(row.data_json) as WorkingMemoryState) : null;
  }

  /**
   * List all active (non-expired) working memory sessions.
   */
  listWorkingSessions(): WorkingMemoryState[] {
    const rows = this.db
      .prepare(
        `
      SELECT data_json FROM working_memory
      WHERE expires_at IS NULL OR expires_at > datetime('now')
      ORDER BY updated_at DESC
    `,
      )
      .all() as Array<{ data_json: string }>;

    return rows.map((r) => JSON.parse(r.data_json) as WorkingMemoryState);
  }

  /**
   * Snapshot a working memory session to long-term episodic memory,
   * then mark it as expired.
   */
  async snapshotWorkingSession(sessionId: string): Promise<RetainResult> {
    const row = this.db
      .prepare(`SELECT data_json, seed_query FROM working_memory WHERE id = ?`)
      .get(sessionId) as
      | { data_json: string; seed_query: string | null }
      | undefined;

    if (!row) throw new Error(`Working memory session ${sessionId} not found`);

    const state = JSON.parse(row.data_json) as WorkingMemoryState;
    const progressNotes = (state.progress as string | undefined) ?? '';
    const summary = [
      `Session goal: ${state.goal}`,
      progressNotes ? `Progress: ${progressNotes}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const result = await this.retain(summary, {
      memoryType: 'experience',
      source: `working_memory:${sessionId}`,
      sourceType: 'agent_generated',
      trustScore: 0.6,
      skipExtraction: false,
    });

    // Mark as expired
    this.db
      .prepare(
        `UPDATE working_memory SET expires_at = datetime('now') WHERE id = ?`,
      )
      .run(sessionId);

    return result;
  }

  /**
   * Expire and snapshot all sessions that haven't been updated within
   * the given threshold. Call this from a background maintenance tick.
   */
  async expireStaleWorkingSessions(maxAgeHours: number = 48): Promise<number> {
    const stale = this.db
      .prepare(
        `
      SELECT id FROM working_memory
      WHERE updated_at <= datetime('now', '-' || ? || ' hours')
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `,
      )
      .all(String(maxAgeHours)) as Array<{ id: string }>;

    for (const { id } of stale) {
      try {
        await this.snapshotWorkingSession(id);
      } catch {
        // If snapshot fails, still expire it
        this.db
          .prepare(
            `UPDATE working_memory SET expires_at = datetime('now') WHERE id = ?`,
          )
          .run(id);
      }
    }

    return stale.length;
  }

  /**
   * Clear a specific working memory session without snapshotting.
   */
  clearWorkingSession(sessionId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE working_memory SET expires_at = datetime('now') WHERE id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      )
      .run(sessionId);
    return result.changes > 0;
  }

  /**
   * Enforce the maximum active session cap.
   * Snapshots the oldest sessions that exceed the cap.
   */
  private async enforceSessionCap(maxActive: number): Promise<void> {
    const active = this.db
      .prepare(
        `
      SELECT id FROM working_memory
      WHERE expires_at IS NULL OR expires_at > datetime('now')
      ORDER BY updated_at ASC
    `,
      )
      .all() as Array<{ id: string }>;

    const excess = active.length - maxActive;
    if (excess <= 0) return;

    for (let i = 0; i < excess; i++) {
      try {
        await this.snapshotWorkingSession(active[i].id);
      } catch {
        this.db
          .prepare(
            `UPDATE working_memory SET expires_at = datetime('now') WHERE id = ?`,
          )
          .run(active[i].id);
      }
    }
  }
}
