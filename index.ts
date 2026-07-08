import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBashCommand, DEFAULT_CONFIG, formatDecision, mergeConfig, suggestClaudeAllowRule } from "./src/policy.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSION_CONFIG_PATH = join(EXTENSION_DIR, "config.json");
const PROJECT_CONFIG_RELATIVE_PATH = [".pi", "claude-style-permissions.json"];

function stripJsonComments(input) {
  let output = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (escaped) {
      output += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      output += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      output += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      output += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      output += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }

    output += ch;
  }

  return output;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch (error) {
    return { __configError: error instanceof Error ? error.message : String(error), __path: path };
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function defaultClaudeSettingsPaths(ctx) {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const paths = [join(claudeHome, "settings.json")];

  // Project-local Claude Code settings can change the behavior of this Pi
  // extension, so honor them only when Pi already trusts the project context.
  if (ctx.isProjectTrusted?.()) {
    paths.push(join(ctx.cwd, ".claude", "settings.json"));
    paths.push(join(ctx.cwd, ".claude", "settings.local.json"));
  }

  return paths;
}

function resolveConfiguredClaudeSettingsPath(path, ctx) {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

function pathIsInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function shouldReadClaudeSettingsPath(path, ctx) {
  if (!pathIsInside(ctx.cwd, path)) return true;
  return ctx.isProjectTrusted?.() === true;
}

function extractClaudePermissionRules(settings) {
  const permissions = settings?.permissions;
  if (!permissions || typeof permissions !== "object") {
    return { allow: [], ask: [], deny: [] };
  }

  return {
    allow: Array.isArray(permissions.allow) ? permissions.allow : [],
    ask: Array.isArray(permissions.ask) ? permissions.ask : [],
    deny: Array.isArray(permissions.deny) ? permissions.deny : []
  };
}

function getClaudeLocalSettingsPath(ctx, config) {
  if (typeof config.writeClaudeCodeSettingsPath === "string" && config.writeClaudeCodeSettingsPath.trim()) {
    return resolveConfiguredClaudeSettingsPath(config.writeClaudeCodeSettingsPath.trim(), ctx);
  }
  return join(ctx.cwd, ".claude", "settings.local.json");
}

function loadClaudeCodePermissionConfig(ctx, config) {
  const configuredPaths = Array.isArray(config.claudeCodeSettingsPaths)
    ? config.claudeCodeSettingsPaths.map((path) => resolveConfiguredClaudeSettingsPath(String(path), ctx))
    : defaultClaudeSettingsPaths(ctx);

  const allow = [];
  const ask = [];
  const deny = [];

  for (const path of uniqueStrings(configuredPaths)) {
    if (!shouldReadClaudeSettingsPath(path, ctx)) continue;
    const settings = readJsonIfPresent(path);
    if (!settings) continue;
    if (settings.__configError) {
      ctx.ui.notify?.(`claude-style-permissions: failed to parse Claude Code settings ${settings.__path}: ${settings.__configError}`, "warning");
      continue;
    }

    const rules = extractClaudePermissionRules(settings);
    allow.push(...rules.allow);
    ask.push(...rules.ask);
    deny.push(...rules.deny);
  }

  return {
    claudeAllowRules: uniqueStrings(allow),
    claudeAskRules: uniqueStrings(ask),
    claudeDenyRules: uniqueStrings(deny)
  };
}

function persistClaudeAllowRule(ctx, config, rule) {
  const path = getClaudeLocalSettingsPath(ctx, config);
  const existing = readJsonIfPresent(path);
  if (existing?.__configError) {
    ctx.ui.notify?.(`claude-style-permissions: cannot persist approval; failed to parse ${existing.__path}: ${existing.__configError}`, "error");
    return false;
  }

  const next = existing && typeof existing === "object" ? existing : {};
  const permissions = next.permissions && typeof next.permissions === "object" ? next.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((value) => typeof value === "string") : [];

  if (!allow.includes(rule)) allow.push(rule);
  next.permissions = { ...permissions, allow };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  ctx.ui.notify?.(`Saved Claude Code allow rule to ${path}: ${rule}`, "info");
  return true;
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

  return config;
}

function compactPrompt(decision) {
  const details = decision.subcommands
    ?.map((part) => `• ${part.behavior}: ${part.command}${part.normalized && part.normalized !== part.command ? ` [${part.normalized}]` : ""}\n  ${part.reason}`)
    .join("\n") ?? "";

  return [
    "Claude-style permission check wants confirmation.",
    "",
    `Reason: ${decision.reason}`,
    "",
    "Command:",
    decision.command,
    details ? `\nBreakdown:\n${details}` : ""
  ].join("\n");
}

export default function (pi) {
  pi.registerCommand?.("permissions-check", {
    description: "Classify a bash command with the Claude-style permission model",
    handler: async (args, ctx) => {
      const command = String(args ?? "").trim();
      if (!command) {
        ctx.ui.notify("Usage: /permissions-check <bash command>", "warning");
        return;
      }
      const decision = classifyBashCommand(command, loadConfig(ctx));
      ctx.ui.notify(formatDecision(decision), decision.behavior === "deny" ? "error" : decision.behavior === "ask" ? "warning" : "info");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus?.("claude-perms", "perms: claude-style");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input?.command;
    if (typeof command !== "string") return undefined;

    const config = loadConfig(ctx);
    const decision = classifyBashCommand(command, config);

    if (decision.behavior === "allow") return undefined;

    if (decision.behavior === "deny") {
      return { block: true, reason: `Denied by claude-style-permissions: ${decision.reason}` };
    }

    if (config.autoApproveAsk) {
      return undefined;
    }

    if (!ctx.hasUI) {
      if (config.noUiAskDecision === "allow") return undefined;
      return { block: true, reason: `Permission required but no UI is available: ${decision.reason}` };
    }

    const suggestedRule = suggestClaudeAllowRule(decision);
    const approveOnce = "Yes, approve once";
    const approveAlways = suggestedRule ? `Yes, and don't ask again for ${suggestedRule}` : undefined;
    const deny = "No";
    const options = approveAlways && config.persistApprovalsToClaudeCodeSettings !== false
      ? [approveOnce, approveAlways, deny]
      : [approveOnce, deny];

    const choice = await ctx.ui.select(`${compactPrompt(decision)}\n\nProceed?`, options);
    if (choice === approveOnce) return undefined;
    if (approveAlways && choice === approveAlways) {
      persistClaudeAllowRule(ctx, config, suggestedRule);
      return undefined;
    }

    return { block: true, reason: "Blocked by user via claude-style-permissions" };
  });
}
