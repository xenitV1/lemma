import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { getDb, LemmaDB } from "./database.js";
import { MIGRATIONS } from "./schema.js";
import { VERSION } from "../version.js";
import { assertEmptyLegacyVectors, isLegacyVectorTable, LEGACY_VECTOR_NOTE, type SchemaRow } from "./legacy-vectors.js";

// Snapshots and their base64 representation coexist in memory; bound both.
export const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = Math.ceil(MAX_DATABASE_BYTES / 3) * 4 + 4096;
export const RESTORE_PREVIEW_TTL_MS = 10 * 60 * 1000;
const FORMAT = "lemma-backup";
const FORMAT_VERSION = 1;
const SCHEMA_VERSION = Math.max(...MIGRATIONS.map(([version]) => version));
// Extend this list only after testing the historical schema and its upgrade path.
const SUPPORTED_SOURCE_SCHEMAS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const EXCLUDED = ["config.json", "diagnostic logs", "raw session/traffic logs", "installed skills and models", "MCP client configuration"];

interface BackupEnvelope {
  format: typeof FORMAT;
  format_version: number;
  lemma_version: string;
  schema_version: number;
  created_at: string;
  database_sha256: string;
  database: string;
}

export interface BackupSummary {
  memories: number;
  guides: number;
  sessions: number;
  relations: number;
  archived_memories: number;
  active_sessions: number;
}

interface LoadedBackup {
  envelope: BackupEnvelope;
  db: Database.Database;
  fingerprint: string;
  summary: BackupSummary;
}

interface RestorePreview {
  path: string;
  sourceHash: string;
  targetHash: string;
  target: LemmaDB;
  expiresAt: number;
}

