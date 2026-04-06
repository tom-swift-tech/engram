import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @xenova/transformers before importing LocalEmbedder.
// vi.mock is hoisted, so we use vi.hoisted() to share the mock fn.
// ---------------------------------------------------------------------------

const { mockPipelineFn } = vi.hoisted(() => {
  return { mockPipelineFn: vi.fn() };
});

vi.mock('@xenova/transformers', () => {
  return { pipeline: mockPipelineFn };
});

// Import after mock is set up
const { LocalEmbedder, clearPipelineCache } =
  await import('../src/local-embedder.js');

// Fake extractor: returns deterministic vectors based on text length
function fakeExtractor(text: string, _opts: unknown) {
  const dims = 768;
  const data = new Float32Array(dims);
  for (let i = 0; i < Math.min(text.length, dims); i++) {
    data[i] = text.charCodeAt(i) / 256;
  }
  return Promise.resolve({ data });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalEmbedder', () => {
  beforeEach(() => {
    clearPipelineCache();
    mockPipelineFn.mockReset();
    mockPipelineFn.mockResolvedValue(fakeExtractor);
  });

  afterEach(() => {
    clearPipelineCache();
  });

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------

  it('init() loads the pipeline on first call', async () => {
    const embedder = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder.init();
    expect(mockPipelineFn).toHaveBeenCalledWith(
      'feature-extraction',
      'Xenova/nomic-embed-text-v1.5',
      { quantized: true },
    );
  });

  it('init() is idempotent — second call does not re-load', async () => {
    const embedder = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder.init();
    await embedder.init();
    expect(mockPipelineFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // embed() and embedQuery()
  // -------------------------------------------------------------------------

  it('embed() returns a Float32Array of the correct dimensions', async () => {
    const embedder = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder.init();
    const vec = await embedder.embed('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
  });

  it('embedQuery() returns a Float32Array', async () => {
    const embedder = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder.init();
    const vec = await embedder.embedQuery('search term');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
  });

  it('embed() uses document prefix for nomic model', async () => {
    let capturedText = '';
    mockPipelineFn.mockResolvedValue((text: string, _opts: unknown) => {
      capturedText = text;
      return Promise.resolve({ data: new Float32Array(768) });
    });

    const embedder = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder.init();
    await embedder.embed('hello');
    expect(capturedText).toBe('search_document: hello');
  });

  it('embedQuery() uses query prefix for nomic model', async () => {
    let capturedText = '';
    mockPipelineFn.mockResolvedValue((text: string, _opts: unknown) => {
      capturedText = text;
      return Promise.resolve({ data: new Float32Array(768) });
    });

    const embedder = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder.init();
    await embedder.embedQuery('hello');
    expect(capturedText).toBe('search_query: hello');
  });

  it('MiniLM model does not use prefixes', async () => {
    let capturedText = '';
    mockPipelineFn.mockResolvedValue((text: string, _opts: unknown) => {
      capturedText = text;
      return Promise.resolve({ data: new Float32Array(384) });
    });

    const embedder = new LocalEmbedder('Xenova/all-MiniLM-L6-v2');
    await embedder.init();
    await embedder.embed('hello');
    expect(capturedText).toBe('hello');
  });

  // -------------------------------------------------------------------------
  // dimensions
  // -------------------------------------------------------------------------

  it('reports correct dimensions for known models', () => {
    expect(new LocalEmbedder('Xenova/nomic-embed-text-v1.5').dimensions).toBe(
      768,
    );
    expect(new LocalEmbedder('Xenova/all-MiniLM-L6-v2').dimensions).toBe(384);
  });

  it('throws for unknown models without explicit dimensions', () => {
    expect(() => new LocalEmbedder('unknown/model')).toThrow(
      'Unknown embedding model "unknown/model"',
    );
  });

  it('accepts unknown models when dimensions are provided', () => {
    const embedder = new LocalEmbedder('unknown/model', { dimensions: 1024 });
    expect(embedder.dimensions).toBe(1024);
  });

  // -------------------------------------------------------------------------
  // Pipeline failure + self-healing cache
  // -------------------------------------------------------------------------

  it('propagates pipeline initialization failure', async () => {
    mockPipelineFn.mockRejectedValueOnce(new Error('download failed'));

    const embedder = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await expect(embedder.init()).rejects.toThrow('download failed');
  });

  it('retries successfully after a failed initialization', async () => {
    // First call fails
    mockPipelineFn.mockRejectedValueOnce(new Error('network error'));

    const embedder1 = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await expect(embedder1.init()).rejects.toThrow('network error');

    // Second call succeeds — cache entry was evicted by the failure
    mockPipelineFn.mockResolvedValueOnce(fakeExtractor);

    const embedder2 = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder2.init();
    const vec = await embedder2.embed('test');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
  });

  it('concurrent init() calls share a single pipeline initialization', async () => {
    const embedder1 = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    const embedder2 = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');

    // Both init concurrently on a cold cache
    await Promise.all([embedder1.init(), embedder2.init()]);

    // pipeline() must be called exactly once — not twice
    expect(mockPipelineFn).toHaveBeenCalledTimes(1);
  });

  it('concurrent embed() calls on cold cache share one initialization', async () => {
    const embedder1 = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    const embedder2 = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');

    const [vec1, vec2] = await Promise.all([
      embedder1.embed('hello'),
      embedder2.embed('world'),
    ]);

    expect(mockPipelineFn).toHaveBeenCalledTimes(1);
    expect(vec1).toBeInstanceOf(Float32Array);
    expect(vec2).toBeInstanceOf(Float32Array);
  });

  it('does not retry when pipeline succeeds — uses cache', async () => {
    const embedder1 = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder1.init();

    const embedder2 = new LocalEmbedder('Xenova/nomic-embed-text-v1.5');
    await embedder2.init();

    // pipeline() should only be called once — the second init uses the cache
    expect(mockPipelineFn).toHaveBeenCalledTimes(1);
  });
});
