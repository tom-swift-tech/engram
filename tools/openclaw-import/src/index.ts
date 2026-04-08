import { Command } from 'commander';
import type { FileCategory, ImportOptions } from './types.js';
import { runImport } from './import.js';

const program = new Command();

program
  .name('openclaw-import')
  .description('Import OpenClaw memory files into an Engram database')
  .requiredOption('-i, --input <path>', 'Source memory directory')
  .requiredOption('-o, --output <path>', 'Destination .engram file')
  .option('--dry-run', 'Parse and report without writing', false)
  .option('--verbose', 'Log each file and chunk', false)
  .option('--skip-extraction', 'Skip entity extraction after import', false)
  .option(
    '--ollama-url <url>',
    'Ollama API URL for embeddings and extraction',
    'http://localhost:11434',
  )
  .option(
    '--use-ollama-embeddings',
    'Use Ollama for embeddings (default: local Transformers.js)',
    false,
  )
  .action(async (opts) => {
    const options: ImportOptions = {
      input: opts.input,
      output: opts.output,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      skipExtraction: opts.skipExtraction,
      ollamaUrl: opts.ollamaUrl,
      useOllamaEmbeddings: opts.useOllamaEmbeddings,
    };

    const summary = await runImport(options);

    if (options.dryRun) {
      console.log('\n=== DRY RUN ===');
    } else {
      console.log('\n=== IMPORT COMPLETE ===');
    }

    console.log(`Files found: ${summary.filesFound}`);
    console.log(
      `Files classified: ${summary.filesClassified} (${summary.filesSkipped} skipped)`,
    );
    console.log(`Chunks generated: ${summary.chunksGenerated}`);

    const categories: FileCategory[] = [
      'core',
      'daily',
      'decision',
      'dream',
      'project',
      'reference',
      'memo',
    ];
    for (const cat of categories) {
      if (summary.byCategory[cat] > 0) {
        console.log(`  ${cat}: ${summary.byCategory[cat]}`);
      }
    }

    if (!options.dryRun) {
      console.log(`\nMemories retained: ${summary.chunksRetained}`);
      if (summary.chunksDeduplicated > 0) {
        console.log(`Deduplicated: ${summary.chunksDeduplicated}`);
      }
      if (summary.entitiesExtracted !== undefined) {
        console.log(`Entities extracted: ${summary.entitiesExtracted}`);
      }
      console.log(`\nEngram: ${options.output}`);
      console.log(`\nVerify:`);
      console.log(
        `  npx tsx ../../examples/basic-usage.ts ${options.output}`,
      );
    }
  });

program.parse();
