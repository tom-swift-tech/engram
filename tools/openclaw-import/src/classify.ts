import { glob } from 'glob';
import { resolve, basename } from 'path';
import type { ClassifiedFile, FileCategory } from './types.js';

export const SKIP_PATTERNS: RegExp[] = [
  /\.(log|json|txt|html|jsonl)$/,
  /\.backup(\.\d+)?$/,
  /\.old$/,
  /\.prev$/,
  /visual-prompt/,
  /^chat-archives\//,
  /^baselines\//,
  /^x-digests\//,
  /^dreams\/images\//,
  /^content-drafts\//,
  /^dreams\/visual-prompts\//,
  /heartbeat-metrics/,
];

interface ClassifyResult {
  category: FileCategory;
  isRootDaily: boolean;
}

export function classifyPath(relativePath: string): ClassifyResult {
  const normalized = relativePath.replace(/\\/g, '/');

  if (/^core\//.test(normalized)) {
    return { category: 'core', isRootDaily: false };
  }

  if (normalized === 'relationships.md') {
    return { category: 'core', isRootDaily: false };
  }

  if (/^daily\//.test(normalized)) {
    return { category: 'daily', isRootDaily: false };
  }

  if (/^decisions\//.test(normalized)) {
    return { category: 'decision', isRootDaily: false };
  }

  if (/^dreams\/.*-creative\.md$/.test(normalized)) {
    return { category: 'dream', isRootDaily: false };
  }

  if (/^dreams\//.test(normalized)) {
    return { category: 'reference', isRootDaily: false };
  }

  if (/^projects\//.test(normalized)) {
    return { category: 'project', isRootDaily: false };
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(basename(normalized))) {
    return { category: 'daily', isRootDaily: true };
  }

  if (normalized === 'INDEX.md') {
    return { category: 'reference', isRootDaily: false };
  }

  return { category: 'memo', isRootDaily: false };
}

export function shouldSkip(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return SKIP_PATTERNS.some((p) => p.test(normalized));
}

export async function discoverAndClassify(
  inputDir: string,
): Promise<{ files: ClassifiedFile[]; skipped: number }> {
  const pattern = '**/*.md';
  const allMdFiles = await glob(pattern, {
    cwd: inputDir,
    nodir: true,
    posix: true,
  });

  const allNonMd = await glob('**/*', {
    cwd: inputDir,
    nodir: true,
    posix: true,
    ignore: ['**/*.md'],
  });

  let skippedMd = 0;
  const files: ClassifiedFile[] = [];

  for (const relPath of allMdFiles) {
    if (shouldSkip(relPath)) {
      skippedMd++;
      continue;
    }
    const { category, isRootDaily } = classifyPath(relPath);
    files.push({
      path: resolve(inputDir, relPath),
      relativePath: relPath,
      category,
      isRootDaily,
    });
  }

  return { files, skipped: skippedMd + allNonMd.length };
}
