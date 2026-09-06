// Isolated subprocess fixture; never uses the real user's Lemma directory.
import { LemmaDB, getDb, setDataDir } from "../../src/db/database.js";
import { previewRestore, restoreBackup } from "../../src/db/backup.js";
import path from "node:path";

const [mode, file, backup] = process.argv.slice(2);
if (mode === 'hold') {
  const db = new LemmaDB(file);
  process.send?.('ready');
  process.on('message', () => { db.close(); process.exit(0); });
} else if (mode === 'crash') {
  setDataDir(path.dirname(file));
  const db = getDb().db;
  const preview = previewRestore(backup);
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    const result = exec(sql);
    if (sql === 'DELETE FROM "memories"') process.exit(73);
    return result;
  };
  restoreBackup(preview.confirmation_token, true);
  process.exit(1); // The deliberate crash point must have been reached.
} else {
  throw new Error('Unknown fixture mode');
}