const pendingRestores = new Map<string, RestorePreview>();
const expectedSchemas = new Map<number, string>();

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function schemaSignature(db: Database.Database): string {
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as SchemaRow[];
  const legacy = assertEmptyLegacyVectors(db, rows);
  const applicationRows = rows.filter(row => !(legacy && row.type === "table" && isLegacyVectorTable(row.name)));
  return sha256(JSON.stringify(applicationRows.map(row => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").trim() }))));
}

function assertSupportedSchema(db: Database.Database, version = SCHEMA_VERSION): void {
  if (!expectedSchemas.has(version)) {
    const reference = new LemmaDB(":memory:");
    try {
      for (const [step, ddl] of MIGRATIONS) {
        if (step <= version) reference.db.exec(ddl);
      }
      expectedSchemas.set(version, schemaSignature(reference.db));
    } finally {
      reference.close();
    }
  }
  if (schemaSignature(db) !== expectedSchemas.get(version)) {
    throw new Error(`Incompatible database schema. Expected the known Lemma schema ${version}; no data was replaced.`);
  }
  // memory-store uses -1 as the last decay timestamp, not a schema migration.
  const history = db.prepare("SELECT version FROM schema_version WHERE version <> -1 ORDER BY version").all() as { version: number }[];
  const expected = MIGRATIONS.filter(([step]) => step <= version).map(([step]) => step);
  if (JSON.stringify(history.map(row => row.version)) !== JSON.stringify(expected)) {
    throw new Error("Unsupported Lemma database version history; no data was replaced.");
  }
}

function assertIntegrity(db: Database.Database): void {
  if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Backup database failed the SQLite integrity check.");
  if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("Backup contains broken database relationships.");
  // Fixed application SQL, never statements supplied by a backup.
  for (const table of ["memory_fts", "guides_fts"]) {
    db.prepare(`INSERT INTO ${table} (${table}, rank) VALUES ('integrity-check', 1)`).run();
  }
}

function summarize(db: Database.Database): BackupSummary {
  const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`).get() as { n: number }).n;
  return {
    memories: count("memories"), guides: count("guides"), sessions: count("sessions"),
    relations: count("relations"), archived_memories: count("fragments_archive"),
    active_sessions: (db.prepare("SELECT count(*) AS n FROM sessions WHERE status = 'active'").get() as { n: number }).n,
  };
}

/** Caller holds a transaction so other WAL writers cannot change this snapshot. */
function snapshot(db: Database.Database): Buffer {
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  if (pageCount * pageSize > MAX_DATABASE_BYTES) throw new Error("Database exceeds the 128 MiB backup limit for this release.");
  const bytes = db.serialize();
  if (bytes.length > MAX_DATABASE_BYTES) throw new Error("Database exceeds the 128 MiB backup limit for this release.");
  // sqlite3_deserialize cannot open WAL images. SQLite documents this conversion
  // of the PRIVATE serialized image; the live database remains in WAL mode.
  // https://sqlite.org/c3ref/deserialize.html
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

function absolutePath(value: string): string {
  const expanded = value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error("Please provide an absolute backup path (or a path starting with ~/).");
  return path.resolve(expanded);
}

function backupDirectory(lemma: LemmaDB): string {
  if (lemma.db.memory) throw new Error("Choose a backup directory for an in-memory database.");
  return path.join(path.dirname(path.resolve(lemma.db.name)), "backups");
}

function buildEnvelope(bytes: Buffer): BackupEnvelope {
  return {
    format: FORMAT, format_version: FORMAT_VERSION, lemma_version: VERSION,
    schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(),
    database_sha256: sha256(bytes), database: bytes.toString("base64"),
  };
}

function openSnapshot(bytes: Buffer, version = SCHEMA_VERSION): Database.Database {
  const db = new Database(bytes);
  try {
    // Validate BEFORE any migration: only application-owned DDL is accepted.
    assertSupportedSchema(db, version);
    assertIntegrity(db);
    if (version !== SCHEMA_VERSION) {
      db.transaction(() => {
        for (const [step, ddl] of MIGRATIONS) {
          if (step <= version) continue;
          db.exec(ddl);
          db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(step);
        }
        assertSupportedSchema(db);
        assertIntegrity(db);
        snapshot(db); // Enforce the size bound after expansion as well.
      })();
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function loadBackup(file: string): LoadedBackup {
  const fd = fs.openSync(file, "r");
  let bytes: Buffer;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Not a regular backup file, or backup exceeds the supported size limit.");
    // Bounded even if another process grows the file after fstat.
    bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new Error("Backup file changed or is truncated. Preview a complete backup file.");
      offset += read;
    }
    if (fs.fstatSync(fd).size !== info.size) throw new Error("Backup file changed while being read.");
  } finally {
    fs.closeSync(fd);
  }
  const data: unknown = JSON.parse(bytes.toString("utf8"));
  if (!data || typeof data !== "object") throw new Error("Not a Lemma backup file.");
  const envelope = data as BackupEnvelope;
  if (envelope.format !== FORMAT || envelope.format_version !== FORMAT_VERSION) throw new Error("Unsupported Lemma backup format.");
  if (!Number.isSafeInteger(envelope.schema_version) || !SUPPORTED_SOURCE_SCHEMAS.has(envelope.schema_version) || envelope.schema_version > SCHEMA_VERSION) {
    throw new Error(`Unsupported Lemma database schema ${envelope.schema_version}. This release accepts known schemas 1–8 up to ${SCHEMA_VERSION}. Use a compatible Lemma release; no data was replaced.`);
  }
  if (typeof envelope.lemma_version !== "string" || envelope.lemma_version.length > 64 ||
      typeof envelope.created_at !== "string" || !Number.isFinite(Date.parse(envelope.created_at)) ||
      typeof envelope.database_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(envelope.database_sha256) ||
      typeof envelope.database !== "string") throw new Error("Invalid backup metadata.");
  const image = Buffer.from(envelope.database, "base64");
  if (image.length < 100 || image.length > MAX_DATABASE_BYTES || image.toString("base64") !== envelope.database ||
      image.subarray(0, 16).toString() !== "SQLite format 3\0" || image[18] !== 1 || image[19] !== 1 ||
      sha256(image) !== envelope.database_sha256) throw new Error("Backup checksum or database payload is invalid.");
  const db = openSnapshot(image, envelope.schema_version);
  try {
    return { envelope, db, fingerprint: sha256(bytes), summary: summarize(db) };
  } catch (error) {
    db.close();
    throw error;
  }
}

function saveBackup(bytes: Buffer, directory: string, prefix: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.lemma-backup`);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(buildEnvelope(bytes)));
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    throw error;
  }
  fs.closeSync(fd);
  const verified = loadBackup(file);
  verified.db.close();
  return file;
}

