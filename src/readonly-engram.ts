// =============================================================================
// readonly-engram.ts — capability-restricted, read-only view over an Engram
//
// The read-only guarantee for the Subagent Grounding Layer (Product A). A
// stateless subagent must be able to READ situated context (recall / introspect
// / task-scoped context) but must NEVER write durable state — that ownership
// belongs solely to the orchestrator holding the read/write Engram.
//
// Two layers of enforcement, per docs/GROUNDING-LAYER-SPEC.md §5 (options 1+2):
//
//   1. Capability surface — this class exposes ONLY read operations. There is
//      no retain / reflect / commitContext / promoteContext / supersede /
//      forget / expireContext method. Subagent code cannot call a write; it
//      does not hold a reference to one.
//
//   2. Read-only driver connection — the underlying better-sqlite3 handle is
//      opened `{ readonly: true }`, so even a raw-SQL escape hatch fails at the
//      driver with SQLITE_READONLY. Defense in depth beneath layer 1.
//
// Precondition: constructed only from a live, already-open Engram (via
// Engram.readonlyView()). The parent's read/write open has already run schema
// bootstrap + migrations; a read-only connection cannot migrate and assumes an
// already-current file. WAL mode (set by the parent open, persisted in the file
// header) lets this second reader run concurrently with the writer, contention-
// free. The embedder instance is shared from the parent — embedding is
// connection-independent.
// =============================================================================

import Database from 'better-sqlite3';

import { recall, type RecallOptions, type RecallResponse } from './recall.js';
import {
  introspect,
  type IntrospectOptions,
  type IntrospectResult,
} from './introspect.js';
import {
  queryContext,
  type ContextRef,
  type ContextSlice,
  type TokenBudget,
} from './context-store.js';
import type { EmbeddingProvider } from './retain.js';

export class ReadonlyEngram {
  private readonly db: Database.Database;
  private readonly embedder: EmbeddingProvider;

  private constructor(db: Database.Database, embedder: EmbeddingProvider) {
    this.db = db;
    this.embedder = embedder;
  }

  /**
   * Open a read-only view over an existing `.engram` file. Internal — callers
   * use `Engram.readonlyView()`, which supplies the parent's path + embedder.
   *
   * Opens a second `{ readonly: true }` connection to the same file, applies
   * the busy_timeout used elsewhere, and loads sqlite-vec (graceful-degrade to
   * the 3-strategy recall path if absent, matching Engram.init).
   */
  static async open(
    dbPath: string,
    embedder: EmbeddingProvider,
  ): Promise<ReadonlyEngram> {
    // readonly: true — SQLite rejects any write at the driver level. fileMustExist
    // is implied by readonly (SQLite will not create a new file in read-only mode),
    // but we set it explicitly to fail loud rather than surface an obscure error.
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    // Connection-scoped setting, not a DB write — valid on a read-only handle.
    // journal_mode is NOT set here: it is already WAL in the file header from the
    // parent's read/write open, and a read-only connection cannot change it.
    db.pragma('busy_timeout = 5000');

    // Load sqlite-vec for semantic recall. Same graceful fallback as Engram.init:
    // if the extension is absent, recall() simply skips the semantic strategy.
    try {
      const mod = (await import('sqlite-vec')) as unknown as {
        load: (db: Database.Database) => void;
      };
      mod.load(db);
    } catch {
      // sqlite-vec not installed — semantic search disabled on this view
    }

    return new ReadonlyEngram(db, embedder);
  }

  // ---------------------------------------------------------------------------
  // Read operations — the entire allowed surface
  // ---------------------------------------------------------------------------

  /** Four-way retrieval + RRF + trust/decay weighting. Pure read. */
  async recall(
    query: string,
    options?: RecallOptions,
  ): Promise<RecallResponse> {
    return recall(this.db, query, this.embedder, options);
  }

  /**
   * Query the task-scoped artifacts committed as children of `ref`. Used by the
   * grounding layer's taskContext() seam. Pure read (recall() is read-only).
   */
  async queryContext(
    ref: ContextRef,
    relevanceQuery: string,
    budget?: TokenBudget,
  ): Promise<ContextSlice> {
    return queryContext(this.db, this.embedder, ref, relevanceQuery, budget);
  }

  /**
   * Structured read of held state (opinions + observations by subject), no
   * confidence floor. Pure read, no LLM/embedding.
   */
  introspect(subject?: string, options?: IntrospectOptions): IntrospectResult {
    return introspect(this.db, subject, options);
  }

  /** Close this view's connection. Independent of the parent Engram's handle. */
  close(): void {
    this.db.close();
  }
}
