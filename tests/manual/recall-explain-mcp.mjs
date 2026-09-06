#!/usr/bin/env node
// Real stdio acceptance using only a disposable home and synthetic records.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LemmaDB } from '../../dist/db/database.js';
import { runMigrations } from '../../dist/db/migration.js';
import { addEvidence } from '../../dist/memory/evidence.js';
import { disableLogger } from '../../dist/logger.js';
disableLogger();

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lemma-explain-stdio-'));
const cwd = path.join(root, 'project-a');
fs.mkdirSync(cwd);
const dataDir = path.join(root, '.lemma');
const codeFile = path.join(root, 'retry.ts');
fs.writeFileSync(codeFile, 'const retry = true;');
const fixture = new LemmaDB(path.join(dataDir, 'lemma.db'));
try {
  runMigrations(fixture);
  fixture.db.exec(`INSERT INTO memories(legacy_id,title,fragment,type,project,confidence) VALUES
    ('m-local','Retry timeout','Retry timeout with exponential delay','fact','project-a',0.4),
    ('m-global','Retry policy','Retry network operations','pattern',NULL,0.8),
    ('m-other','Retry private','Retry timeout in another project','fact','project-b',0.9)`);
  const memory = fixture.db.prepare("SELECT id FROM memories WHERE legacy_id='m-local'").get();
  addEvidence(fixture, memory.id, { file: codeFile, symbol: 'retry', snippet: 'const retry = true;' });
} finally { fixture.close(); }
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ verification: { stale_check: true } }));

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'dist', 'index.js')], cwd,
  env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, '.config') }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
const client = new Client({ name: 'recall-explain-acceptance', version: '1.0.0' });
let checks = 0;
function check(label, condition) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, name + ': ' + JSON.stringify(result));
  assert.ok(result.structuredContent, 'structured MCP output');
  if (args.response_format === 'json') assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result;
}
try {
  await client.connect(transport);
  const registry = await client.listTools();
  for (const name of ['memory_read', 'semantic_search']) {
    check(name + ' advertises the optional flag', registry.tools.find(tool => tool.name === name)?.inputSchema.properties.explain.type === 'boolean');
  }
  const plain = await call('memory_read', { query: 'retry', project: 'project-a' });
  check('default response has no explanation', !plain.structuredContent.recall_explanation && !plain.content[0].text.includes('Why these memories'));
  const read = await call('memory_read', { query: 'retry', project: 'project-a', explain: true, response_format: 'json' });
  const info = read.structuredContent.recall_explanation;
  check('explanation covers the actual scoped results', info.items.length === 2 && info.items.every(item => item.id !== 'm-other'));
  check('keyword ranking reports finite BM25 scores', info.items.every(item => item.selection.method === 'fts5_bm25' && Number.isFinite(item.selection.score)));
  check('current-call boundary is explicit', info.applies_to === 'this_call' && info.notice.includes('not a past recall'));
  check('source citation and checked status are available', info.items.find(item => item.id === 'm-local').provenance.citations[0].file === codeFile && info.items.find(item => item.id === 'm-local').freshness.status === 'checked_snippets_present');
  check('existing correction tools are suggested', info.correction_tools.some(action => action.tool === 'memory_update') && info.correction_tools.some(action => action.tool === 'memory_forget'));
  const detail = await call('memory_read', { id: 'm-local', explain: true, response_format: 'json' });
  check('direct ID has no invented relevance rank', detail.structuredContent.recall_explanation.items[0].selection.rank === null);
  const batch = await call('memory_read', { ids: ['m-local', 'missing'], explain: true, response_format: 'json' });
  check('batch explanation excludes missing IDs', batch.structuredContent.recall_explanation.items.length === 1);
  const semantic = await call('semantic_search', { query: 'retry timeout', project: 'project-a', explain: true, response_format: 'json' });
  check('TF-IDF explanation uses returned scores', semantic.structuredContent.recall_explanation.items.every(item => item.selection.score === semantic.structuredContent.results.find(result => result.id === item.id).score));
  const hybrid = await call('semantic_search', { query: 'retry timeout', project: 'project-a', hybrid: true, explain: true, response_format: 'json' });
  check('hybrid scores and components survive actual MCP serialization', hybrid.structuredContent.recall_explanation.items.length > 0 && hybrid.structuredContent.recall_explanation.items.every(item => Number.isFinite(item.selection.score) && Number.isFinite(item.selection.components.fusion_score)));
  fs.writeFileSync(codeFile, 'const retry = false;');
  const stale = await call('memory_read', { id: 'm-local', explain: true });
  check('changed evidence is disclosed in JSON and readable text', stale.structuredContent.recall_explanation.items[0].freshness.status === 'stale_or_unavailable' && stale.content[0].text.includes('some evidence changed'));
  await call('memory_update', { id: 'm-local', title: 'Reviewed retry policy', fragment: '## Retry\n### Reviewed behavior\nUse the new bounded retry policy.' });
  const corrected = await call('memory_read', { id: 'm-local', explain: true });
  check('existing update action corrects the selected record', corrected.structuredContent.fragments[0].title === 'Reviewed retry policy');
  await call('memory_forget', { id: 'm-local', invalidate: true });
  const after = await call('memory_read', { query: 'retry', project: 'project-a', explain: true });
  check('invalidation removes the record from recall and its explanations', after.structuredContent.fragments.every(f => f.id !== 'm-local') && after.structuredContent.recall_explanation.items.every(item => item.id !== 'm-local'));
  const retained = await call('memory_read', { id: 'm-local', explain: true });
  check('invalidated content remains available by ID with its status', !!retained.structuredContent.recall_explanation.items[0].provenance.invalidated_at);
  console.log('ALL ' + checks + ' RECALL EXPLANATION STDIO CHECKS PASSED');
} catch (error) {
  console.error(error);
  console.error(stderr);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('lemma-explain-stdio-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
