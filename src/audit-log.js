import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { normalizeTokens, splitShellCommand, tokenizeShellWords } from "./policy.js";

const EXTENSION_ID = "pi-claude-style-sandbox-permissions";
const DEFAULT_MAX_COMMAND_PREVIEW_CHARS = 240;
const DEFAULT_AUDIT_SUBDIR = [".pi", "agent", "claude-style-permissions", "audit"];

let auditLoggerOverride;
let defaultAuditLogger;

export function __setAuditLoggerForTests(logger) {
  auditLoggerOverride = logger;
}

export function __resetAuditLoggerForTests() {
  auditLoggerOverride = undefined;
  defaultAuditLogger.configure({});
}

export async function flushAuditLogger() {
  const logger = auditLoggerOverride ?? defaultAuditLogger;
  await logger.flush?.();
}

export function createApprovalId() {
  return randomUUID();
}

function expandHome(path) {
  if (typeof path !== "string" || !path.trim()) return undefined;
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function defaultAuditDirectory() {
  return join(homedir(), ...DEFAULT_AUDIT_SUBDIR);
}

function resolveAuditDirectory(options = {}) {
  const configured = expandHome(
    options.directory ?? process.env.PI_CLAUDE_STYLE_PERMISSIONS_AUDIT_DIR,
  );
  return configured ? resolve(configured) : defaultAuditDirectory();
}

function auditDate(timestamp = new Date()) {
  return timestamp.toISOString().slice(0, 10);
}

function auditFilePath(options = {}, timestamp = new Date()) {
  const prefix =
    typeof options.fileNamePrefix === "string" && options.fileNamePrefix.trim()
      ? options.fileNamePrefix.trim()
      : "audit";
  return join(resolveAuditDirectory(options), `${prefix}-${auditDate(timestamp)}.jsonl`);
}

export class AuditLogger {
  constructor(options = {}) {
    this.configure(options);
    this.queue = Promise.resolve();
    this.lastError = undefined;
  }

  configure(options = {}) {
    this.options = { ...options };
  }

  log(entry) {
    const options = { ...this.options };
    if (options.enabled === false) return Promise.resolve();

    const timestamp = new Date();
    const directory = resolveAuditDirectory(options);
    const path = auditFilePath(options, timestamp);
    const line = `${JSON.stringify({
      schemaVersion: 1,
      extension: EXTENSION_ID,
      timestamp: timestamp.toISOString(),
      ...entry,
    })}\n`;

    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) => {
        this.lastError = error instanceof Error ? error : new Error(String(error));
      });

    return this.queue;
  }

  async flush() {
    await this.queue.catch(() => undefined);
  }
}

defaultAuditLogger = new AuditLogger();

export function getAuditLogger(config = {}) {
  if (auditLoggerOverride) return auditLoggerOverride;
  defaultAuditLogger.configure(config.auditLog ?? {});
  return defaultAuditLogger;
}

