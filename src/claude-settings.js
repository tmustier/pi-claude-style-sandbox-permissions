import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function stripJsonComments(input) {
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

export function readJsonIfPresent(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch (error) {
    return { __configError: error instanceof Error ? error.message : String(error), __path: path };
  }
}

export function uniqueStrings(values) {
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    ),
  ];
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
    deny: Array.isArray(permissions.deny) ? permissions.deny : [],
  };
}

export function getClaudeLocalSettingsPath(ctx, config) {
  if (
    typeof config.writeClaudeCodeSettingsPath === "string" &&
    config.writeClaudeCodeSettingsPath.trim()
  ) {
    return resolveConfiguredClaudeSettingsPath(config.writeClaudeCodeSettingsPath.trim(), ctx);
  }
  return join(ctx.cwd, ".claude", "settings.local.json");
}

export function loadClaudeCodePermissionConfig(ctx, config) {
  const configuredPaths = Array.isArray(config.claudeCodeSettingsPaths)
    ? config.claudeCodeSettingsPaths.map((path) =>
        resolveConfiguredClaudeSettingsPath(String(path), ctx),
      )
    : defaultClaudeSettingsPaths(ctx);

  const allow = [];
  const ask = [];
  const deny = [];

  for (const path of uniqueStrings(configuredPaths)) {
    if (!shouldReadClaudeSettingsPath(path, ctx)) continue;
    const settings = readJsonIfPresent(path);
    if (!settings) continue;
    if (settings.__configError) {
      ctx.ui.notify?.(
        `claude-style-permissions: failed to parse Claude Code settings ${settings.__path}: ${settings.__configError}`,
        "warning",
      );
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
    claudeDenyRules: uniqueStrings(deny),
  };
}

export function persistClaudeAllowRule(ctx, config, rule) {
  const path = getClaudeLocalSettingsPath(ctx, config);
  const existing = readJsonIfPresent(path);
  if (existing?.__configError) {
    ctx.ui.notify?.(
      `claude-style-permissions: cannot persist approval; failed to parse ${existing.__path}: ${existing.__configError}`,
      "error",
    );
    return false;
  }

  const next = existing && typeof existing === "object" ? existing : {};
  const permissions =
    next.permissions && typeof next.permissions === "object" ? next.permissions : {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((value) => typeof value === "string")
    : [];

  if (!allow.includes(rule)) allow.push(rule);
  next.permissions = { ...permissions, allow };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  ctx.ui.notify?.(`Saved Claude Code allow rule to ${path}: ${rule}`, "info");
  return true;
}
