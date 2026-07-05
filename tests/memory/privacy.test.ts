import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, redactSecrets } from "../../src/memory/privacy.js";

describe("Privacy scanning", () => {
  it("detects OpenAI API keys", () => {
    const text = "Set OPENAI_API_KEY=sk-abc123def456ghi789jkl012mno345";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "OpenAI API key");
  });

  it("detects GitHub tokens", () => {
    const text = "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "GitHub token");
  });

  it("detects private keys", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowI...";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "Private key");
  });

  it("detects MongoDB connection strings", () => {
    const text = "mongodb://admin:password123@localhost:27017/mydb";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "MongoDB connection string");
  });

  it("detects PostgreSQL connection strings", () => {
    const text = "postgresql://user:pass@db.example.com:5432/mydb";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "PostgreSQL connection string");
  });

  it("detects AWS access keys", () => {
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "AWS access key");
  });

  it("detects webhook secrets", () => {
    const text = "whsec_abc123def456ghi789";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0].type, "Webhook secret");
  });

  it("detects multiple secrets in one text", () => {
    const text = "Key: sk-abc123def456ghi789jkl012mno345 and token: ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const matches = scanForSecrets(text);
    assert.ok(matches.length >= 2);
  });

  it("returns empty array for clean text", () => {
    const text = "This is a normal fragment about React hooks and state management.";
    const matches = scanForSecrets(text);
    assert.equal(matches.length, 0);
  });

  it("does not false-positive on short strings like sk-", () => {
    const text = "The sk- prefix is used for OpenAI keys";
    const matches = scanForSecrets(text);
    assert.equal(matches.length, 0);
  });
});

describe("Redaction", () => {
  it("redacts OpenAI keys with type label", () => {
    const text = "Use key sk-abc123def456ghi789jkl012mno345 for API access";
    const { redacted, found } = redactSecrets(text);
    assert.ok(found.length >= 1);
    assert.ok(!redacted.includes("sk-abc123def456ghi789jkl012mno345"));
    assert.ok(redacted.includes("[REDACTED:OpenAI API key]"));
  });

  it("preserves surrounding text", () => {
    const text = "Fixed webhook using whsec_mysecret123 endpoint";
    const { redacted } = redactSecrets(text);
    assert.ok(redacted.startsWith("Fixed webhook using"));
    assert.ok(redacted.includes("[REDACTED:Webhook secret]"));
    assert.ok(redacted.includes("endpoint"));
  });

  it("redacts multiple secrets", () => {
    const text = "sk-abc123def456ghi789jkl012mno345 and ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const { redacted, found } = redactSecrets(text);
    assert.ok(found.length >= 2);
    assert.ok(!redacted.includes("sk-abc123"));
    assert.ok(!redacted.includes("ghp_"));
  });

  it("returns unchanged text when no secrets", () => {
    const text = "Normal fragment about TypeScript strict mode";
    const { redacted, found } = redactSecrets(text);
    assert.equal(found.length, 0);
    assert.equal(redacted, text);
  });

  it("does not over-redact a repeated standalone secret value (replaceAll bug fix)", () => {
    // The buggy replaceAll impl redacted EVERY occurrence of the matched value, including
    // the bare `secret1234` later in the text. Position-based redaction must touch only the
    // span that actually matched password="...".
    const text = 'config has password="secret1234" but the word secret1234 alone is fine';
    const { redacted } = redactSecrets(text);
    const placeholderCount = (redacted.match(/\[REDACTED:[^\]]+\]/g) || []).length;
    assert.equal(placeholderCount, 1, "exactly one placeholder expected");
    assert.ok(redacted.includes("[REDACTED:Password in assignment]"));
    // The standalone secret1234 (NOT preceded by password=") must survive untouched.
    assert.ok(redacted.includes("the word secret1234 alone is fine"));
  });

  it("sk-proj- overlap: longest match wins in redacted output", () => {
    // Both sk-proj-... (project key) and sk-... (API key) patterns match the same span.
    // redacted must contain exactly ONE placeholder, the LONGER project-key type.
    const text = "leaked: sk-proj-abcdefghijklmnopqrst1234567890";
    const { redacted, found } = redactSecrets(text);
    const placeholderCount = (redacted.match(/\[REDACTED:[^\]]+\]/g) || []).length;
    assert.equal(placeholderCount, 1, "exactly one placeholder (longest wins)");
    assert.ok(redacted.includes("[REDACTED:OpenAI project key]"));
    assert.ok(!redacted.includes("sk-proj-abcdefghijklmnopqrst1234567890"));
    assert.ok(!redacted.includes("sk-proj-"));
    // found MAY report 2 due to the sk- overlap; require at least 1.
    assert.ok(found.length >= 1);
  });

  it("found reports ALL matches incl overlaps while redacted uses longest-wins", () => {
    // Documents the found-vs-redacted semantics: `found` includes overlapping matches so
    // callers inspecting .type (e.g. handlers.ts neverConfirmTypes) see every candidate,
    // while `redacted` collapses to the longest non-overlapping subset.
    const text = "key=sk-proj-abcdefghijklmnopqrst1234567890";
    const { found } = redactSecrets(text);
    const types = found.map(f => f.type);
    assert.ok(types.includes("OpenAI project key"), "project key type must be present in found");
  });
});

describe("Private key & password redaction (regression)", () => {
  it("redacts the ENTIRE PEM block, not just the header line", () => {
    const text = [
      "here is my key:",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1234SECRETKEYMATERIAL5678notredacted9012",
      "QIDAQABAoIBAQC7verySecretPrivateExponentThatShouldNeverLeak",
      "-----END RSA PRIVATE KEY-----",
      "done",
    ].join("\n");
    const { redacted } = redactSecrets(text);
    assert.ok(!redacted.includes("SECRETKEYMATERIAL"), "key body must be redacted");
    assert.ok(!redacted.includes("verySecretPrivateExponent"), "key body must be redacted");
    assert.ok(!redacted.includes("-----END RSA PRIVATE KEY-----"), "END footer must be redacted");
    assert.ok(redacted.includes("[REDACTED:Private key]"));
  });

  it("still flags a bare/truncated header with no END line", () => {
    const { found } = redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEowI...");
    assert.ok(found.some(f => f.type === "Private key"));
  });

  it("redacts an unquoted password assignment", () => {
    const { redacted } = redactSecrets("db password=hunter2 here");
    assert.ok(!redacted.includes("hunter2"), "unquoted password value must be redacted");
    assert.ok(redacted.includes("[REDACTED:Password in assignment]"));
  });
});
