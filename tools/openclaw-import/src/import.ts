import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import { Engram } from 'engram';
import type {
  ClassifiedFile,
  FileCategory,
  ImportOptions,
  ImportSummary,
  MappedChunk,
} from './types.js';
import { discoverAndClassify } from './classify.js';
import { extractDate } from './dates.js';
import { parseMarkdown, buildContextTag } from './parser.js';
import { mapCategory } from './mapping.js';

function fileIdentifier(file: ClassifiedFile): string {
  const name = basename(file.relativePath, extname(file.relativePath));
  switch (file.category) {
    case 'core':
      return basename(name);
    case 'project':
      return basename(name);
    default:
      return name;
  }
}

function processFile(file: ClassifiedFile): MappedChunk[] {
  const content = readFileSync(file.path, 'utf8');
  const date = extractDate(file.relativePath, content);
  const mapping = mapCategory(file.category, file.isRootDaily);
  const sections = parseMarkdown(content);
  const identifier = fileIdentifier(file);

  return sections.map((section) => {
    const context = buildContextTag(file.category, identifier, section.headings);

    return {
      text: section.text,
      options: {
        memoryType: mapping.memoryType,
        eventTime: date.eventTime ?? undefined,
        temporalLabel: date.temporalLabel ?? undefined,
        context,
        source: 'openclaw-import',
        sourceUri: `memory/${file.relativePath}`,
        sourceType: mapping.sourceType,
        trustScore: mapping.trustScore,
        skipExtraction: mapping.skipExtraction,
        dedupMode: 'normalized' as const,
      },
    };
  });
}

export async function runImport(options: ImportOptions): Promise<ImportSummary> {
  const { files, skipped } = await discoverAndClassify(options.input);

  const byCategory: Record<FileCategory, number> = {
    core: 0,
    daily: 0,
    decision: 0,
    dream: 0,
    project: 0,
    reference: 0,
    memo: 0,
  };

  const allChunks: MappedChunk[] = [];

  for (const file of files) {
    const chunks = processFile(file);
    allChunks.push(...chunks);
    byCategory[file.category] += chunks.length;

    if (options.verbose) {
      console.log(
        `[${file.category}] ${file.relativePath} → ${chunks.length} chunks`,
      );
    }
  }

  const summary: ImportSummary = {
    filesFound: files.length + skipped,
    filesClassified: files.length,
    filesSkipped: skipped,
    chunksGenerated: allChunks.length,
    chunksRetained: 0,
    chunksDeduplicated: 0,
    byCategory,
  };

  if (options.dryRun) {
    return summary;
  }

  const engram = await Engram.create(options.output, {
    useOllamaEmbeddings: options.useOllamaEmbeddings,
    ollamaUrl: options.ollamaUrl,
  });

  const results = await engram.retainBatch(
    allChunks.map((c) => ({ text: c.text, options: c.options })),
    (current, total) => {
      console.log(`[${current}/${total}] Retaining memories...`);
    },
  );

  summary.chunksRetained = results.filter((r) => !r.deduplicated).length;
  summary.chunksDeduplicated = results.filter((r) => r.deduplicated).length;

  // Entity extraction
  if (!options.skipExtraction) {
    console.log('Running entity extraction...');
    const extractionResult = await engram.processExtractions(50);
    summary.entitiesExtracted = extractionResult.processed;
    summary.relationsExtracted = extractionResult.processed;
  }

  engram.close();

  return summary;
}
