import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  OllamaGeneration,
  OpenAICompatibleGeneration,
  AnthropicGeneration,
} from '../src/generation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock fetch that captures the call and returns a canned response. */
function mockFetch(responseBody: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fn = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: url as string, init: init! });
    return {
      ok,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as unknown as Response;
  };

  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// OllamaGeneration
// ---------------------------------------------------------------------------

describe('OllamaGeneration', () => {
  it('has correct name', () => {
    const gen = new OllamaGeneration();
    expect(gen.name).toBe('ollama/llama3.1:8b');
  });

  it('sends correct URL and payload, returns data.response', async () => {
    const calls = mockFetch({ response: 'hello world' });

    const gen = new OllamaGeneration();
    const result = await gen.generate('test prompt');

    expect(result).toBe('hello world');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:11434/api/generate');

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('llama3.1:8b');
    expect(body.prompt).toBe('test prompt');
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0.1);
    expect(body.options.num_predict).toBe(4096);
  });

  it('includes format: json when jsonMode is true', async () => {
    const calls = mockFetch({ response: '{}' });

    const gen = new OllamaGeneration();
    await gen.generate('test', { jsonMode: true });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.format).toBe('json');
  });

  it('throws on non-ok response', async () => {
    mockFetch({ error: 'bad' }, false, 500);

    const gen = new OllamaGeneration();
    await expect(gen.generate('test')).rejects.toThrow(
      'Ollama generation failed (500)',
    );
  });
});

// ---------------------------------------------------------------------------
// OpenAICompatibleGeneration
// ---------------------------------------------------------------------------

describe('OpenAICompatibleGeneration', () => {
  it('has correct name', () => {
    const gen = new OpenAICompatibleGeneration(
      'http://localhost:8080',
      'gpt-4o',
    );
    expect(gen.name).toBe('openai-compat/gpt-4o');
  });

  it('sends correct /v1/chat/completions payload with messages array', async () => {
    const calls = mockFetch({
      choices: [{ message: { content: 'reply' } }],
    });

    const gen = new OpenAICompatibleGeneration(
      'http://localhost:8080',
      'gpt-4o',
    );
    const result = await gen.generate('test prompt');

    expect(result).toBe('reply');
    expect(calls[0].url).toBe('http://localhost:8080/v1/chat/completions');

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('gpt-4o');
    expect(body.messages).toEqual([{ role: 'user', content: 'test prompt' }]);
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(4096);
  });

  it('includes Authorization header when apiKey is set', async () => {
    const calls = mockFetch({
      choices: [{ message: { content: 'ok' } }],
    });

    const gen = new OpenAICompatibleGeneration(
      'http://localhost:8080',
      'gpt-4o',
      'sk-test-key',
    );
    await gen.generate('test');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key');
  });

  it('includes response_format when jsonMode is true', async () => {
    const calls = mockFetch({
      choices: [{ message: { content: '{}' } }],
    });

    const gen = new OpenAICompatibleGeneration(
      'http://localhost:8080',
      'gpt-4o',
    );
    await gen.generate('test', { jsonMode: true });

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('throws on non-ok response', async () => {
    mockFetch({ error: 'bad' }, false, 401);

    const gen = new OpenAICompatibleGeneration(
      'http://localhost:8080',
      'gpt-4o',
    );
    await expect(gen.generate('test')).rejects.toThrow(
      'OpenAI-compatible generation failed (401)',
    );
  });
});

// ---------------------------------------------------------------------------
// AnthropicGeneration
// ---------------------------------------------------------------------------

describe('AnthropicGeneration', () => {
  it('has correct name', () => {
    const gen = new AnthropicGeneration('sk-ant-test');
    expect(gen.name).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('sends correct payload with x-api-key and anthropic-version headers', async () => {
    const calls = mockFetch({
      content: [{ text: 'response text' }],
    });

    const gen = new AnthropicGeneration(
      'sk-ant-test',
      'claude-sonnet-4-20250514',
    );
    const result = await gen.generate('test prompt', {
      temperature: 0.5,
      maxTokens: 1024,
    });

    expect(result).toBe('response text');
    expect(gen.name).toBe('anthropic/claude-sonnet-4-20250514');
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.messages).toEqual([{ role: 'user', content: 'test prompt' }]);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(1024);
  });

  it('throws on non-ok response', async () => {
    mockFetch({ error: 'bad' }, false, 429);

    const gen = new AnthropicGeneration('sk-ant-test');
    await expect(gen.generate('test')).rejects.toThrow(
      'Anthropic generation failed (429)',
    );
  });
});
