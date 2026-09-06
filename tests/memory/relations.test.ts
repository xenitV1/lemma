import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/core.js";
import { closeDb } from "../../src/db/database.js";
import { handleMemoryAdd, handleMemoryRelate, setNotifyChange } from "../../src/server/handlers.js";

const TEST_DIR = path.join(os.tmpdir(), `lemma-test-relations-${Date.now()}`);

beforeEach(() => {
  core.setMemoryDir(TEST_DIR);
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setNotifyChange(() => {});
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("Memory relations", () => {
  it("creates a typed relation between two fragments", async () => {
    const addA = await handleMemoryAdd({ fragment: "Use App Router in Next.js 15" });
    const addB = await handleMemoryAdd({ fragment: "Pages Router is simpler for rapid prototyping" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    const idB = addB.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    assert.ok(idA && idB);

    const result = await handleMemoryRelate({ sourceId: idA, targetId: idB, type: "contradicts", note: "Different routing approaches" });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("contradicts"));
    assert.ok(result.content[0].text.includes(idA));
    assert.ok(result.content[0].text.includes(idB));
  });

  it("creates reverse relation on target", async () => {
    const addA = await handleMemoryAdd({ fragment: "Kubernetes pod autoscaling based on CPU utilization metrics" });
    const addB = await handleMemoryAdd({ fragment: "Docker container networking bridge overlay configurations" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    const idB = addB.content[0].text.match(/\[([^\]]+)\]/)?.[1];

    await handleMemoryRelate({ sourceId: idA, targetId: idB, type: "supersedes" });

    const memory = core.loadMemory();
    const target = memory.find(f => f.id === idB);
    assert.ok(target);
    assert.ok(target.relations?.length > 0);
    assert.ok(target.relations[0].id === idA);
  });

  it("rejects duplicate relation", async () => {
    const addA = await handleMemoryAdd({ fragment: "React is fast" });
    const addB = await handleMemoryAdd({ fragment: "React has good DX" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    const idB = addB.content[0].text.match(/\[([^\]]+)\]/)?.[1];

    await handleMemoryRelate({ sourceId: idA, targetId: idB, type: "supports" });
    const result = await handleMemoryRelate({ sourceId: idA, targetId: idB, type: "supports" });
    assert.ok(result.isError);
  });

  it("rejects self-relation", async () => {
    const addA = await handleMemoryAdd({ fragment: "Some fragment" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];

    const result = await handleMemoryRelate({ sourceId: idA, targetId: idA, type: "related_to" });
    assert.ok(result.isError);
  });

  it("rejects invalid type", async () => {
    const addA = await handleMemoryAdd({ fragment: "Fragment A" });
    const addB = await handleMemoryAdd({ fragment: "Fragment B" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    const idB = addB.content[0].text.match(/\[([^\]]+)\]/)?.[1];

    const result = await handleMemoryRelate({ sourceId: idA, targetId: idB, type: "invalid_type" });
    assert.ok(result.isError);
  });

  it("rejects non-existent fragment", async () => {
    const result = await handleMemoryRelate({ sourceId: "m_nonexistent1", targetId: "m_nonexistent2", type: "related_to" });
    assert.ok(result.isError);
  });

  it("requires all parameters", async () => {
    const result = await handleMemoryRelate({ sourceId: "m_abc" });
    assert.ok(result.isError);
  });

  it("relations appear in fragment detail format", async () => {
    const addA = await handleMemoryAdd({ fragment: "Use REST APIs for backend communication layer" });
    const addB = await handleMemoryAdd({ fragment: "GraphQL provides flexible querying capabilities" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    const idB = addB.content[0].text.match(/\[([^\]]+)\]/)?.[1];

    await handleMemoryRelate({ sourceId: idB, targetId: idA, type: "supersedes", note: "Migrated to new approach" });

    const memory = core.loadMemory();
    const source = memory.find(f => f.id === idB) ?? null;
    const detail = core.formatMemoryDetail(source);
    assert.ok(detail.includes("supersedes"));
    assert.ok(detail.includes("Migrated to new approach"));
  });

  it("audit detects orphan relations", async () => {
    const memory = core.loadMemory();
    const frag1 = core.createFragment("Fragment 1", "ai");
    frag1.relations = [{ id: "m_ghost000000", type: "related_to" as const, created: "2026-04-19" }];
    memory.push(frag1);
    core.saveMemory(memory, { force: true });

    const result = core.auditMemory(memory);
    assert.ok(result.issues_found > 0);
    assert.ok(result.issues.some(i => i.includes("non-existent")));
  });
});
