import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { SandboxManager as ImportedSandboxManager } from "@anthropic-ai/sandbox-runtime";

const DEFAULT_DENY_READ = ["~/.ssh", "~/.aws", "~/.gnupg"];

let SandboxManager = ImportedSandboxManager;
let state = freshState();

function freshState() {
  return {
    initialized: false,
    initializing: null,
    available: false,
    failure: null,
    runtimeConfig: null,
    store: null,
    unsubscribe: null,
    cachedViolations: [],
    drained: new Set(),
  };
}

export function __setSandboxManagerForTests(manager) {
  SandboxManager = manager ?? ImportedSandboxManager;
  state = freshState();
}

export function __resetSandboxStateForTests() {
  SandboxManager = ImportedSandboxManager;
  state = freshState();
}

function asStringArray(values) {
  return Array.isArray(values)
    ? values
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function resolveSandboxPath(path, cwd) {
  if (typeof path !== "string" || !path.trim()) return undefined;
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

export function deriveSandboxConfig(ctx, config = {}) {
  const cwd = resolve(ctx.cwd ?? process.cwd());
  const sandbox = config.sandbox && typeof config.sandbox === "object" ? config.sandbox : {};
  const expand = (value) => resolveSandboxPath(value, cwd);

  const allowWrite = unique([
    cwd,
    "/tmp",
    tmpdir(),
    ...asStringArray(sandbox.allowWrite).map(expand),
  ]);

  const denyWrite = unique(asStringArray(sandbox.denyWrite).map(expand));
  const denyRead = unique([...DEFAULT_DENY_READ, ...asStringArray(sandbox.denyRead)].map(expand));

  return {
    network: {
      allowedDomains: unique(asStringArray(sandbox.allowedDomains)),
      deniedDomains: unique(asStringArray(sandbox.deniedDomains)),
    },
    filesystem: {
      denyRead,
      allowWrite,
      denyWrite,
    },
  };
}

export function sandboxEnabled(config = {}) {
  return config.sandbox?.enabled !== false;
}

function setStatus(ctx, text) {
  ctx?.ui?.setStatus?.("claude-perms", text);
}

function attachViolationStore() {
  const store = SandboxManager.getSandboxViolationStore?.();
  state.store = store ?? null;
  if (!store?.subscribe) return;
  state.unsubscribe?.();
  state.unsubscribe = store.subscribe((violations) => {
    state.cachedViolations = Array.isArray(violations) ? violations : [];
  });
}

export function getSandboxStatus() {
  if (state.available)
    return { available: true, initialized: state.initialized, reason: undefined };
  if (state.failure)
    return {
      available: false,
      initialized: state.initialized,
      reason: state.failure.message ?? String(state.failure),
    };
  return { available: false, initialized: state.initialized, reason: undefined };
}

export async function ensureSandbox(ctx, config = {}) {
  if (!sandboxEnabled(config)) {
    setStatus(ctx, "perms: classify-only (sandbox disabled)");
    return { available: false, reason: "sandbox disabled" };
  }

  if (state.available && state.initialized) {
    setStatus(ctx, "perms: srt-sandboxed");
    return { available: true };
  }

  if (state.failure) {
    setStatus(ctx, "perms: classify-only (srt unavailable)");
    return { available: false, reason: state.failure.message ?? String(state.failure) };
  }

  if (!state.initializing) {
    state.initializing = (async () => {
      const runtimeConfig = deriveSandboxConfig(ctx, config);
      state.runtimeConfig = runtimeConfig;
      try {
        await SandboxManager.initialize(runtimeConfig, undefined, true);
        attachViolationStore();
        state.initialized = true;
        state.available = true;
        setStatus(ctx, "perms: srt-sandboxed");
        return { available: true };
      } catch (error) {
        state.initialized = false;
        state.available = false;
        state.failure = error instanceof Error ? error : new Error(String(error));
        setStatus(ctx, "perms: classify-only (srt unavailable)");
        ctx?.ui?.notify?.(
          `claude-style-permissions: srt sandbox unavailable; falling back to classify-only mode: ${state.failure.message}`,
          "warning",
        );
        return { available: false, reason: state.failure.message };
      } finally {
        state.initializing = null;
      }
    })();
  }

  return state.initializing;
}

export async function wrapCommand(command, signal) {
  if (!state.available) {
    throw new Error("Sandbox is not available");
  }
  return SandboxManager.wrapWithSandbox(command, undefined, undefined, signal);
}

function getStoreViolationsForCommand(command) {
  const store = state.store ?? SandboxManager.getSandboxViolationStore?.();
  if (store?.getViolationsForCommand) {
    return store.getViolationsForCommand(command);
  }
  return state.cachedViolations.filter((violation) => violation.command === command);
}

function violationFingerprint(violation) {
  const timestamp =
    violation?.timestamp instanceof Date
      ? violation.timestamp.getTime()
      : typeof violation?.timestamp === "string"
        ? violation.timestamp
        : "";
  return `${violation?.encodedCommand ?? ""}\n${violation?.command ?? ""}\n${timestamp}\n${violation?.line ?? ""}`;
}

function drainUnseen(violations) {
  const out = [];
  for (const violation of violations ?? []) {
    const key = violationFingerprint(violation);
    if (state.drained.has(key)) continue;
    state.drained.add(key);
    out.push(violation);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function drainViolationsFor(
  command,
  { waitMs = 0, pollMs = 100, includeUncorrelated = true } = {},
) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let matched = drainUnseen(getStoreViolationsForCommand(command));

  while (matched.length === 0 && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    matched = drainUnseen(getStoreViolationsForCommand(command));
  }

  if (matched.length > 0 || !includeUncorrelated) return matched;

  // Graceful degradation for platforms/log formats that record violations but
  // cannot correlate them back to the encoded command marker.
  return drainUnseen(
    state.cachedViolations.filter((violation) => !violation.command && !violation.encodedCommand),
  );
}

export function formatViolationAnnotation(violations) {
  if (!violations?.length) return "";
  const shown = violations
    .slice(0, 5)
    .map((violation) => `- ${violation.line ?? String(violation)}`);
  const suffix =
    violations.length > shown.length ? `\n- ... ${violations.length - shown.length} more` : "";
  return `[sandbox] ${violations.length} violation(s):\n${shown.join("\n")}${suffix}`;
}

export function cleanupAfterCommand() {
  SandboxManager.cleanupAfterCommand?.();
}

export async function shutdown() {
  const current = state;
  state = freshState();
  current.unsubscribe?.();
  await SandboxManager.reset?.();
}
