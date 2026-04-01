# Engram Generation Provider — Pluggable LLM Backend

**Repo:** `G:\Projects\SIT\engram`
**Problem:** Entity extraction (`processExtractions()`) and reflection (`reflect()`) hard-code Ollama's `/api/generate` endpoint. Users running Anthropic, OpenAI, OpenRouter, or Herd Pro as their primary LLM have no way to use those providers for Engram's generation tasks.
**Solution:** Abstract generation behind a `GenerationProvider` interface (same pattern as the existing `EmbeddingProvider`), with implementations for Ollama, OpenAI-compatible APIs, and Anthropic.

---

## Context

Engram currently has this dependency chain:

| Feature | Provider | Hard-coded? |
|---|---|---|
| Embeddings | `EmbeddingProvider` interface | ✅ Pluggable — `LocalEmbedder` or `OllamaEmbeddings` |
| Entity extraction | `fetch(ollamaUrl + '/api/generate')` | ❌ Hard-coded to Ollama |
| Reflection | `fetch(ollamaUrl + '/api/generate')` | ❌ Hard-coded to Ollama |

The `EmbeddingProvider` pattern is already proven and clean. This spec applies the same pattern to generation.

---

## New Interface: `GenerationProvider`

Add to a new file `src/generation.ts`:

```typescript
/**
 * Abstraction for text generation — used by entity extraction and reflection.
 * Same pattern as EmbeddingProvider: inject at Engram creation time.
 */
export interface GenerationProvider {
  /**
   * Generate text from a prompt. Returns the raw text response.
   * Implementations handle their own auth, endpoints, and formatting.
   */
  generate(prompt: string, options?: GenerationOptions): Promise<string>;
  
  /** Human-readable provider name for logging */
  readonly name: string;
}

export interface GenerationOptions {
  /** Sampling temperature (default: provider-specific) */
  temperature?: number;
  /** Max tokens to generate (default: provider-specific) */
  maxTokens?: number;
  /** Whether this is a structured output request (extraction/reflection prompts expect JSON) */
  jsonMode?: boolean;
}
```

---

## Implementations

### `OllamaGeneration` (existing behavior, extracted)

```typescript
export class OllamaGeneration implements GenerationProvider {
  readonly name: string;
  
  constructor(
    private url: string = 'http://localhost:11434',
    private model: string = 'llama3.1:8b',
  ) {
    this.name = `ollama/${model}`;
  }

  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    const response = await fetch(`${this.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: options?.temperature ?? 0.1,
          num_predict: options?.maxTokens ?? 4096,
        },
        ...(options?.jsonMode ? { format: 'json' } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama generation error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return data.response;
  }
}
```

### `OpenAICompatibleGeneration` (OpenRouter, Herd Pro, vLLM, LiteLLM, etc.)

Any endpoint that speaks the OpenAI `/v1/chat/completions` API:

```typescript
export class OpenAICompatibleGeneration implements GenerationProvider {
  readonly name: string;

  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey?: string,
  ) {
    this.name = `openai-compat/${model}`;
  }

  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options?.temperature ?? 0.1,
      max_tokens: options?.maxTokens ?? 4096,
    };
    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible generation error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
  }
}
```

This covers:
- **OpenRouter** — `baseUrl: 'https://openrouter.ai/api'`, `apiKey: OPENROUTER_API_KEY`, `model: 'anthropic/claude-haiku-4.5'`
- **Herd Pro** — `baseUrl: 'http://localhost:11434'`, `model: 'llama3.1:8b'` (Herd exposes OpenAI-compat API)
- **OpenAI direct** — `baseUrl: 'https://api.openai.com'`, `apiKey: OPENAI_API_KEY`, `model: 'gpt-4o-mini'`
- **vLLM / LiteLLM / any OpenAI-compatible** — just set baseUrl + model

### `AnthropicGeneration` (direct Anthropic API)

```typescript
export class AnthropicGeneration implements GenerationProvider {
  readonly name: string;

  constructor(
    private apiKey: string,
    private model: string = 'claude-haiku-4-5-20251001',
  ) {
    this.name = `anthropic/${model}`;
  }

  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens ?? 4096,
        messages: [{ role: 'user', content: prompt }],
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic generation error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text ?? '';
  }
}
```

---

## Integration: Modify `EngramOptions`

Add generation provider configuration:

```typescript
export interface EngramOptions {
  // ... existing options ...
  
  /** Override the generation provider — used for extraction and reflection.
   *  If not set, defaults to OllamaGeneration with ollamaUrl + reflectModel. */
  generator?: GenerationProvider;
  
