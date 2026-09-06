import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../../src/memory/core.js";
import { getDb, closeDb } from "../../src/db/database.js";
import { setConfigDir, resetConfig } from "../../src/memory/config.js";
import { addEvidence } from "../../src/memory/evidence.js";
import { handleMemoryRead, handleSemanticSearch, setNotifyChange } from "../../src/server/handlers.js";
import { TOOLS } from "../../src/server/tools.js";
import type { RecallExplanation } from "../../src/memory/recall-explanation.js";

let dir: string;
beforeEach(() => {
  closeDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-explain-'));
  core.setMemoryDir(dir);
  setConfigDir(dir);
  resetConfig();
  setNotifyChange(() => {});
  mock.method(Date, 'now', () => Date.parse('2026-09-06T00:00:00Z'));
  getDb().db.exec(`INSERT INTO memories(legacy_id, title, fragment, type, project, source, confidence, created_at, last_accessed_at) VALUES
    ('m-local', 'Retry timeout', 'Retry timeout with exponential delay', 'fact', 'project-a', 'user', 0.4, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'),
    ('m-global', 'Retry policy', 'Retry failed network operations', 'pattern', NULL, 'ai', 0.8, '2026-08-01T00:00:00Z', NULL),
    ('m-other', 'Retry private', 'Retry timeout private project secret', 'fact', 'project-b', 'ai', 0.9, '2026-09-03T00:00:00Z', NULL)`);
});
afterEach(() => {
  mock.restoreAll();
  closeDb();
  core.setMemoryDir(path.join(os.homedir(), '.lemma'));
  setConfigDir(path.join(os.homedir(), '.lemma'));
  resetConfig();
  fs.rmSync(dir, { recursive: true, force: true });
});

function explanation(result: Awaited<ReturnType<typeof handleMemoryRead>>): RecallExplanation {
  assert.ok(!result.isError);
  return (result.structuredContent as { recall_explanation: RecallExplanation }).recall_explanation;
}
function verifyOn() {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ verification: { stale_check: true } }));
  resetConfig();
}
function cite(file: string, snippet = 'const retry = true;', id = 'm-local') {
  const row = getDb().db.prepare('SELECT id FROM memories WHERE legacy_id=?').get(id) as { id: number };
  addEvidence(getDb(), row.id, { file, snippet, symbol: 'retry' });
}

test('explanation is opt-in for read and semantic search and is discoverable without new tools', async () => {
  for (const flag of [undefined, false]) {
    const read = await handleMemoryRead({ project: 'project-a', explain: flag });
    assert.equal(explanation(read), undefined);
    assert.doesNotMatch(read.content[0].text, /Why these memories/);
    const search = await handleSemanticSearch({ query: 'retry', project: 'project-a', explain: flag });
    assert.equal(explanation(search), undefined);
  }
  for (const name of ['memory_read', 'semantic_search']) {
    const tool = TOOLS.find(tool => tool.name === name)!;
    assert.equal(tool.inputSchema.properties.explain.type, 'boolean');
    assert.ok(tool.outputSchema?.properties.recall_explanation);
  }
});

test('explicit ID explains the current request and captures provenance BEFORE the normal access boost', async () => {
  const result = await handleMemoryRead({ id: 'm-local', explain: true, response_format: 'json' });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const info = explanation(result);
  assert.equal(info.applies_to, 'this_call');
  assert.equal(info.scope.mode, 'explicit_ids');
  assert.match(info.notice, /not a past recall/);
  const item = info.items[0];
  assert.equal(item.selection?.method, 'explicit_id');
  assert.equal(item.selection?.rank, null);
  assert.equal(item.selection?.score, null);
  assert.equal(item.provenance?.recorded_source, 'user');
  assert.equal(item.provenance?.confidence_before_read, 0.4);
  assert.equal(item.provenance?.last_accessed_before_read, '2026-09-02T00:00:00Z');
  assert.equal(item.freshness?.status, 'no_evidence');
  assert.equal(item.freshness?.checked_at, null);
  assert.ok(core.getFragmentById('m-local')!.confidence > 0.4, 'existing access boost still happens');
  assert.ok(info.correction_tools.some(action => action.tool === 'memory_forget' && /invalidate=true/.test(action.use)));
});

