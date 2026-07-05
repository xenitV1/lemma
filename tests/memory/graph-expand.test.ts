import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/core.js";
import * as store from "../../src/db/memory-store.js";
import { initDatabase, getDb, closeDb } from "../../src/db/index.js";
import { handleMemoryRead, setNotifyChange } from "../../src/server/handlers.js";

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-test-graph-"));
  closeDb();
  core.setMemoryDir(TEST_DIR);
  initDatabase();
  setNotifyChange(() => {});
});

afterEach(() => {
  closeDb();
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// Insert a fragment directly (no handler auto-linking) and return {id, legacy}.
function seed(title: string, confidence = 0.8): { id: number; legacy: string } {
  const { id, legacy_id } = store.addMemory(getDb(), title, "ai", title, null, undefined, "fact");
  getDb().prepareCached("UPDATE memories SET confidence = ? WHERE id = ?").run(confidence, id);
  return { id, legacy: legacy_id };
}
function relate(src: number, tgt: number): void {
  store.addRelation(getDb(), src, tgt, "related_to");
}

describe("A3 — bounded-depth graph expansion (expandGraph)", () => {
  it("traverses to depth 2 with a 0.6^depth penalty, excluding root + unconnected", () => {
    const a = seed("root database indexing", 0.9);
    const b = seed("btree index internals", 0.8);
    const c = seed("page splits in btrees", 0.8);
    const far = seed("unrelated css flexbox", 0.8);
    relate(a.id, b.id); // a -> b (depth 1)
    relate(b.id, c.id); // b -> c (depth 2)
    // far is intentionally unconnected

    const graph = core.expandGraph(a.legacy, 2, 5);
    const ids = graph.map(g => g.fragment.id);
    assert.ok(ids.includes(b.legacy), "depth-1 neighbor reached");
    assert.ok(ids.includes(c.legacy), "depth-2 neighbor reached");
    assert.ok(!ids.includes(a.legacy), "root excluded");
    assert.ok(!ids.includes(far.legacy), "unconnected fragment not reached");

    const bNode = graph.find(g => g.fragment.id === b.legacy)!;
    const cNode = graph.find(g => g.fragment.id === c.legacy)!;
    assert.equal(bNode.depth, 1);
    assert.equal(cNode.depth, 2);
    assert.ok(cNode.score < bNode.score, "deeper node discounted by 0.6^depth");
  });

  it("does not traverse past maxDepth", () => {
    const a = seed("d0"); const b = seed("d1"); const c = seed("d2"); const d = seed("d3");
    relate(a.id, b.id); relate(b.id, c.id); relate(c.id, d.id);
    const ids = core.expandGraph(a.legacy, 2, 5).map(g => g.fragment.id);
    assert.ok(ids.includes(b.legacy) && ids.includes(c.legacy));
    assert.ok(!ids.includes(d.legacy), "depth-3 node not reached at maxDepth=2");
  });

  it("respects the fan-out cap, keeping the highest-confidence edges", () => {
    const root = seed("hub", 0.9);
    // 6 neighbors with distinct confidences; fanout=3 keeps the top 3.
    const neighbors = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7].map((c, i) => seed(`n${i}`, c));
    for (const n of neighbors) relate(root.id, n.id);

    const graph = core.expandGraph(root.legacy, 1, 3);
    assert.equal(graph.length, 3, "fan-out capped at 3");
    const keptConfidences = graph.map(g => g.fragment.confidence).sort((x, y) => y - x);
    assert.deepEqual(keptConfidences, [0.95, 0.9, 0.85], "kept the strongest links");
  });

  it("returns empty for an unknown root", () => {
    assert.deepEqual(core.expandGraph("does-not-exist"), []);
  });

  it("memory_read id=... expand_graph:true surfaces the related section", async () => {
    const a = seed("primary deployment node", 0.9);
    const b = seed("secondary ci node", 0.85);
    relate(a.id, b.id);

    const withGraph = await handleMemoryRead({ id: a.legacy, expand_graph: true });
    assert.ok(withGraph.content[0].text.includes("Related knowledge (graph"));
    assert.ok(withGraph.content[0].text.includes(b.legacy));
    assert.ok(Array.isArray((withGraph.structuredContent as any).related_graph));
    assert.equal((withGraph.structuredContent as any).related_graph[0].id, b.legacy);

    const noGraph = await handleMemoryRead({ id: a.legacy });
    assert.ok(!noGraph.content[0].text.includes("Related knowledge (graph"));
    assert.equal((noGraph.structuredContent as any).related_graph, undefined);
  });
});
