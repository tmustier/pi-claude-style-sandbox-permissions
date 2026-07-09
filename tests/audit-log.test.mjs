import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLogger, redactAuditString, summarizeCommandForAudit } from "../src/audit-log.js";

test("audit logger appends JSONL under the configured local directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-perms-audit-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const logger = new AuditLogger({ directory: dir, fileNamePrefix: "test-audit" });
  await logger.log({ event: "tool_call_allowed", ok: true });
  await logger.flush();

  const date = new Date().toISOString().slice(0, 10);
  const lines = (await readFile(join(dir, `test-audit-${date}.jsonl`), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.extension, "pi-claude-style-sandbox-permissions");
  assert.equal(entry.event, "tool_call_allowed");
  assert.equal(entry.ok, true);
});

test("audit command summaries redact common credential shapes", () => {
  const command =
    "curl -H 'Authorization: Bearer bearer-value-for-redaction' 'https://example.com?token=query-value-for-redaction' --password placeholder-value";
  const summary = summarizeCommandForAudit(command, { auditLog: { maxCommandPreviewChars: 500 } });
  const serialized = JSON.stringify(summary);

  assert.equal(summary.hash.length, 64);
  assert.doesNotMatch(serialized, /bearer-value-for-redaction/);
  assert.doesNotMatch(serialized, /query-value-for-redaction/);
  assert.doesNotMatch(serialized, /placeholder-value/);
  assert.match(redactAuditString(command), /Bearer <redacted>/);
  assert.match(serialized, /<redacted>/);
});

test("audit command summaries redact GitHub PAT shapes from every preview", () => {
  const classicPrefix = ["g", "h", "p", "_"].join("");
  const fineGrainedPrefix = ["github", "pat", ""].join("_");
  const classicPat = `${classicPrefix}${"A".repeat(36)}`;
  const fineGrainedPat = `${fineGrainedPrefix}${"A".repeat(22)}_${"B".repeat(59)}`;
  const command = `echo ${classicPat} ${fineGrainedPat}`;
  const summary = summarizeCommandForAudit(command, { auditLog: { maxCommandPreviewChars: 500 } });
  const serialized = JSON.stringify(summary);

  assert.doesNotMatch(serialized, new RegExp(classicPat));
  assert.doesNotMatch(serialized, new RegExp(fineGrainedPat));
  assert.doesNotMatch(summary.preview, new RegExp(classicPat));
  assert.doesNotMatch(summary.preview, new RegExp(fineGrainedPat));
  assert.match(summary.preview, /<redacted-github-token>/);
  for (const subcommand of summary.subcommands) {
    assert.doesNotMatch(subcommand.normalizedPreview, new RegExp(classicPat));
    assert.doesNotMatch(subcommand.normalizedPreview, new RegExp(fineGrainedPat));
  }
  assert.match(summary.subcommands[0]?.normalizedPreview ?? "", /<redacted-github-token>/);
});
