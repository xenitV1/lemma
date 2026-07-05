export interface SecretMatch {
  pattern: string;
  match: string;
  type: string;
  index: number;
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /sk-proj-[a-zA-Z0-9]{20,}/g, type: "OpenAI project key" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, type: "OpenAI API key" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: "GitHub token" },
  { pattern: /gho_[a-zA-Z0-9]{36}/g, type: "GitHub OAuth token" },
  { pattern: /ghs_[a-zA-Z0-9]{36}/g, type: "GitHub app token" },
  { pattern: /ghu_[a-zA-Z0-9]{36}/g, type: "GitHub user-to-server token" },
  { pattern: /xox[bpas]-[a-zA-Z0-9-]+/g, type: "Slack token" },
  // Match the WHOLE PEM block, not just the header line — otherwise the actual
  // key material between BEGIN and END survived redaction. First alternative
  // spans BEGIN…END (lazy `[\s\S]*?` across newlines); the fallback catches a
  // bare/truncated header with no END so a partial key is still flagged.
  { pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, type: "Private key" },
  { pattern: /mongodb(?:\+srv)?:\/\/[^\s"']+/g, type: "MongoDB connection string" },
  { pattern: /postgres(?:ql)?:\/\/[^\s"']+/g, type: "PostgreSQL connection string" },
  { pattern: /mysql:\/\/[^\s"']+/g, type: "MySQL connection string" },
  { pattern: /redis:\/\/[^\s"']+/g, type: "Redis connection string" },
  { pattern: /AKIA[0-9A-Z]{16}/g, type: "AWS access key" },
  { pattern: /AIza[0-9A-Za-z_-]{35}/g, type: "Google API key" },
  { pattern: /whsec_[a-zA-Z0-9]+/g, type: "Webhook secret" },
  { pattern: /password\s*[=:]\s*["'][^"']{4,}["']/gi, type: "Password in assignment" },
  // Unquoted assignment too (password=hunter2). Value runs to whitespace/quote/
  // separator so we don't swallow following words; require ≥4 non-space chars.
  { pattern: /password\s*[=:]\s*[^\s"';,]{4,}/gi, type: "Password in assignment" },
  { pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, type: "Bearer token" },
];

export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { pattern, type } of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      matches.push({ pattern: pattern.source, match: match[0], type, index: match.index });
    }
  }
  return matches;
}

export function redactSecrets(text: string): { redacted: string; found: SecretMatch[] } {
  const found = scanForSecrets(text);
  if (found.length === 0) return { redacted: text, found };

  // Redact in a single left-to-right pass. Sort by (index ASC, length DESC) so at each
  // position the LONGEST match wins (e.g. sk-proj-... beats the shorter sk-... overlap).
  // Skip any match that starts inside a previously-accepted span. `found` still reports ALL
  // matches (callers like handlers.ts neverConfirmTypes inspect .type), while `redacted`
  // uses only the non-overlapping subset.
  const order = [...found].sort((a, b) => a.index - b.index || b.match.length - a.match.length);
  let result = "";
  let cursor = 0;
  for (const m of order) {
    if (m.index < cursor) continue;
    result += text.slice(cursor, m.index);
    result += `[REDACTED:${m.type}]`;
    cursor = m.index + m.match.length;
  }
  result += text.slice(cursor);
  return { redacted: result, found };
}
