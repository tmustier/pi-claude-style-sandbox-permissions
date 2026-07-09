import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyBashCommand,
  DEFAULT_CONFIG,
  formatDecision,
  mergeConfig,
  suggestClaudeAllowRule
} from "./src/policy.js";
import { decide } from "./src/pipeline.js";
import {
  loadClaudeCodePermissionConfig,
  persistClaudeAllowRule,
  readJsonIfPresent
} from "./src/claude-settings.js";
import {
  cleanupAfterCommand,
  drainViolationsFor,
  ensureSandbox,
  formatViolationAnnotation,
  getSandboxStatus,
  sandboxBackend,
  sandboxEnabled,
  shutdown,
  wrapCommand
} from "./src/sandbox.js";
import { createOmnigentManagedOperations } from "./src/omnigent.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSION_CONFIG_PATH = join(EXTENSION_DIR, "config.json");
const PROJECT_CONFIG_RELATIVE_PATH = [".pi", "claude-style-permissions.json"];
let piSdkOverride;
let runtimeSandboxEnabledOverride;

export function __setPiSdkForTests(sdk) {
  piSdkOverride = sdk;
}

export function __resetPiSdkForTests() {
  piSdkOverride = undefined;
  runtimeSandboxEnabledOverride = undefined;
}

export function __resetRuntimeStateForTests() {
  runtimeSandboxEnabledOverride = undefined;
}

async function loadPiSdk() {
  if (piSdkOverride) return piSdkOverride;
  const overridePath = process.env.PI_CODING_AGENT_SDK_PATH;
  if (overridePath) return import(overridePath);
  return import("@earendil-works/pi-coding-agent");
}

function applyRuntimeSandboxOverride(config) {
  if (runtimeSandboxEnabledOverride === undefined) return config;
  return {
    ...config,
    sandbox: {
      ...(config.sandbox ?? {}),
      enabled: runtimeSandboxEnabledOverride
    }
  };
}

function loadConfig(ctx) {
  let config = DEFAULT_CONFIG;

  const extensionConfig = readJsonIfPresent(EXTENSION_CONFIG_PATH);
  if (extensionConfig?.__configError) {
    ctx.ui.notify?.(`claude-style-permissions: failed to parse ${extensionConfig.__path}: ${extensionConfig.__configError}`, "error");
  } else if (extensionConfig) {
    config = mergeConfig(config, extensionConfig);
  }

  const projectConfigPath = join(ctx.cwd, ...PROJECT_CONFIG_RELATIVE_PATH);
  if (ctx.isProjectTrusted?.()) {
    const projectConfig = readJsonIfPresent(projectConfigPath);
    if (projectConfig?.__configError) {
      ctx.ui.notify?.(`claude-style-permissions: failed to parse ${projectConfig.__path}: ${projectConfig.__configError}`, "error");
    } else if (projectConfig) {
      config = mergeConfig(config, projectConfig);
    }
  }

  if (config.importClaudeCodeSettings !== false) {
    config = mergeConfig(config, loadClaudeCodePermissionConfig(ctx, config));
  }

  return applyRuntimeSandboxOverride(config);
}

export function normalizeSandboxToggleShortcuts(value = DEFAULT_CONFIG.sandboxToggleShortcut) {
  if (value === false || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry && entry !== "none" && entry !== "disabled");
}

function loadConfiguredSandboxToggleShortcuts() {
  let config = DEFAULT_CONFIG;
  const extensionConfig = readJsonIfPresent(EXTENSION_CONFIG_PATH);
  if (extensionConfig && !extensionConfig.__configError) {
    config = mergeConfig(config, extensionConfig);
  }
  return normalizeSandboxToggleShortcuts(config.sandboxToggleShortcut);
}

function setPermissionStatus(ctx, config, reason) {
  if (!sandboxEnabled(config)) {
    ctx.ui.setStatus?.("claude-perms", reason === "shortcut"
      ? "perms: classify-only (shortcut override)"
      : "perms: classify-only (sandbox disabled)");
    return;
  }
  const backend = sandboxBackend(config);
  const status = getSandboxStatus(config);
  if (backend === "omnigent-managed") {
    ctx.ui.setStatus?.("claude-perms", status.reason ? "perms: omnigent-managed unavailable" : "perms: omnigent-managed (not checked)");
    return;
  }
  if (backend !== "srt") {
    ctx.ui.setStatus?.("claude-perms", "perms: backend unavailable");
    return;
  }
  ctx.ui.setStatus?.("claude-perms", status.reason ? "perms: classify-only (srt unavailable)" : "perms: srt-sandboxed");
}

