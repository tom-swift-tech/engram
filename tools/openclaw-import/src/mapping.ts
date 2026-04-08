import type { FileCategory } from './types.js';

export interface CategoryMapping {
  memoryType: 'world' | 'experience' | 'observation' | 'opinion';
  trustScore: number;
  sourceType: 'user_stated' | 'inferred' | 'external_doc' | 'tool_result' | 'agent_generated';
  skipExtraction: boolean;
}

const MAPPINGS: Record<FileCategory, CategoryMapping> = {
  core: {
    memoryType: 'world',
    trustScore: 0.90,
    sourceType: 'external_doc',
    skipExtraction: false,
  },
  daily: {
    memoryType: 'experience',
    trustScore: 0.70,
    sourceType: 'external_doc',
    skipExtraction: false,
  },
  decision: {
    memoryType: 'world',
    trustScore: 0.85,
    sourceType: 'external_doc',
    skipExtraction: false,
  },
  dream: {
    memoryType: 'experience',
    trustScore: 0.60,
    sourceType: 'external_doc',
    skipExtraction: true,
  },
  project: {
    memoryType: 'world',
    trustScore: 0.80,
    sourceType: 'external_doc',
    skipExtraction: false,
  },
  reference: {
    memoryType: 'world',
    trustScore: 0.85,
    sourceType: 'external_doc',
    skipExtraction: true,
  },
  memo: {
    memoryType: 'world',
    trustScore: 0.75,
    sourceType: 'external_doc',
    skipExtraction: false,
  },
};

export function mapCategory(
  category: FileCategory,
  isRootDaily: boolean,
): CategoryMapping {
  const mapping = { ...MAPPINGS[category] };
  if (category === 'daily' && isRootDaily) {
    mapping.trustScore = 0.75;
  }
  return mapping;
}
