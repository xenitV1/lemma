// Zero-import leaf module: shared FTS5 query sanitizer.
//
// Every token is double-quoted so FTS5 boolean operators (AND/OR/NOT/NEAR)
// and reserved characters present in user content are treated as literal
// phrase terms, never parsed as query syntax. Punctuation and symbols
// (including the double-quote char) are stripped first via \p{P}\p{S}, so a
// quoted token can never contain an unescaped quote.

export function sanitizeFtsQuery(input: string): string {
  const tokens = input
    .replace(/[\p{P}\p{S}]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