async function toggleSandboxForSession(ctx) {
  const currentConfig = loadConfig(ctx);
  const nextEnabled = !sandboxEnabled(currentConfig);
  runtimeSandboxEnabledOverride = nextEnabled;
  const nextConfig = loadConfig(ctx);

  if (!nextEnabled) {
    setPermissionStatus(ctx, nextConfig, "shortcut");
    ctx.ui.notify?.("Claude-style permission sandbox disabled for this session; using classify-only checks.", "warning");
    return;
  }

  const status = await ensureSandbox(ctx, nextConfig);
  const backend = sandboxBackend(nextConfig);
  if (status.available) {
    ctx.ui.notify?.(`Claude-style permission sandbox enabled for this session (${backend}).`, "info");
  } else if (status.failClosed) {
    ctx.ui.notify?.(`Claude-style permission sandbox backend '${backend}' is unavailable; Bash will fail closed instead of running on the host: ${status.reason ?? "unknown error"}`, "warning");
  } else {
    ctx.ui.notify?.(`Claude-style permission sandbox requested, but srt is unavailable; staying classify-only: ${status.reason ?? "unknown error"}`, "warning");
  }
}

function compactPrompt(command, reason, config) {
  const decision = classifyBashCommand(command, { ...config, sandboxActive: false });
  const details = decision.subcommands
    ?.map((part) => `• ${part.behavior}: ${part.command}${part.normalized && part.normalized !== part.command ? ` [${part.normalized}]` : ""}\n  ${part.reason}`)
    .join("\n") ?? "";

  return [
    "Claude-style permission check wants confirmation.",
    "",
    `Reason: ${reason ?? decision.reason}`,
    "",
    "Command:",
    command,
    details ? `\nBreakdown:\n${details}` : ""
  ].join("\n");
}

function extendBashParameters(parameters) {
  return {
    ...parameters,
    properties: {
      ...(parameters?.properties ?? {}),
      dangerouslyDisableSandbox: {
        type: "boolean",
        description: "Retry this command outside the OS sandbox. Use only after a sandbox-caused failure or explicit user request; this triggers a permission prompt unless already allow-listed."
      }
    }
  };
}

function appendAnnotationText(text, annotation) {
  if (!annotation) return text;
  return `${text || "(no output)"}\n\n${annotation}`;
}

function appendAnnotationToResult(result, annotation, violations) {
  if (!annotation) return result;
  const content = Array.isArray(result.content) ? [...result.content] : [];
  const lastTextIndex = content.map((entry) => entry?.type).lastIndexOf("text");
  if (lastTextIndex >= 0) {
    content[lastTextIndex] = {
      ...content[lastTextIndex],
      text: appendAnnotationText(content[lastTextIndex].text, annotation)
    };
  } else {
    content.push({ type: "text", text: annotation });
  }
  return {
    ...result,
    content,
    details: {
      ...(result.details ?? {}),
      sandboxViolations: violations.map((violation) => violation.line)
    }
  };
}

async function askForApproval(ctx, config, command, decision, { safety = false, target = "unsandboxed" } = {}) {
  if (!ctx.hasUI) {
    return { approved: false, reason: `Permission required but no UI is available: ${decision.reason}` };
  }

  const suggestedRule = safety ? undefined : (decision.suggestedRule ?? suggestClaudeAllowRule(classifyBashCommand(command, { ...config, mode: "default", sandboxActive: false })));
  const approveOnce = "Yes, approve once";
  const approveAlways = suggestedRule ? `Yes, and don't ask again for ${suggestedRule}` : undefined;
  const deny = "No";
  const options = approveAlways && config.persistApprovalsToClaudeCodeSettings !== false
    ? [approveOnce, approveAlways, deny]
    : [approveOnce, deny];

  const choice = await ctx.ui.select(`${compactPrompt(command, decision.reason, config)}\n\nProceed ${target}?`, options);
  if (choice === approveOnce) return { approved: true };
  if (approveAlways && choice === approveAlways) {
    persistClaudeAllowRule(ctx, config, suggestedRule);
    return { approved: true };
  }

  return { approved: false, reason: "Blocked by user via claude-style-permissions" };
}

