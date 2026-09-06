import { createBackup, previewRestore, restoreBackup } from "../db/backup.js";

export const BACKUP_TOOL_NAMES = new Set(["backup_create", "backup_preview", "backup_restore"]);

export function handleBackupTool(name: string, args: Record<string, unknown> = {}) {
  const allowed = name === "backup_create" ? ["directory"] : name === "backup_preview" ? ["path"] : ["confirmation_token", "confirm"];
  if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some(key => !allowed.includes(key))) {
    throw new Error("Unexpected backup tool arguments.");
  }
  const textArg = (key: string): string => {
    const value = args[key];
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`'${key}' must be a non-empty string.`);
    return value;
  };
  const result = name === "backup_create"
    ? createBackup(args.directory === undefined ? undefined : textArg("directory"))
    : name === "backup_preview"
      ? previewRestore(textArg("path"))
      : restoreBackup(textArg("confirmation_token"), args.confirm === true);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
}
