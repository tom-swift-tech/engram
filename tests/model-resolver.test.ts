import { describe, it, expect } from 'vitest';
import {
  resolveModelSpec,
  resolveModelSpecOrNull,
  isModelServed,
  preflightModel,
  formatPreflightFailure,
  type ModelSpec,
} from '../src/model-resolver.js';

// A fake fetch returning an Ollama /api/tags payload, capturing the URL.
function fakeTagsFetch(
  models: string[],
  opts: { ok?: boolean; status?: number; throwErr?: string } = {},
) {
  const calls: string[] = [];
  const fn = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url));
    if (opts.throwErr) throw new Error(opts.throwErr);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => ({ models: models.map((name) => ({ name })) }),
      text: async () => '',
    } as unknown as Response;
  };
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

describe('resolveModelSpec — model selection precedence', () => {
  it('prefers an explicit model over env', () => {
    const spec = resolveModelSpec({
      role: 'reflect',
      explicitModel: 'explicit:model',
      env: {
        ENGRAM_REFLECT_MODEL: 'role:model',
        ENGRAM_MODEL: 'general:model',
      },
    });
    expect(spec.model).toBe('explicit:model');
  });

  it('prefers the role-specific env var over the general one', () => {
    const spec = resolveModelSpec({
      role: 'extract',
      env: {
        ENGRAM_EXTRACT_MODEL: 'role:model',
        ENGRAM_MODEL: 'general:model',
      },
    });
    expect(spec.model).toBe('role:model');
  });

  it('falls back to ENGRAM_MODEL when no role-specific var is set', () => {
    const spec = resolveModelSpec({
      role: 'integration',
      env: { ENGRAM_MODEL: 'general:model' },
    });
    expect(spec.model).toBe('general:model');
  });

  it('throws when no model is configured — no silent default', () => {
    expect(() => resolveModelSpec({ role: 'reflect', env: {} })).toThrow(
      /No generation model configured for role "reflect"/,
    );
  });

  it('treats whitespace-only config as unconfigured (throws)', () => {
    expect(() =>
      resolveModelSpec({ role: 'reflect', env: { ENGRAM_MODEL: '   ' } }),
    ).toThrow(/No generation model configured/);
  });

  it('never resolves to a hardcoded model name', () => {
    // The point of the whole change: with nothing configured, you get an error,
    // never "llama3.1:8b" or any other baked-in string.
    let resolved: string | undefined;
    try {
      resolved = resolveModelSpec({ role: 'reflect', env: {} }).model;
    } catch {
      resolved = undefined;
    }
    expect(resolved).toBeUndefined();
  });
});

describe('resolveModelSpec — host resolution', () => {
  it('defaults the host to localhost (host default is safe; model default is not)', () => {
    const spec = resolveModelSpec({
      role: 'reflect',
      env: { ENGRAM_MODEL: 'm:1' },
    });
    expect(spec.host).toBe('http://localhost:11434');
    expect(spec.isRemote).toBe(false);
  });

  it('prefers an explicit host, then role host, then ENGRAM_OLLAMA_URL', () => {
    expect(
      resolveModelSpec({
        role: 'reflect',
        explicitModel: 'm:1',
        explicitHost: 'http://explicit:1',
        env: {
          ENGRAM_REFLECT_HOST: 'http://role:2',
          ENGRAM_OLLAMA_URL: 'http://gen:3',
        },
      }).host,
    ).toBe('http://explicit:1');

    expect(
      resolveModelSpec({
        role: 'reflect',
        env: {
          ENGRAM_MODEL: 'm:1',
          ENGRAM_REFLECT_HOST: 'http://role:2',
          ENGRAM_OLLAMA_URL: 'http://gen:3',
        },
      }).host,
    ).toBe('http://role:2');
  });

  it('flags a :cloud model as remote', () => {
    const spec = resolveModelSpec({
      role: 'reflect',
      explicitModel: 'gpt-oss:cloud',
      env: {},
    });
    expect(spec.isRemote).toBe(true);
  });

  it('flags a non-LAN host as remote', () => {
    const spec = resolveModelSpec({
      role: 'reflect',
      explicitModel: 'm:1',
      explicitHost: 'https://ollama.example.com',
      env: {},
    });
    expect(spec.isRemote).toBe(true);
  });
});

describe('resolveModelSpecOrNull', () => {
  it('returns null when unconfigured (no throw)', () => {
    expect(resolveModelSpecOrNull({ role: 'reflect', env: {} })).toBeNull();
  });

  it('returns a spec when configured', () => {
    const spec = resolveModelSpecOrNull({
      role: 'reflect',
      env: { ENGRAM_MODEL: 'm:1' },
    });
    expect(spec?.model).toBe('m:1');
  });
});

describe('isModelServed', () => {
  it('matches an exact tagged name', () => {
    expect(isModelServed('llama3.1:8b', ['llama3.1:8b', 'nomic:latest'])).toBe(
      true,
    );
  });

  it('matches an untagged config against the :latest served name', () => {
    expect(isModelServed('llama3.1', ['llama3.1:latest'])).toBe(true);
  });

  it('does not match a different tag', () => {
    expect(isModelServed('llama3.1:70b', ['llama3.1:8b'])).toBe(false);
  });

  it('does not match when absent', () => {
    expect(isModelServed('qwen:7b', ['llama3.1:8b'])).toBe(false);
  });
});

describe('preflightModel', () => {
  const spec: ModelSpec = {
    host: 'http://localhost:11434',
    model: 'llama3.1:8b',
    isRemote: false,
  };

  it('passes when the host serves the model', async () => {
    const { fn, calls } = fakeTagsFetch(['llama3.1:8b', 'nomic:latest']);
    const r = await preflightModel(spec, { fetch: fn });
    expect(r.ok).toBe(true);
    expect(calls[0]).toBe('http://localhost:11434/api/tags');
    expect(r.servedModels).toContain('llama3.1:8b');
  });

  it('fails with the served list when the model is missing', async () => {
    const { fn } = fakeTagsFetch(['some-other:model']);
    const r = await preflightModel(spec, { fetch: fn });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not served/);
    expect(r.servedModels).toEqual(['some-other:model']);
  });

  it('fails when the host is unreachable', async () => {
    const { fn } = fakeTagsFetch([], { throwErr: 'ECONNREFUSED' });
    const r = await preflightModel(spec, { fetch: fn });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unreachable/);
    expect(r.servedModels).toBeUndefined();
  });

  it('fails on a non-200 tags response', async () => {
    const { fn } = fakeTagsFetch([], { ok: false, status: 500 });
    const r = await preflightModel(spec, { fetch: fn });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/);
  });
});

describe('formatPreflightFailure', () => {
  it('lists the served models', () => {
    const line = formatPreflightFailure({
      ok: false,
      host: 'http://localhost:11434',
      model: 'llama3.1:8b',
      isRemote: false,
      servedModels: ['a:1', 'b:2'],
      error: 'model "llama3.1:8b" is not served',
    });
    expect(line).toMatch(/Host serves: a:1, b:2/);
    expect(line).not.toMatch(/remote/);
  });

  it('flags a remote/:cloud model', () => {
    const line = formatPreflightFailure({
      ok: false,
      host: 'http://localhost:11434',
      model: 'gpt-oss:cloud',
      isRemote: true,
      error: 'host unreachable',
    });
    expect(line).toMatch(/remote\/:cloud/);
  });
});