function truncate(value, maxChars = DEFAULT_MAX_COMMAND_PREVIEW_CHARS) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: `${text.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

export function redactAuditString(value) {
  let text = String(value ?? "");

  text = text.replace(
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH|CREDENTIAL)[A-Za-z0-9_]*)=([^\s]+)/gi,
    "$1=<redacted>",
  );
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>");
  text = text.replace(
    /([?&](?:access_token|api[_-]?key|key|password|secret|token)=)[^&\s]+/gi,
    "$1<redacted>",
  );
  text = text.replace(
    /(--?(?:access[-_]?token|api[-_]?key|password|passwd|secret|token)(?:=|\s+))([^\s]+)/gi,
    "$1<redacted>",
  );
  text = text.replace(/:\/\/([^\s/@:]+):([^\s/@]+)@/g, "://<redacted>@");
  text = text.replace(
    /\bgithub_pat_[A-Za-z0-9_]{20,}_[A-Za-z0-9_]{20,}\b/g,
    "<redacted-github-token>",
  );
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>");
  text = text.replace(
    /\b(?:gh[pousr]|github_pat)-[A-Za-z0-9_=-]{8,}\b/g,
    "<redacted-github-token>",
  );
  text = text.replace(/\b(?:sk|pk|rk|xox[baprs]?)-[A-Za-z0-9_=-]{8,}\b/g, "<redacted-token>");
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws-key>");

  return text;
}

function commandHash(command) {
  return createHash("sha256")
    .update(String(command ?? ""), "utf8")
    .digest("hex");
}

function summarizeSubcommand(subcommand, config, maxChars) {
  const tokens = normalizeTokens(tokenizeShellWords(subcommand), config);
  const executable = tokens[0] ? redactAuditString(tokens[0]) : undefined;
  const normalized = redactAuditString(tokens.join(" "));
  const preview = truncate(normalized, maxChars);
  return {
    executable,
    argCount: Math.max(0, tokens.length - 1),
    normalizedPreview: preview.value,
    normalizedPreviewTruncated: preview.truncated,
  };
}

export function summarizeCommandForAudit(command, config = {}) {
  const maxChars =
    typeof config.auditLog?.maxCommandPreviewChars === "number"
      ? config.auditLog.maxCommandPreviewChars
      : typeof config.maxCommandPreviewChars === "number"
        ? config.maxCommandPreviewChars
        : DEFAULT_MAX_COMMAND_PREVIEW_CHARS;
  const redacted = redactAuditString(command);
  const preview = truncate(redacted, maxChars);

  return {
    hash: commandHash(command),
    byteLength: Buffer.byteLength(String(command ?? ""), "utf8"),
    preview: preview.value,
    previewTruncated: preview.truncated,
    subcommands: splitShellCommand(String(command ?? ""))
      .slice(0, 10)
      .map((subcommand) => summarizeSubcommand(subcommand, config, Math.min(maxChars, 160))),
  };
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function messageHasToolCall(message, toolCallId) {
  if (!toolCallId || message?.role !== "assistant" || !Array.isArray(message.content)) return false;
  return message.content.some((part) => part?.type === "toolCall" && part.id === toolCallId);
}

function findToolCallEntry(sessionManager, toolCallId) {
  const branch = safeCall(() => sessionManager?.getBranch?.());
  const entries = Array.isArray(branch) ? branch : safeCall(() => sessionManager?.getEntries?.());
  if (!Array.isArray(entries)) return undefined;
  return [...entries]
    .reverse()
    .find((entry) => entry?.type === "message" && messageHasToolCall(entry.message, toolCallId));
}

export function buildSessionReference(ctx, { toolCallId, turnRef } = {}) {
  const sessionManager = ctx?.sessionManager;
  const toolEntry = findToolCallEntry(sessionManager, toolCallId);
  const sessionFile = safeCall(() => sessionManager?.getSessionFile?.());
  const leafEntryId = safeCall(() => sessionManager?.getLeafId?.());
  const sessionId = safeCall(() => sessionManager?.getSessionId?.());

  return {
    sessionFile,
    sessionId,
    sessionBasename: sessionFile ? basename(sessionFile) : undefined,
    leafEntryId,
    assistantEntryId: toolEntry?.id,
    toolCallId,
    turnIndex: turnRef?.turnIndex,
    turnTimestamp: turnRef?.timestamp,
  };
}

function summarizeDecision(decision, { sandboxStatus, dangerouslyDisableSandbox } = {}) {
  return {
    action: decision?.action,
    reason: decision?.reason,
    safety: decision?.safety === true,
    suggestedRule: decision?.suggestedRule,
    sandboxAvailable: sandboxStatus?.available === true,
    sandboxUnavailableReason: sandboxStatus?.reason,
    dangerouslyDisableSandbox: dangerouslyDisableSandbox === true,
  };
}

export function createAuditContext({
  config = {},
  ctx,
  toolCallId,
  command,
  decision,
  sandboxStatus,
  dangerouslyDisableSandbox,
  turnRef,
} = {}) {
  if (config.auditLog?.enabled === false) {
    return {
      enabled: false,
      logAllowed() {},
      logApprovalRequested() {},
      logApprovalOutcome() {},
    };
  }

  const logger = getAuditLogger(config);
  const session = buildSessionReference(ctx, { toolCallId, turnRef });
  const commandSummary = summarizeCommandForAudit(command, config);
  const decisionSummary = summarizeDecision(decision, { sandboxStatus, dangerouslyDisableSandbox });

  const base = {
    session,
    command: commandSummary,
    decision: decisionSummary,
  };

  const write = (event, extra = {}) => {
    void logger.log({
      event,
      ...base,
      ...extra,
    });
  };

  return {
    enabled: true,
    logAllowed({ approvalId, executionTarget } = {}) {
      write("tool_call_allowed", {
        execution: { target: executionTarget },
        approval: approvalId ? { id: approvalId } : undefined,
      });
    },
    logApprovalRequested(details = {}) {
      write("approval_requested", { approval: details });
    },
    logApprovalOutcome(details = {}) {
      write("approval_outcome", { approval: details });
    },
  };
}
