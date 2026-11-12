import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Access denied is not evidence that a process has stopped.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Cooperative leases cover MCP servers and visualizers using this version. */
export interface ConnectionInspection {
  current_connection: { pid: number; connection_id: string | null };
  blocking_connections: { pid: number; connection_id: string; same_process: boolean }[];
  unverifiable_leases: number;
  inspection_error: string | null;
}

export function connectionBlocker(info: ConnectionInspection): string | null {
  if (info.inspection_error) return `Cannot inspect Lemma connections: ${info.inspection_error}`;
  if (info.unverifiable_leases) return `Cannot verify ${info.unverifiable_leases} Lemma client lease(s).`;
  if (info.blocking_connections.length) {
    const pids = [...new Set(info.blocking_connections.map(connection => connection.pid))].join(", ");
    return `Another Lemma client is using this memory. Blocking process IDs: ${pids}.`;
  }
  return null;
}

/** PID encoded in a lease file name (`<prefix><pid>-<uuid>`), or NaN when the name is not a valid lease. */
function leasePid(suffix: string): number {
  const match = /^([1-9]\d*)-[0-9a-f-]{36}$/.exec(suffix);
  return match ? Number(match[1]) : NaN;
}

// Leases still registered by this process. The server leaves through process.exit(),
// so connections are released from an exit hook rather than relying on every caller
// to close them first; otherwise each run leaves a lease file behind.
const openClients = new Set<DatabaseClient>();
let exitHookInstalled = false;

function releaseOpenClients(): void {
  for (const client of [...openClients]) {
    try { client.close(); } catch { /* exiting: nothing left to report to */ }
  }
}

export class DatabaseClient {
  private readonly directory: string;
  private readonly lease: string;
  private readonly prefix: string;

  constructor(dbPath: string, db: Database.Database) {
    const canonical = fs.realpathSync(dbPath);
    this.directory = path.dirname(canonical);
    this.prefix = `${path.basename(canonical)}.client-`;
    this.lease = path.join(this.directory, `${this.prefix}${process.pid}-${randomUUID()}`);
    // Registration shares SQLite's writer lock with restore. A new client cannot
    // load data between the peer check and the destructive commit. SQLite also
    // releases this lock after a crash; there is no stale maintenance lock file.
    try {
      db.transaction(() => {
        // Ownership is in the filename: a crash cannot leave half-written JSON.
        fs.writeFileSync(this.lease, "", { flag: "wx", mode: 0o600 });
      }).immediate();
    } catch (error) {
      this.close();
      throw error;
    }
    openClients.add(this);
    if (!exitHookInstalled) {
      process.on("exit", releaseOpenClients);
      exitHookInstalled = true;
    }
    this.removeLeasesOfExitedProcesses();
  }

  /**
   * A killed process cannot remove its own lease. Remove leases only when the OS reports
   * their process as gone (ESRCH). Leases of live or unverifiable processes, including a
   * recycled PID, stay: dropping a live client's lease could let restore replace memory
   * that client is still using, while a kept stale lease only blocks restore.
   */
  private removeLeasesOfExitedProcesses(): void {
    let entries: string[];
    try { entries = fs.readdirSync(this.directory); } catch { return; }
    for (const name of entries) {
      if (!name.startsWith(this.prefix)) continue;
      const file = path.join(this.directory, name);
      if (file === this.lease) continue;
      const pid = leasePid(name.slice(this.prefix.length));
      if (!Number.isSafeInteger(pid) || processIsAlive(pid)) continue;
      try { fs.unlinkSync(file); } catch { /* another client removed it, or it is in use */ }
    }
  }

  inspectConnections(): ConnectionInspection {
    const result: ConnectionInspection = {
      current_connection: { pid: process.pid, connection_id: path.basename(this.lease) },
      blocking_connections: [], unverifiable_leases: 0, inspection_error: null,
    };
    let entries: string[];
    try { entries = fs.readdirSync(this.directory); }
    catch (error) { result.inspection_error = (error as Error).message; return result; }
    for (const name of entries.sort()) {
      if (!name.startsWith(this.prefix)) continue;
      const file = path.join(this.directory, name);
      if (file === this.lease) continue;
      const pid = leasePid(name.slice(this.prefix.length));
      if (!Number.isSafeInteger(pid)) { result.unverifiable_leases++; continue; }
      if (processIsAlive(pid)) {
        result.blocking_connections.push({ pid, connection_id: name, same_process: pid === process.pid });
      }
    }
    return result;
  }

  assertSoleClient(): void {
    const blocker = connectionBlocker(this.inspectConnections());
    if (blocker) throw new Error(`${blocker} Close other Lemma connections through their application, then preview again. Keep this MCP connection open; never terminate its process.`);
  }

  close(): void {
    openClients.delete(this);
    try { fs.unlinkSync(this.lease); } catch (error) { if (!isMissing(error)) throw error; }
  }
}