function sandboxAnnotationEnabled(config) {
  return config.sandbox?.annotateViolations !== false;
}

function killChildProcess(child) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
}

function createShellStringOperations() {
  return {
    exec(command, cwd, { onData, signal, timeout, env } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        const child = spawn(command, {
          cwd,
          shell: true,
          detached: process.platform !== "win32",
          env: env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });

        let timedOut = false;
        const timeoutHandle = timeout && timeout > 0
          ? setTimeout(() => {
            timedOut = true;
            killChildProcess(child);
          }, timeout * 1000)
          : undefined;
        const onAbort = () => killChildProcess(child);

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    }
  };
}

function createSandboxOperations(localOperations) {
  return {
    async exec(command, cwd, options) {
      try {
        return await localOperations.exec(command, cwd, options);
      } finally {
        cleanupAfterCommand();
      }
    }
  };
}

function sandboxPromptSection(config) {
  if (sandboxBackend(config) === "omnigent-managed") {
    return [
      "",
      "## Bash Omnigent managed sandbox",
      "Bash commands run in the configured Omnigent managed environment by default. This backend is opt-in and fails closed if the server, session, environment, auth, or runner is unavailable.",
      "Do not set `dangerouslyDisableSandbox: true` preemptively; it is an escalation request, not an approval.",
      "If the Omnigent backend reports setup or availability errors, do not fall back to local host Bash; ask the operator to fix the backend or deliberately change the sandbox configuration.",
      "Do not retry hard-denied catastrophic/root/system-destructive commands unsandboxed.",
      "Return to normal sandboxed Bash calls after any one approved unsandboxed retry."
    ].join("\n");
  }

  return [
    "",
    "## Bash OS sandbox",
    "Bash commands run in an OS sandbox by default. The sandbox permits workspace and /tmp writes and blocks network access unless configured.",
    "Do not set `dangerouslyDisableSandbox: true` preemptively; it is an escalation request, not an approval.",
    "If a command fails and the output shows sandbox evidence (for example Operation not permitted, denied writes outside the workspace, blocked proxy/network, or Unix socket denial), retry once with `dangerouslyDisableSandbox: true`.",
    "That retry will ask the user for permission; briefly explain which sandbox restriction appears to be responsible.",
    "Do not retry hard-denied catastrophic/root/system-destructive commands unsandboxed.",
    "Return to normal sandboxed Bash calls after that one retry."
  ].join("\n");
}

