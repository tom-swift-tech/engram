# openclaw-import

Import OpenClaw persona files and unstructured memory markdown into an Engram database. Deterministic classification — no LLM calls during import.

## What It Does

Walks an OpenClaw `memory/` directory, classifies each markdown file by path pattern, splits content into H2-delimited chunks, maps each category to Engram memory types with appropriate trust scores, and batch-retains everything into a `.engram` file.

## Install

```bash
cd tools/openclaw-import
npm install
```

This installs the parent `engram` package via `file:../../` — no separate publish step needed.

## Usage

```bash
# Dry run — parse and report without writing
npx tsx src/index.ts -i /path/to/memory -o ./agent.engram --dry-run

# Full import with local embeddings (default)
npx tsx src/index.ts -i /path/to/memory -o ./agent.engram

# Import with Ollama embeddings
npx tsx src/index.ts -i /path/to/memory -o ./agent.engram \
  --use-ollama-embeddings --ollama-url http://localhost:11434

# Verbose mode + skip entity extraction
npx tsx src/index.ts -i /path/to/memory -o ./agent.engram --verbose --skip-extraction
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-i, --input <path>` | Source memory directory | *(required)* |
| `-o, --output <path>` | Destination `.engram` file | *(required)* |
| `--dry-run` | Parse and report without writing | `false` |
| `--verbose` | Log each file and chunk | `false` |
| `--skip-extraction` | Skip entity extraction after import | `false` |
| `--ollama-url <url>` | Ollama API URL | `http://localhost:11434` |
| `--use-ollama-embeddings` | Use Ollama for embeddings instead of local Transformers.js | `false` |

## File Classification

Files are classified by their path relative to the memory root:

| Path Pattern | Category | Memory Type | Trust | Extraction |
|-------------|----------|-------------|-------|------------|
| `core/*` | core | world | 0.90 | yes |
| `relationships.md` | core | world | 0.90 | yes |
| `daily/*` | daily | experience | 0.70 | yes |
| Root `YYYY-MM-DD*.md` | daily | experience | 0.75 | yes |
| `decisions/*` | decision | world | 0.85 | yes |
| `dreams/*-creative.md` | dream | experience | 0.60 | no |
| `dreams/*` (other) | reference | world | 0.85 | no |
| `projects/*` | project | world | 0.80 | yes |
| `INDEX.md` | reference | world | 0.85 | no |
| Everything else | memo | world | 0.75 | yes |

### Skipped Files

Non-markdown files and files matching these patterns are automatically skipped:

- `.log`, `.json`, `.txt`, `.html`, `.jsonl` extensions
- `.backup`, `.old`, `.prev` suffixes
- `chat-archives/`, `baselines/`, `x-digests/` directories
- `dreams/images/`, `dreams/visual-prompts/`, `content-drafts/`
- Files containing `visual-prompt` or `heartbeat-metrics`

## Date Extraction

Dates are extracted using two strategies (in priority order):

1. **Filename date** — `2026-03-15.md` or `daily/2025/03/2025-03-15.md`
2. **Inline metadata** — `Last updated: 2026-03-15` in file content
3. **No date** — chunk is stored without temporal metadata

## Parsing

Markdown files are split on `## ` (H2) headings. Each section becomes a chunk with:

- Minimum 50 characters (shorter sections are discarded)
- Maximum 4000 characters (oversized sections split on paragraph boundaries)
- Context tag: `{category}:{filename} > {heading}`

## Post-Import Workflow

After import:

1. **Run extraction** to build the knowledge graph:
   ```bash
   # From engram root
   npx tsx -e "const {Engram}=await import('./dist/engram.js'); const e=await Engram.open('./agent.engram'); await e.processExtractions(100); e.close()"
   ```

2. **Run reflection** to synthesize observations:
   ```bash
   npx tsx src/reflect.ts ./agent.engram
   ```

3. **Verify recall**:
   ```bash
   # Via MCP server
   npx mcporter call engram.engram_recall query="What projects are active?"
   ```

## Architecture

```
tools/openclaw-import/
├── README.md           ← you are here
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts        ← CLI entry point (commander)
    ├── import.ts       ← orchestrator: classify → parse → map → retainBatch
    ├── classify.ts     ← path-based file classification + skip patterns
    ├── dates.ts        ← date extraction from filenames and content
    ├── parser.ts       ← H2-split markdown chunker with size limits
    ├── mapping.ts      ← category → memory type + trust score mapping
    └── types.ts        ← shared interfaces
```
