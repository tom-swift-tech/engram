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

  constructor(options?: { url?: string; model?: string }) {
    this.url = options?.url ?? DEFAULT_OLLAMA_URL; // exported above
    this.model = options?.model ?? 'llama3.1:8b';
    this.name = `ollama/${this.model}`;
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

    const res = await fetch(`${this.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

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

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? 'claude-haiku-4-5-20251001';
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