  /** Shorthand: use OpenAI-compatible endpoint for generation.
   *  Sets generator to OpenAICompatibleGeneration. Mutually exclusive with generator. */
  generationEndpoint?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
  
  /** Shorthand: use Anthropic API for generation.
   *  Sets generator to AnthropicGeneration. Mutually exclusive with generator. */
  anthropicGeneration?: {
    apiKey: string;
    model?: string;  // default: claude-haiku-4-5-20251001
  };
}
```

### Provider selection in `Engram.init()`:

```typescript
// Generation provider selection (priority order):
// 1. Injected generator — caller controls everything
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
  generator = new OllamaGeneration(ollamaUrl, reflectModel);
}
```

---

## Refactor: `processExtractionQueue()` and `reflect()`

### `src/retain.ts` — `processExtractionQueue()`

Change signature:

```typescript
// OLD:
export async function processExtractionQueue(
  db: Database.Database,
  ollamaUrl: string = 'http://localhost:11434',
  model: string = 'llama3.1:8b',
  batchSize: number = 10
): Promise<{ processed: number; failed: number }>

// NEW:
export async function processExtractionQueue(
  db: Database.Database,
  generator: GenerationProvider,
  batchSize: number = 10
): Promise<{ processed: number; failed: number }>
```

Replace the internal `extractEntities()` function:

```typescript
// OLD:
const extracted = await extractEntities(item.text, ollamaUrl, model);

// NEW:
const extracted = await extractEntities(item.text, generator);

// extractEntities() changes:
async function extractEntities(text: string, generator: GenerationProvider): Promise<ExtractionOutput> {
  const prompt = ENTITY_EXTRACTION_PROMPT.replace('{TEXT}', text);
  const raw = await generator.generate(prompt, { temperature: 0.1, maxTokens: 2048, jsonMode: true });
  // ... same JSON parsing as before ...
}
```

### `src/reflect.ts` — `reflect()`

Change `ReflectConfig`:

```typescript
export interface ReflectConfig {
  dbPath: string;
  /** Generation provider for reflection. If not set, falls back to Ollama. */
  generator?: GenerationProvider;
  /** Ollama endpoint — used only if generator is not set (backward compat) */
  ollamaUrl?: string;
  /** Ollama model — used only if generator is not set (backward compat) */
  reflectModel?: string;
  batchSize?: number;
  minFactsThreshold?: number;
}
```

Replace the internal `ollamaGenerate()` call:

```typescript
// OLD:
const rawResponse = await ollamaGenerate(ollamaUrl, reflectModel, prompt);

// NEW:
const gen = config.generator ?? new OllamaGeneration(config.ollamaUrl, config.reflectModel);
const rawResponse = await gen.generate(prompt, { temperature: 0.3, maxTokens: 4096, jsonMode: true });
```

### `src/engram.ts` — thread generator through

The `Engram` class stores the generator and passes it to `processExtractions()` and `reflect()`:

```typescript
private readonly generator: GenerationProvider;

// In processExtractions():
async processExtractions(batchSize: number = 10) {
  return processExtractionQueue(this.db, this.generator, batchSize);
}

// In reflect():
async reflect() {
  return reflect({
    dbPath: this.dbPath,
    generator: this.generator,
  });
}
```

---

## MCP Server CLI Args

Update `src/mcp-server.ts` to accept generation provider flags:

```
npx engram-mcp ./agent.engram --use-ollama-embeddings --ollama-url http://192.168.1.57:11434

# OpenRouter for generation:
npx engram-mcp ./agent.engram --generation-endpoint https://openrouter.ai/api --generation-model anthropic/claude-haiku-4.5 --generation-api-key sk-or-...

# Anthropic direct:
npx engram-mcp ./agent.engram --anthropic-api-key sk-ant-... --anthropic-model claude-haiku-4-5-20251001

# Mix: Ollama for embeddings, OpenRouter for generation:
npx engram-mcp ./agent.engram --use-ollama-embeddings --ollama-url http://192.168.1.57:11434 --generation-endpoint https://openrouter.ai/api --generation-model deepseek/deepseek-r1 --generation-api-key sk-or-...
```

---

## Backward Compatibility

Zero breaking changes. If no `generator`, `generationEndpoint`, or `anthropicGeneration` is provided, the default is `OllamaGeneration` with `ollamaUrl` and `reflectModel` — exactly what exists today. All existing code, tests, configs, and integrations work unchanged.

---

## Common Configurations

```typescript
// Ollama (default — no change needed)
const engram = await Engram.create('./agent.engram', {
  ollamaUrl: 'http://192.168.1.57:11434',
});