test('batch IDs includes only found records and honors JSON output', async () => {
  const result = await handleMemoryRead({ ids: ['m-local', 'missing', 'm-global'], explain: true, response_format: 'json' });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual(explanation(result).items.map(item => item.id), ['m-local', 'm-global']);
  const empty = await handleMemoryRead({ ids: ['missing'], explain: true });
  assert.deepEqual(explanation(empty).items, []);
});

test('graph expansion explains relation depth separately from the direct ID request', async () => {
  const db = getDb().db;
  db.exec("INSERT INTO relations(source_id,target_id,type) SELECT a.id,b.id,'related_to' FROM memories a, memories b WHERE a.legacy_id='m-local' AND b.legacy_id='m-global'");
  const result = await handleMemoryRead({ id: 'm-local', expand_graph: true, explain: true });
  const item = explanation(result).items.find(item => item.id === 'm-global')!;
  assert.equal(item.selection?.method, 'graph_expansion');
  assert.deepEqual(item.selection?.graph, { root_id: 'm-local', depth: 1 });
  const graph = (result.structuredContent as { related_graph: { id: string; score: number }[] }).related_graph;
  assert.equal(item.selection?.score, graph.find(node => node.id === 'm-global')!.score);
});

test('keyword explanation uses the executed BM25 score, respects scope and pagination', async () => {
  const expected = getDb().db.prepare(`SELECT m.legacy_id AS id, bm25(memory_fts) AS score FROM memory_fts JOIN memories m ON m.id=memory_fts.rowid
    WHERE memory_fts MATCH 'retry' AND (m.project='project-a' OR m.project IS NULL) ORDER BY bm25(memory_fts)`).all() as { id: string; score: number }[];
  const result = await handleMemoryRead({ query: 'retry', project: 'project-a', offset: 1, limit: 1, explain: true });
  const info = explanation(result);
  assert.deepEqual(info.scope, { mode: 'project_and_global', project: 'project-a' });
  assert.equal(info.items.length, 1);
  assert.equal(info.items[0].id, expected[1].id);
  assert.equal(info.items[0].selection?.method, 'fts5_bm25');
  assert.equal(info.items[0].selection?.score, expected[1].score);
  assert.equal(info.items[0].selection?.rank, 2);
  assert.ok(!result.content[0].text.includes('m-other'));
  assert.match(result.content[0].text, /Why these memories/);
});

test('browse and punctuation-only queries correctly explain confidence ordering, not keyword relevance', async () => {
  for (const query of [undefined, '!!!']) {
    const result = await handleMemoryRead({ query, all: true, explain: true, limit: 1 });
    const info = explanation(result);
    assert.equal(info.scope.mode, 'all_projects');
    assert.equal(info.items[0].id, 'm-other');
    assert.equal(info.items[0].selection?.method, 'confidence_browse');
    assert.equal(info.items[0].selection?.score_kind, 'stored_confidence');
  }
});

test('the actual LIKE fallback is explained when FTS cannot run', async () => {
  const db = getDb();
  const prepare = db.prepareCached.bind(db);
  mock.method(db, 'prepareCached', (sql: string) => {
    if (sql.includes('FROM memory_fts fts')) throw new Error('synthetic FTS availability failure');
    return prepare(sql);
  });
  const result = await handleMemoryRead({ query: 'retry', project: 'project-a', explain: true });
  assert.ok(explanation(result).items.length > 0);
  for (const item of explanation(result).items) assert.equal(item.selection?.method, 'substring_fallback');
});

test('evidence remains not_checked when verification is disabled, without reading the cited file', async () => {
  const file = path.join(dir, 'code.ts');
  fs.writeFileSync(file, 'const retry = true;');
  cite(file);
  const originalRead = fs.readFileSync;
  let reads = 0;
  mock.method(fs, 'readFileSync', (...args: unknown[]) => {
    if (args[0] === file) reads++;
    return (originalRead as (...args: unknown[]) => unknown)(...args);
  });
  const info = explanation(await handleMemoryRead({ id: 'm-local', explain: true }));
  assert.equal(reads, 0);
  assert.equal(info.items[0].freshness?.status, 'not_checked');
  assert.equal(info.items[0].freshness?.checked_at, null);
  assert.equal(info.items[0].provenance?.citations[0].file, file);
});

