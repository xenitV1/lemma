import type Database from "better-sqlite3";

// Removed in 0.15.0 (90d125a). No released writer used this reserved index.
// Recognize only this exact, unused scaffold; do not relax the application schema.
const LEGACY_SCHEMA: Record<string, string> = {
  memory_vectors: "CREATE VIRTUAL TABLE memory_vectors USING vec0( embedding float[384] )",
  memory_vectors_chunks: 'CREATE TABLE "memory_vectors_chunks"(chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,size INTEGER NOT NULL,validity BLOB NOT NULL,rowids BLOB NOT NULL)',
  memory_vectors_info: 'CREATE TABLE "memory_vectors_info" (key text primary key, value any)',
  memory_vectors_rowids: 'CREATE TABLE "memory_vectors_rowids"(rowid INTEGER PRIMARY KEY AUTOINCREMENT,id,chunk_id INTEGER,chunk_offset INTEGER)',
  memory_vectors_vector_chunks00: 'CREATE TABLE "memory_vectors_vector_chunks00"(rowid PRIMARY KEY,vectors BLOB NOT NULL)',
};
const names = new Set(Object.keys(LEGACY_SCHEMA));
export const LEGACY_VECTOR_NOTE = "Known unused legacy vec0 scaffolding may be present in the snapshot. Restore preserves existing empty scaffolding but does not recreate it on a new installation; no memory or guide records are excluded.";

export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export function isLegacyVectorTable(name: string): boolean {
  return names.has(name);
}

/** Read-only validation. In particular, never DROP a live virtual table. */
export function assertEmptyLegacyVectors(db: Database.Database, rows: SchemaRow[]): boolean {
  if (!rows.some(row => row.type === "table" && row.name === "memory_vectors")) return false;
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  for (const [name, sql] of Object.entries(LEGACY_SCHEMA)) {
    const row = rows.find(item => item.type === "table" && item.name === name);
    if (!row || row.tbl_name !== name || !row.sql || normalize(row.sql) !== normalize(sql)) {
      throw new Error("Unsupported legacy vector schema. No data was replaced.");
    }
  }
  for (const name of ["memory_vectors_chunks", "memory_vectors_rowids", "memory_vectors_vector_chunks00"]) {
    if (db.prepare('SELECT 1 FROM "' + name + '" LIMIT 1').get()) {
      throw new Error("Legacy vector tables contain data. This release supports only unused empty scaffolding; no data was replaced.");
    }
  }
  const info = db.prepare("SELECT key, value FROM memory_vectors_info ORDER BY key").all() as { key: string; value: unknown }[];
  const version = info.find(row => row.key === "CREATE_VERSION")?.value;
  const match = typeof version === "string" ? /^v(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  if (!match || info.length !== 4 ||
      !["MAJOR", "MINOR", "PATCH"].every((part, i) =>
        Number.isSafeInteger(Number(match[i + 1])) &&
        info.some(row => row.key === "CREATE_VERSION_" + part && row.value === Number(match[i + 1])))) {
    throw new Error("Unsupported legacy vector metadata. No data was replaced.");
  }
  const sequences = db.prepare("SELECT name FROM sqlite_sequence").all() as { name: string }[];
  if (sequences.some(row => names.has(row.name))) {
    throw new Error("Legacy vector tables have prior write history. Only unused scaffolding is supported; no data was replaced.");
  }
  return true;
}
