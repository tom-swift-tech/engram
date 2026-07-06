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
    // Was 'external_doc' — the tier that source_type maps to structurally
    // floors ranking below everything else (see recall.ts's tierOf), the
    // same floor a scraped webpage or other untrusted third-party source
    // would get. None of these categories are that: they're first-party
    // historical record — the importing agent's own logs, dreams,
    // decisions, and project notes. That mistagging is what caused a
    // rank-1-by-semantic-distance chunk to never surface in recall at all,
    // discovered the hard way importing ~2,100 chunks this way. agent_generated
    // matches how the SAME categories get classified on ongoing/live retain.
    sourceType: 'agent_generated',
    skipExtraction: false,
  },
  daily: {
    memoryType: 'experience',
    trustScore: 0.70,
    // Was 'external_doc' — the tier that source_type maps to structurally
    // floors ranking below everything else (see recall.ts's tierOf), the
    // same floor a scraped webpage or other untrusted third-party source
    // would get. None of these categories are that: they're first-party
    // historical record — the importing agent's own logs, dreams,
    // decisions, and project notes. That mistagging is what caused a
    // rank-1-by-semantic-distance chunk to never surface in recall at all,
    // discovered the hard way importing ~2,100 chunks this way. agent_generated
    // matches how the SAME categories get classified on ongoing/live retain.
    sourceType: 'agent_generated',
    skipExtraction: false,
  },
  decision: {
    memoryType: 'world',
    trustScore: 0.85,
    // Was 'external_doc' — the tier that source_type maps to structurally
    // floors ranking below everything else (see recall.ts's tierOf), the
    // same floor a scraped webpage or other untrusted third-party source
    // would get. None of these categories are that: they're first-party
    // historical record — the importing agent's own logs, dreams,
    // decisions, and project notes. That mistagging is what caused a
    // rank-1-by-semantic-distance chunk to never surface in recall at all,
    // discovered the hard way importing ~2,100 chunks this way. agent_generated
    // matches how the SAME categories get classified on ongoing/live retain.
    sourceType: 'agent_generated',
    skipExtraction: false,
  },
  dream: {
    memoryType: 'experience',
    trustScore: 0.60,
    // Was 'external_doc' — the tier that source_type maps to structurally
    // floors ranking below everything else (see recall.ts's tierOf), the
    // same floor a scraped webpage or other untrusted third-party source
    // would get. None of these categories are that: they're first-party
    // historical record — the importing agent's own logs, dreams,
    // decisions, and project notes. That mistagging is what caused a
    // rank-1-by-semantic-distance chunk to never surface in recall at all,
    // discovered the hard way importing ~2,100 chunks this way. agent_generated
    // matches how the SAME categories get classified on ongoing/live retain.
    sourceType: 'agent_generated',
    skipExtraction: true,
  },
  project: {
    memoryType: 'world',
    trustScore: 0.80,
    // Was 'external_doc' — the tier that source_type maps to structurally
    // floors ranking below everything else (see recall.ts's tierOf), the
    // same floor a scraped webpage or other untrusted third-party source
    // would get. None of these categories are that: they're first-party
    // historical record — the importing agent's own logs, dreams,
    // decisions, and project notes. That mistagging is what caused a
    // rank-1-by-semantic-distance chunk to never surface in recall at all,
    // discovered the hard way importing ~2,100 chunks this way. agent_generated
    // matches how the SAME categories get classified on ongoing/live retain.
    sourceType: 'agent_generated',
    skipExtraction: false,
  },
  reference: {
    memoryType: 'world',
    trustScore: 0.85,
    // Was 'external_doc' — the tier that source_type maps to structurally
    // floors ranking below everything else (see recall.ts's tierOf), the
    // same floor a scraped webpage or other untrusted third-party source
    // would get. None of these categories are that: they're first-party
    // historical record — the importing agent's own logs, dreams,
    // decisions, and project notes. That mistagging is what caused a
    // rank-1-by-semantic-distance chunk to never surface in recall at all,
    // discovered the hard way importing ~2,100 chunks this way. agent_generated
    // matches how the SAME categories get classified on ongoing/live retain.
    sourceType: 'agent_generated',
    skipExtraction: true,
  },
  memo: {
    memoryType: 'world',
    trustScore: 0.75,
    // Was 'external_doc' — the tier that source_type maps to structurally
    // floors ranking below everything else (see recall.ts's tierOf), the
    // same floor a scraped webpage or other untrusted third-party source
    // would get. None of these categories are that: they're first-party
    // historical record — the importing agent's own logs, dreams,
    // decisions, and project notes. That mistagging is what caused a
    // rank-1-by-semantic-distance chunk to never surface in recall at all,
    // discovered the hard way importing ~2,100 chunks this way. agent_generated
    // matches how the SAME categories get classified on ongoing/live retain.
    sourceType: 'agent_generated',
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
