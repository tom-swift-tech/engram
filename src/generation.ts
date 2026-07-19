// =============================================================================
// generation.ts — Generation Provider Interface & Implementations
//
// Abstracts text generation behind a common interface so Engram can use
// Ollama, any OpenAI-compatible endpoint, or Anthropic for extraction and
// reflection without coupling to a specific provider.
//
// All implementations use Node.js built-in fetch() — no external HTTP deps.
// =============================================================================

/** Canonical default Ollama endpoint. Override per-instance via the url option. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

// =============================================================================
// Types
// =============================================================================

export interface GenerationOptions {
  /** Sampling temperature (default 0.1). */
  temperature?: number;
  /** Maximum tokens to generate (default 4096). */
  maxTokens?: number;
  /** Request JSON output from the model. */
  jsonMode?: boolean;
}

// =============================================================================
// GenerationProvider Interface
// =============================================================================

export interface GenerationProvider {
  /** Human-readable provider/model identifier, e.g. "ollama/llama3.1:8b". */
  readonly name: string;

  /** Generate a text completion for the given prompt. */
  generate(prompt: string, options?: GenerationOptions): Promise<string>;
}

// =============================================================================
// OllamaGeneration
// =============================================================================

export class OllamaGeneration implements GenerationProvider {
  readonly name: string;
  private url: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: { url?: string; model: string; timeoutMs?: number }) {
    // Model is REQUIRED. The library applies no default model name: an unset
    // model must be un-runnable, not quietly-runnable on the wrong thing.
    // Choose the model via model-resolver.ts before constructing this.
    if (!options?.model || !options.model.trim()) {
      throw new Error(
        'OllamaGeneration requires an explicit, non-empty model name. ' +
          'The library no longer falls back to a default model — ' +
          'resolve one via model-resolver.ts (ENGRAM_<ROLE>_MODEL / ENGRAM_MODEL).',
      );
    }
    this.url = options.url ?? DEFAULT_OLLAMA_URL; // exported above
    this.model = options.model;
    this.name = `ollama/${this.model}`;
    // Cold-start model loads on a real GPU backend can legitimately take
    // 100s+ (measured ~112s on one deployment's setup); this bounds the
    // absolute worst case rather than trying to distinguish cold-start from
    // a genuinely stuck request. Without this, a plain fetch() with no
    // signal has no way to time out at all — found by tracing why a
    // 30-second Promise.race timeout in a caller's shutdown-flush path
    // didn't actually bound wall-clock time: the race lets the *caller*
    // move on, but never cancels this fetch, so the process itself stayed
    // alive (and a spawned child's exit event never fired) until Ollama
    // eventually responded — anywhere from seconds to several minutes
    // under load, not the 30s the caller assumed.
    this.timeoutMs = options?.timeoutMs ?? 120_000;
  }

  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    const temperature = options?.temperature ?? 0.1;
    const maxTokens = options?.maxTokens ?? 4096;

    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: false,
      options: {
        temperature,
        num_predict: maxTokens,
      },
    };

    if (options?.jsonMode) {
      body.format = 'json';
    }

    let res: Response;
    try {
      res = await fetch(`${this.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(
          `Ollama generation timed out after ${this.timeoutMs / 1000}s (${this.url})`,
          {
            cause: err,
          },
        );
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama generation failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { response: string };
    return data.response;
  }
}

// =============================================================================
// OpenAICompatibleGeneration
// =============================================================================

/**
 * Generation provider for any OpenAI-compatible chat completions API.
 *
 * Tested with: Ollama (localhost), xAI / Grok (api.x.ai, grok-3-mini),
 * OpenRouter, LM Studio, and vLLM.
 *
 * @example
 * ```ts
 * const gen = new OpenAICompatibleGeneration('https://api.x.ai', 'grok-3-mini', process.env.XAI_API_KEY);
 * const engram = await Engram.create('./agent.engram', { generator: gen });
 * ```
 */
export class OpenAICompatibleGeneration implements GenerationProvider {
  readonly name: string;
  private baseUrl: string;
  private model: string;
  private apiKey?: string;

  constructor(baseUrl: string, model: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = apiKey;
    this.name = `openai-compat/${this.model}`;
  }

  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    const temperature = options?.temperature ?? 0.1;
    const maxTokens = options?.maxTokens ?? 4096;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    };

    if (options?.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `OpenAI-compatible generation failed (${res.status}): ${text}`,
      );
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? '';
  }
}

// =============================================================================
// AnthropicGeneration
// =============================================================================

export class AnthropicGeneration implements GenerationProvider {
  readonly name: string;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    // Model is REQUIRED — same rule as OllamaGeneration. No hardcoded default.
    if (!model || !model.trim()) {
      throw new Error(
        'AnthropicGeneration requires an explicit, non-empty model name. ' +
          'The library no longer falls back to a default model.',
      );
    }
    this.apiKey = apiKey;
    this.model = model;
    this.name = `anthropic/${this.model}`;
  }

  async generate(prompt: string, options?: GenerationOptions): Promise<string> {
    const temperature = options?.temperature ?? 0.1;
    const maxTokens = options?.maxTokens ?? 4096;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic generation failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ text: string }>;
    };
    return data.content?.[0]?.text ?? '';
  }
}

// =============================================================================
// UnconfiguredGeneration — fail-loud placeholder
// =============================================================================

/**
 * A generator that carries no model and refuses to run.
 *
 * Installed by `Engram.open` when no generator/model is configured. It exists
 * so that an Engram can still retain/recall with zero generation config (those
 * paths never touch the generator), while the FIRST reflect()/extract() call on
 * an unconfigured engram fails loudly — which, for a background/cron generation
 * job, is that job's startup. This is the deliberate inverse of a silent
 * default: it can never run generation on the wrong model, because it runs on
 * no model at all.
 */
export class UnconfiguredGeneration implements GenerationProvider {
  readonly name = 'unconfigured';

  async generate(): Promise<string> {
    throw new Error(
      'No generation model is configured for this Engram. ' +
        'reflect() and entity extraction require a model — pass reflectModel, ' +
        'generator, anthropicGeneration, or generationEndpoint to Engram.open(), ' +
        'or set ENGRAM_MODEL / ENGRAM_<ROLE>_MODEL. ' +
        'The library applies no default model.',
    );
  }
}
