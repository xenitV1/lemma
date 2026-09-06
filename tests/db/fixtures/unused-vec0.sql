-- Synthetic upgrade residue only. Never execute against a user's database.
-- vec0 is no longer installed; register its inert virtual-table declaration only
-- in this disposable fixture. Product code never writes sqlite_schema.
-- SQLite test pragma: https://www.sqlite.org/pragma.html#pragma_writable_schema
CREATE TABLE "memory_vectors_chunks"(chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,size INTEGER NOT NULL,validity BLOB NOT NULL,rowids BLOB NOT NULL);
CREATE TABLE "memory_vectors_info" (key text primary key, value any);
CREATE TABLE "memory_vectors_rowids"(rowid INTEGER PRIMARY KEY AUTOINCREMENT,id,chunk_id INTEGER,chunk_offset INTEGER);
CREATE TABLE "memory_vectors_vector_chunks00"(rowid PRIMARY KEY,vectors BLOB NOT NULL);
INSERT INTO memory_vectors_info VALUES ('CREATE_VERSION', 'v0.1.9'), ('CREATE_VERSION_MAJOR', 0), ('CREATE_VERSION_MINOR', 1), ('CREATE_VERSION_PATCH', 9);
PRAGMA writable_schema = ON;
INSERT INTO sqlite_master(type, name, tbl_name, rootpage, sql)
VALUES ('table', 'memory_vectors', 'memory_vectors', 0, 'CREATE VIRTUAL TABLE memory_vectors USING vec0(
  embedding float[384]
)');
PRAGMA writable_schema = RESET;
