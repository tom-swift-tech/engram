import type { RetainOptions } from 'engram';

export type FileCategory =
  | 'core'
  | 'daily'
  | 'decision'
  | 'dream'
  | 'project'
  | 'reference'
  | 'memo';

export interface ClassifiedFile {
  /** Absolute path to the file */
  path: string;
  /** Path relative to the memory/ root (e.g., "core/identity.md") */
  relativePath: string;
  /** Classification category */
  category: FileCategory;
  /** Whether this is a root-level daily (true) or nested daily/ (false) */
  isRootDaily: boolean;
}

export interface DateResult {
  /** ISO 8601 date string or null if undated */
  eventTime: string | null;
  /** Human-readable temporal label */
  temporalLabel: string | null;
  /** How the date was derived */
  strategy: 'filename' | 'inline' | 'none';
}

export interface ParsedChunk {
  /** The section text content */
  text: string;
  /** Heading hierarchy: ["H2 heading", "H3 heading"] */
  headings: string[];
}

export interface MappedChunk {
  text: string;
  options: RetainOptions;
}

export interface ImportOptions {
  input: string;
  output: string;
  dryRun: boolean;
  verbose: boolean;
  skipExtraction: boolean;
  ollamaUrl: string;
  useOllamaEmbeddings: boolean;
}

export interface ImportSummary {
  filesFound: number;
  filesClassified: number;
  filesSkipped: number;
  chunksGenerated: number;
  chunksRetained: number;
  chunksDeduplicated: number;
  byCategory: Record<FileCategory, number>;
  entitiesExtracted?: number;
  relationsExtracted?: number;
}