export function createBackup(directory?: string) {
  const lemma = getDb();
  const destination = directory === undefined ? backupDirectory(lemma) : absolutePath(directory);
  const bytes = lemma.db.transaction(() => {
    assertSupportedSchema(lemma.db);
    return snapshot(lemma.db);
  })();
  const source = openSnapshot(bytes);
  try {
    const file = saveBackup(bytes, destination, "lemma");
    return { path: file, verified: true, summary: summarize(source), excluded: EXCLUDED,
      message: "Backup verified. Keep a copy outside this computer or the disk you plan to format. The file contains your private memory and is not encrypted. " + LEGACY_VECTOR_NOTE };
  } finally {
    source.close();
  }
}

export function previewRestore(file: string) {
  const resolved = absolutePath(file);
  const source = loadBackup(resolved);
  try {
    const lemma = getDb();
    const target = lemma.db.transaction(() => {
      assertSupportedSchema(lemma.db);
      return { hash: sha256(snapshot(lemma.db)), summary: summarize(lemma.db) };
    })();
    const now = Date.now();
    for (const [token, preview] of pendingRestores) if (preview.expiresAt <= now) pendingRestores.delete(token);
    if (pendingRestores.size >= 16) pendingRestores.delete(pendingRestores.keys().next().value!);
    const readiness = lemma.getRestoreReadiness();
    const token = readiness.status === "ready" ? randomUUID() : null;
    const expiresAt = now + RESTORE_PREVIEW_TTL_MS;
    if (token) pendingRestores.set(token, { path: resolved, sourceHash: source.fingerprint, targetHash: target.hash, target: lemma, expiresAt });
    else pendingRestores.clear(); // A blocked preview must not leave an older approval usable.
    return {
      path: resolved, valid: true, created_at: source.envelope.created_at, lemma_version: source.envelope.lemma_version,
      schema_upgrade: {
        required: source.envelope.schema_version !== SCHEMA_VERSION,
        from: source.envelope.schema_version, to: SCHEMA_VERSION,
        applied_versions: MIGRATIONS.filter(([step]) => step > source.envelope.schema_version).map(([step]) => step),
        notes: source.envelope.schema_version < 3
          ? ["Project keys are normalized: paths become project names, names become lowercase, and 'global' becomes global scope. The original backup file is unchanged."]
          : ["The original backup file is unchanged. Known migrations are validated on an in-memory copy."],
      },
      backup: source.summary, current: target.summary, confirmation_token: token,
      readiness, expires_at: token ? new Date(expiresAt).toISOString() : null, excluded: EXCLUDED,
      compatibility_note: `Backup schema ${source.envelope.schema_version}; target schema ${SCHEMA_VERSION}. ` +
        (source.envelope.schema_version !== SCHEMA_VERSION ? "Show schema_upgrade and its notes before asking for confirmation. The validated in-memory copy has been upgraded; the original backup file is unchanged. " : "No schema upgrade needed. ") + LEGACY_VECTOR_NOTE,
      message: (token ? "Show this preview to the user and ask for explicit confirmation before backup_restore. " : "Show the connection blocker to the user. Do not ask for restore confirmation yet; resolve the blocker and call backup_preview again. ") + "Restore REPLACES all projects and global memory; it does not merge. Active sessions in the backup become abandoned history. Keep this MCP connection open. Older Lemma versions and external SQLite tools cannot be detected by this check and must be closed separately. Readiness is a point-in-time connection check, not a guarantee that restore will succeed. A verified safety backup is required before any replacement. Computer settings and diagnostic logs stay unchanged.",
    };
  } finally {
    source.db.close();
  }
}