export default async function (pi) {
  const sdk = await loadPiSdk();
  const { createBashTool } = sdk;
  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);
  const localOperations = typeof sdk.createLocalBashOperations === "function"
    ? sdk.createLocalBashOperations()
    : createShellStringOperations();

  for (const shortcut of loadConfiguredSandboxToggleShortcuts()) {
    pi.registerShortcut?.(shortcut, {
      description: "Toggle Claude-style permission sandbox for this session",
      handler: async (ctx) => {
        await toggleSandboxForSession(ctx);
      }
    });
  }

  pi.registerCommand?.("permissions-check", {
    description: "Classify a bash command with the Claude-style permission pipeline",
    handler: async (args, ctx) => {
      const command = String(args ?? "").trim();
      if (!command) {
        ctx.ui.notify("Usage: /permissions-check <bash command>", "warning");
        return;
      }
      const config = loadConfig(ctx);
      const preflightDecision = decide(command, { config, sandboxAvailable: false });
      const sandboxStatus = preflightDecision.action === "deny"
        ? { available: false }
        : sandboxEnabled(config)
          ? await ensureSandbox(ctx, config)
          : { available: false };
      const pipelineDecision = sandboxStatus.failClosed && !sandboxStatus.available
        ? { action: "deny", reason: sandboxStatus.reason }
        : decide(command, { config, sandboxAvailable: sandboxStatus.available });
      const classifierDecision = classifyBashCommand(command, { ...config, sandboxActive: sandboxStatus.available });
      const text = `${formatDecision(classifierDecision)}\nPipeline action: ${pipelineDecision.action}${pipelineDecision.reason ? ` — ${pipelineDecision.reason}` : ""}`;
      ctx.ui.notify(text, pipelineDecision.action === "deny" ? "error" : pipelineDecision.action.includes("ask") ? "warning" : "info");
    }
  });

  pi.registerTool?.({
    ...localBash,
    parameters: extendBashParameters(localBash.parameters),
    async execute(id, params, signal, onUpdate, ctx) {
      const command = params?.command;
      if (typeof command !== "string") {
        throw new Error("Bash command must be a string");
      }

      const timeout = typeof params.timeout === "number" ? params.timeout : undefined;
      const config = loadConfig(ctx);
      const preflightDecision = decide(command, {
        config,
        dangerouslyDisableSandbox: params.dangerouslyDisableSandbox === true,
        sandboxAvailable: false
      });
      if (preflightDecision.action === "deny") {
        throw new Error(`Denied by claude-style-permissions: ${preflightDecision.reason}`);
      }

      const sandboxStatus = sandboxEnabled(config) ? await ensureSandbox(ctx, config) : { available: false };
      if (sandboxStatus.failClosed && !sandboxStatus.available) {
        throw new Error(`Sandbox backend unavailable; command was not run: ${sandboxStatus.reason ?? "unknown error"}`);
      }

      const pipelineDecision = decide(command, {
        config,
        dangerouslyDisableSandbox: params.dangerouslyDisableSandbox === true,
        sandboxAvailable: sandboxStatus.available
      });

      if (pipelineDecision.action === "deny") {
        throw new Error(`Denied by claude-style-permissions: ${pipelineDecision.reason}`);
      }

      const runSandboxed = async () => {
        if (sandboxBackend(config) === "omnigent-managed") {
          const sandboxTool = createBashTool(localCwd, { operations: createOmnigentManagedOperations(config, ctx) });
          return sandboxTool.execute(id, { command, timeout }, signal, onUpdate, ctx);
        }

        const wrapped = await wrapCommand(command, signal);
        const sandboxTool = createBashTool(localCwd, { operations: createSandboxOperations(localOperations) });
        try {
          const result = await sandboxTool.execute(id, { command: wrapped, timeout }, signal, onUpdate, ctx);
          if (!sandboxAnnotationEnabled(config)) return result;
          const violations = await drainViolationsFor(command, { waitMs: 0 });
          const annotation = formatViolationAnnotation(violations);
          return appendAnnotationToResult(result, annotation, violations);
        } catch (error) {
          if (!sandboxAnnotationEnabled(config)) throw error;
          const violations = await drainViolationsFor(command, { waitMs: 1200 });
          const annotation = formatViolationAnnotation(violations);
          if (!annotation) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(appendAnnotationText(message, annotation));
        }
      };

      if (pipelineDecision.action === "ask-sandboxed" || pipelineDecision.action === "ask-unsandboxed") {
        const approval = await askForApproval(ctx, config, command, pipelineDecision, {
          safety: pipelineDecision.safety === true,
          target: pipelineDecision.action === "ask-sandboxed" ? "sandboxed" : "unsandboxed"
        });
        if (!approval.approved) {
          throw new Error(approval.reason ?? "Blocked by claude-style-permissions");
        }
      }

      if (pipelineDecision.action === "run-sandboxed" || pipelineDecision.action === "ask-sandboxed") {
        return runSandboxed();
      }

      return localBash.execute(id, { command, timeout }, signal, onUpdate, ctx);
    }
  });

  pi.on?.("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx);
    setPermissionStatus(ctx, config);
  });

  pi.on?.("session_shutdown", async () => {
    await shutdown();
  });

  pi.on?.("before_agent_start", async (event, ctx) => {
    const config = loadConfig(ctx);
    const status = getSandboxStatus(config);
    if (!sandboxEnabled(config) || status.reason) return undefined;
    return { systemPrompt: `${event.systemPrompt}${sandboxPromptSection(config)}` };
  });

  pi.on?.("user_bash", () => {
    return { operations: localOperations };
  });
}
