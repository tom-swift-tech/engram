-- Deterministic test data for engram-aql integration tests.

-- Semantic (world) facts
INSERT INTO chunks (id, text, memory_type, trust_score, source_type, context, created_at)
VALUES
    ('s-001', '{"concept":"terraform","note":"IaC tool"}', 'world', 0.9, 'user_stated', 'infra', '2026-03-01 10:00:00'),
    ('s-002', '{"concept":"proxmox","note":"hypervisor"}', 'world', 0.85, 'user_stated', 'infra', '2026-03-02 10:00:00'),
    ('s-003', '{"concept":"wal","note":"SQLite mode"}', 'world', 0.8, 'inferred', 'storage', '2026-03-03 10:00:00');

-- Episodic (experience) events
INSERT INTO chunks (id, text, memory_type, trust_score, source_type, context, created_at)
VALUES
    ('e-001', '{"event":"deploy","outcome":"success","confidence":0.9}', 'experience', 0.9, 'agent_generated', 'ops', '2026-03-10 08:00:00'),
    ('e-002', '{"event":"deploy","outcome":"failure","confidence":0.3}', 'experience', 0.7, 'agent_generated', 'ops', '2026-03-11 09:00:00'),
    ('e-003', '{"event":"test","outcome":"success","confidence":0.8}', 'experience', 0.8, 'agent_generated', 'ci',  '2026-03-12 10:00:00'),
    ('e-004', '{"event":"deploy","outcome":"success","confidence":0.85}','experience', 0.85,'agent_generated', 'ops', '2026-03-13 11:00:00');

-- Working memory sessions
INSERT INTO working_memory (id, data_json, seed_query)
VALUES
    ('w-001', '{"goal":"plan deployment","progress":"outlining"}', 'plan deployment'),
    ('w-002', '{"goal":"review code","progress":"started"}', 'review code');

-- Observations (procedural knowledge)
INSERT INTO observations (id, summary, domain, topic, source_chunks)
VALUES
    ('o-001', 'Blue-green deployment reduces rollback risk', 'ops', 'deployment', '["e-001","e-004"]'),
    ('o-002', 'Failed deploys correlate with Friday pushes', 'ops', 'deployment', '["e-002"]');

-- Opinions (confidence-scored beliefs formed from experience)
INSERT INTO opinions (id, belief, confidence, domain, evidence_count, supporting_chunks, related_entities)
VALUES
    ('op-001', 'Blue-green deployment is safer than rolling restart', 0.85, 'ops', 2, '["e-001","e-004"]', '["ent-deploy","ent-bluegreen"]'),
    ('op-002', 'Friday deploys are riskier than weekday deploys',    0.70, 'ops', 1, '["e-002"]',          '["ent-deploy"]'),
    ('op-003', 'CI smoke tests catch most deployment failures',     0.60, 'ci',  1, '["e-003"]',          '[]');

-- Tools registry
INSERT INTO tools (id, name, description, api_url, ranking, tags)
VALUES
    ('t-001', 'resize', 'Resize images', 'https://api/resize', 0.9, '["image"]'),
    ('t-002', 'compress', 'Compress files', 'https://api/compress', 0.7, '["storage"]'),
    ('t-003', 'convert', 'Convert formats', 'https://api/convert', 0.5, '["image","file"]');

-- Entities and relations for graph traversal
INSERT INTO entities (id, name, canonical_name, entity_type)
VALUES
    ('ent-deploy', 'deploy', 'deploy', 'concept'),
    ('ent-bluegreen', 'blue-green', 'blue-green', 'concept'),
    ('ent-rollback', 'rollback', 'rollback', 'concept');

INSERT INTO chunk_entities (chunk_id, entity_id, mention_type)
VALUES
    ('e-001', 'ent-deploy', 'subject'),
    ('e-004', 'ent-deploy', 'subject'),
    ('s-001', 'ent-bluegreen', 'reference');

INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, confidence)
VALUES
    ('r-001', 'ent-deploy', 'ent-bluegreen', 'uses_pattern', 0.8),
    ('r-002', 'ent-bluegreen', 'ent-rollback', 'avoids', 0.9);