// OpenRouter (cheapest cloud option)
const engram = await Engram.create('./agent.engram', {
  generationEndpoint: {
    baseUrl: 'https://openrouter.ai/api',
    model: 'anthropic/claude-haiku-4.5',
    apiKey: process.env.OPENROUTER_API_KEY,
  },
});

// Anthropic direct
const engram = await Engram.create('./agent.engram', {
  anthropicGeneration: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5-20251001',
  },
});

// Herd Pro (your unified gateway — speaks OpenAI-compat)
const engram = await Engram.create('./agent.engram', {
  generationEndpoint: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.1:8b',
  },
});

// Mixed: local embeddings + cloud generation
const engram = await Engram.create('./agent.engram', {
  useOllamaEmbeddings: false,  // local Transformers.js
  generationEndpoint: {
    baseUrl: 'https://openrouter.ai/api',
    model: 'deepseek/deepseek-r1',
    apiKey: process.env.OPENROUTER_API_KEY,
  },
});

// Testing: inject mock generator (same as MockEmbedder pattern)
const engram = await Engram.create('./test.engram', {
  embedder: new MockEmbedder(),
  generator: { name: 'mock', generate: async () => '{"entities":[],"relations":[]}' },
});
```

---

## Tests

Add to `tests/generation.test.ts`:

1. `OllamaGeneration` constructs correct URL and payload format
2. `OpenAICompatibleGeneration` constructs correct `/v1/chat/completions` payload
3. `AnthropicGeneration` constructs correct `/v1/messages` payload with headers
4. `jsonMode` adds `response_format` for OpenAI-compat and `format: 'json'` for Ollama
5. All providers include `name` property for logging
6. Injected mock generator works for `processExtractions()`
7. Injected mock generator works for `reflect()`
8. Default fallback to `OllamaGeneration` when no generator specified
9. `generationEndpoint` shorthand creates `OpenAICompatibleGeneration`
10. `anthropicGeneration` shorthand creates `AnthropicGeneration`

Use mock `fetch` via `vi.stubGlobal` — same pattern as existing Ollama tests. No real API calls.

---

## Files Changed

| Action | File | What |
|--------|------|------|
| CREATE | `src/generation.ts` | `GenerationProvider` interface + 3 implementations |
| MODIFY | `src/engram.ts` | Add generator to constructor, `EngramOptions`, provider selection |
| MODIFY | `src/retain.ts` | `processExtractionQueue()` accepts `GenerationProvider` instead of url+model |
| MODIFY | `src/reflect.ts` | `reflect()` accepts `GenerationProvider`, backward-compat with ollamaUrl |
| MODIFY | `src/mcp-server.ts` | Add `--generation-endpoint`, `--generation-model`, `--generation-api-key`, `--anthropic-api-key` CLI flags |
| CREATE | `tests/generation.test.ts` | 10 test cases |
| MODIFY | `tests/engram.test.ts` | Update processExtractions test to use mock generator |
| MODIFY | `tests/reflect.test.ts` | Update reflect test to use mock generator |

## Files NOT Changed

| File | Why |
|------|-----|
| `src/recall.ts` | Recall doesn't use generation |
| `src/local-embedder.ts` | Embeddings are a separate concern |
| `src/schema.sql` | No schema changes |
| `src/working-memory-types.ts` | No changes |
| `src/mcp-tools.ts` | Tool schemas unchanged — generation is internal |

---

## Verification

```bash
npm run typecheck  # clean
npm run build      # clean  
npm test           # all existing tests pass + new generation tests

# Manual: verify OpenRouter works
OPENROUTER_API_KEY=sk-or-... npx tsx -e "
  const { Engram } = await import('./dist/engram.js');
  const e = await Engram.create('/tmp/test-openrouter.engram', {
    generationEndpoint: {
      baseUrl: 'https://openrouter.ai/api',
      model: 'anthropic/claude-haiku-4.5',
      apiKey: process.env.OPENROUTER_API_KEY,
    },
  });
  await e.retain('Tom uses Terraform for Proxmox IaC', { memoryType: 'world' });
  const r = await e.processExtractions(1);
  console.log('Extraction result:', r);
  e.close();
"
```

---

## Implementation Order

This spec and the CPU Extraction Tier 1 spec should be implemented **together in one session**:

1. Create `src/generation.ts` — interface + 3 providers
2. Create `src/extract-cpu.ts` — Tier 1 CPU extractor
3. Modify `src/retain.ts` — add Tier 1 inline extraction + accept `GenerationProvider` for Tier 2
4. Modify `src/reflect.ts` — accept `GenerationProvider`
5. Modify `src/engram.ts` — thread both through constructor and options
6. Modify `src/mcp-server.ts` — add CLI flags
7. Write tests for both
8. Build and verify

Total estimate: 60-90 minutes for Claude Code.