test('enabled verification distinguishes present snippets from changed/unreadable evidence without claiming truth', async () => {
  verifyOn();
  const file = path.join(dir, 'code.ts');
  fs.writeFileSync(file, 'const retry = true;');
  cite(file);
  const fresh = explanation(await handleMemoryRead({ id: 'm-local', explain: true }));
  assert.equal(fresh.items[0].freshness?.status, 'checked_snippets_present');
  assert.ok(fresh.items[0].freshness?.checked_at);
  assert.match(fresh.notice, /not proof of correctness/);
  fs.writeFileSync(file, 'const retry = false;');
  const changed = explanation(await handleMemoryRead({ query: 'retry timeout', project: 'project-a', explain: true }));
  assert.equal(changed.items.find(item => item.id === 'm-local')?.freshness?.status, 'stale_or_unavailable');
  fs.unlinkSync(file);
  const missing = explanation(await handleMemoryRead({ ids: ['m-local'], explain: true }));
  assert.match(missing.items[0].freshness!.checks[0].reason, /could not be read/);
});

test('evidence checks are bounded and truncation is disclosed', async () => {
  verifyOn();
  const file = path.join(dir, 'code.ts');
  fs.writeFileSync(file, 'const retry = true;');
  for (let i = 0; i < 6; i++) cite(file);
  const originalRead = fs.readFileSync;
  let reads = 0;
  mock.method(fs, 'readFileSync', (...args: unknown[]) => {
    if (args[0] === file) reads++;
    return (originalRead as (...args: unknown[]) => unknown)(...args);
  });
  const result = await handleMemoryRead({ id: 'm-local', explain: true });
  assert.equal(reads, 5, 'do not also repeat the legacy full evidence check');
  assert.equal(explanation(result).items[0].freshness?.citations_truncated, true);
  assert.match(result.content[0].text, /first five citations only/);
});

test('semantic explanations preserve the returned scores and project scope', async () => {
  const result = await handleSemanticSearch({ query: 'retry timeout', project: 'project-a', explain: true, response_format: 'json' });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const payload = result.structuredContent as { results: { id: string; score: number }[] };
  assert.ok(payload.results.length > 0);
  for (const item of explanation(result).items) {
    assert.notEqual(item.id, 'm-other');
    assert.equal(item.selection?.method, 'tfidf_cosine');
    assert.equal(item.selection?.score, payload.results.find(r => r.id === item.id)!.score);
  }
});

test('hybrid scores are finite and explanations use actual fusion components without changing selection', async () => {
  const plain = await handleSemanticSearch({ query: 'retry timeout', project: 'project-a', hybrid: true });
  const result = await handleSemanticSearch({ query: 'retry timeout', project: 'project-a', hybrid: true, explain: true });
  const results = (result.structuredContent as { results: { id: string; score: number }[] }).results;
  assert.deepEqual(results, (plain.structuredContent as { results: unknown[] }).results);
  assert.ok(results.length > 0);
  for (const item of explanation(result).items) {
    assert.equal(item.selection?.method, 'hybrid_rrf_mmr');
    assert.ok(Number.isFinite(item.selection?.score));
    const components = item.selection!.components!;
    assert.equal(components.fusion_score + components.priority_contribution, item.selection?.score);
    assert.ok(components.lexical_rank !== null || components.semantic_rank !== null);
  }
  assert.match(result.content[0].text, /MMR diversity/);
});

test('malformed historical dates do not produce non-finite hybrid scores', async () => {
  getDb().db.exec("UPDATE memories SET created_at='unknown historical date' WHERE legacy_id='m-local'");
  const result = await handleSemanticSearch({ query: 'retry timeout', project: 'project-a', hybrid: true, explain: true, response_format: 'json' });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const item = explanation(result).items.find(item => item.id === 'm-local')!;
  assert.ok(Number.isFinite(item.selection?.score));
  assert.equal(item.selection?.components?.priority_contribution, 0);
});

test('empty searches return empty explanations and do not expose unrelated metadata', async () => {
  const read = await handleMemoryRead({ query: 'unfindabletoken', project: 'project-a', explain: true });
  assert.deepEqual(explanation(read).items, []);
  const semantic = await handleSemanticSearch({ query: 'unfindabletoken', project: 'nonexistent', explain: true });
  assert.deepEqual(explanation(semantic).items, []);
  assert.doesNotMatch(semantic.content[0].text, /m-other|private project secret/);
});
