// tests/aql-schema.test.ts
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';

describe('AQL schema additions', () => {
  it('tools table exists with expected columns', () => {
    const db = createTestDb();
    const columns = db.pragma('table_info(tools)') as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    expect(names).toContain('description');
    expect(names).toContain('api_url');
    expect(names).toContain('ranking');
    expect(names).toContain('tags');
    expect(names).toContain('namespace');
    expect(names).toContain('scope');
    expect(names).toContain('is_active');
    db.close();
  });

  it('tools table supports CRUD operations', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tools (id, name, description, api_url, ranking)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('t-001', 'image_resize', 'Resize images', 'https://api.example.com/resize', 0.9);

    const row = db
      .prepare(`SELECT * FROM tools WHERE id = ?`)
      .get('t-001') as Record<string, unknown>;
    expect(row.name).toBe('image_resize');
    expect(row.ranking).toBe(0.9);
    expect(row.is_active).toBe(1);

    db.prepare(`UPDATE tools SET is_active = FALSE WHERE id = ?`).run('t-001');
    const updated = db
      .prepare(`SELECT is_active FROM tools WHERE id = ?`)
      .get('t-001') as { is_active: number };
    expect(updated.is_active).toBe(0);
    db.close();
  });

  it('tools table has ranking index for LOAD queries', () => {
    const db = createTestDb();
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tools'`)
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_tools_ranking');
    db.close();
  });
});