function replaceRows(target: Database.Database, source: Database.Database): void {
  // Enumerate the validated LOCAL schema. Never execute SQL supplied by a backup.
  const tables = (target.pragma("table_list") as { schema: string; name: string; type: string }[])
    .filter(row => row.schema === "main" && row.type === "table" && !row.name.startsWith("sqlite_") && !isLegacyVectorTable(row.name))
    .map(row => row.name).sort();
  const triggers = target.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string; sql: string }[];
  target.pragma("defer_foreign_keys = ON");
  for (const trigger of triggers) target.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
  for (const table of tables) target.exec(`DELETE FROM ${quoteIdentifier(table)}`);
  for (const table of tables) {
    const columns = (target.pragma(`table_info(${quoteIdentifier(table)})`) as { name: string }[]).map(row => quoteIdentifier(row.name));
    const insert = target.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    for (const row of source.prepare(`SELECT ${columns.join(",")} FROM ${quoteIdentifier(table)}`).raw().safeIntegers().iterate()) {
      insert.run(...row as unknown[]);
    }
  }
  target.exec("DELETE FROM sqlite_sequence");
  const insertSequence = target.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)");
  for (const row of source.prepare("SELECT name, seq FROM sqlite_sequence").raw().safeIntegers().iterate()) insertSequence.run(...row as unknown[]);
  for (const trigger of triggers) target.exec(trigger.sql);
  for (const table of ["memory_fts", "guides_fts"]) target.exec(`INSERT INTO ${table} (${table}) VALUES ('rebuild')`);
  // Sessions from another machine must not be resumed by the auto-session hook.
  target.prepare("UPDATE sessions SET status = 'abandoned', outcome = COALESCE(outcome, 'abandoned'), ended_at = COALESCE(ended_at, ?) WHERE status = 'active'").run(new Date().toISOString());
  assertIntegrity(target);
}

export function restoreBackup(token: string | null, confirm: boolean) {
  if (confirm !== true) throw new Error("Explicit user confirmation is required. Show backup_preview first, then call backup_restore with confirm=true only after the user approves.");
  if (!token) throw new Error("Restore preview is not ready. Resolve the connection blocker, call backup_preview and ask for confirmation again.");
  const preview = pendingRestores.get(token);
  if (!preview || preview.expiresAt <= Date.now()) {
    pendingRestores.delete(token);
    throw new Error("Restore preview is missing or expired. Call backup_preview and ask for confirmation again.");
  }
  pendingRestores.delete(token); // One attempt per confirmed preview, including failures.
  const lemma = getDb();
  if (preview.target !== lemma) throw new Error("The target database connection changed. Preview the backup again.");
  const source = loadBackup(preview.path);
  let safetyBackup: string | undefined;
  try {
    if (source.fingerprint !== preview.sourceHash) throw new Error("The backup changed after preview. Preview it again before confirming.");
    const previousSync = lemma.db.pragma("synchronous", { simple: true }) as number;
    try {
      lemma.db.pragma("synchronous = FULL");
      lemma.withRestoreLock(() => {
        assertSupportedSchema(lemma.db);
        const current = snapshot(lemma.db);
        if (sha256(current) !== preview.targetHash) throw new Error("Your memory changed after preview. Preview the backup again to review the current records.");
        safetyBackup = saveBackup(current, backupDirectory(lemma), "before-restore");
        replaceRows(lemma.db, source.db);
      });
    } finally {
      lemma.db.pragma(`synchronous = ${previousSync}`);
      lemma.clearStatementCache();
    }
    pendingRestores.clear();
    return { restored: true, verified: true, path: preview.path, safety_backup_path: safetyBackup!,
      summary: summarize(lemma.db), closed_sessions: source.summary.active_sessions,
      message: "Memory restored and verified. Continue using this MCP connection; no terminal command or restart is needed. This replaces saved memory, not the text already in your current conversation. Start a new conversation if you need a fresh context." };
  } catch (error) {
    throw new Error(`${(error as Error).message}${safetyBackup ? ` Safety backup: ${safetyBackup}.` : ""}`);
  } finally {
    source.db.close();
  }
}
