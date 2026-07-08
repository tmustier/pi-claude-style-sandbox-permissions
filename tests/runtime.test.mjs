import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../index.ts";

function installExtension() {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    }
  };
  extension(pi);
  return { handlers, commands };
}

async function makeTempProject(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-style-perms-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "pi-claude-style-home-"));
  const oldClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  t.after(async () => {
    if (oldClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldClaudeConfigDir;
    await rm(root, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  });
  return root;
}

async function runTool(toolName, input, { cwd, trusted = true, hasUI = false, select } = {}) {
  const { handlers } = installExtension();
  const notifications = [];
  let selectPrompt;
  let selectOptions;
  const ctx = {
    cwd,
    hasUI,
    isProjectTrusted: () => trusted,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus() {},
      async select(prompt, options) {
        selectPrompt = prompt;
        selectOptions = options;
        return select ? select(prompt, options) : undefined;
      }
    }
  };

  const result = await handlers.get("tool_call")({ toolName, input }, ctx);
  return { result, notifications, selectPrompt, selectOptions };
}

async function runBashTool(command, options = {}) {
  return runTool("bash", { command }, options);
}

test("registers command and hooks and ignores non-bash tools", async (t) => {
  const cwd = await makeTempProject(t);
  const { handlers, commands } = installExtension();
  assert.equal(typeof handlers.get("tool_call"), "function");
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof commands.get("permissions-check")?.handler, "function");

  const { result } = await runTool("read", { path: "package.json" }, { cwd, trusted: true, hasUI: false });
  assert.equal(result, undefined);
});

test("imports user Claude Code settings independently of project trust", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(git push:*)"] }
  }));

  const { result } = await runBashTool("git push origin main", { cwd, trusted: false, hasUI: false });
  assert.equal(result, undefined);
});

test("imports trusted project Claude Code Bash settings with JSON comments", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), `{
    // JSON comments are tolerated.
    "permissions": {
      "allow": ["Bash(git push:*)"],
      "ask": ["Read(**)"],
      "deny": ["Read(**)"]
    }
  }\n`);

  const { result, notifications } = await runBashTool("git push origin main", { cwd, trusted: true, hasUI: false });
  assert.equal(result, undefined);
  assert.equal(notifications.some((entry) => entry.level === "warning"), false);
});

test("ignores project Claude Code settings until the project is trusted", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(git push:*)"] }
  }));

  const { result } = await runBashTool("git push origin main", { cwd, trusted: false, hasUI: false });
  assert.equal(result?.block, true);
  assert.match(result?.reason, /Permission required but no UI/);
});

test("rejects trailing-comma Claude Code settings with a warning", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), `{
    "permissions": {
      "allow": ["Bash(git push:*)",]
    }
  }\n`);

  const { result, notifications } = await runBashTool("git push origin main", { cwd, trusted: true, hasUI: false });
  assert.equal(result?.block, true);
  assert.equal(notifications.some((entry) => entry.level === "warning" && entry.message.includes("failed to parse Claude Code settings")), true);
});

test("cancelled prompt blocks safely", async (t) => {
  const cwd = await makeTempProject(t);
  const { result, selectOptions } = await runBashTool("git push origin main", {
    cwd,
    trusted: true,
    hasUI: true,
    select: () => undefined
  });

  assert.deepEqual(selectOptions?.map((option) => option.startsWith("Yes") ? "yes" : option), ["yes", "yes", "No"]);
  assert.equal(result?.block, true);
  assert.match(result?.reason, /Blocked by user/);
});

test("safety asks do not offer approve-always persistence", async (t) => {
  const cwd = await makeTempProject(t);
  const { result, selectOptions } = await runBashTool("rm -rf /", {
    cwd,
    trusted: true,
    hasUI: true,
    select: () => undefined
  });

  assert.deepEqual(selectOptions, ["Yes, approve once", "No"]);
  assert.equal(result?.block, true);
  assert.match(result?.reason, /Blocked by user/);
});

test("approve-always persists to settings.local.json without clobbering existing settings", async (t) => {
  const cwd = await makeTempProject(t);
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify({
    permissions: {
      allow: ["Bash(git status:*)"],
      ask: ["Bash(docker:*)"]
    },
    env: { keep: true }
  }, null, 2)}\n`);

  const first = await runBashTool("git push origin main", {
    cwd,
    trusted: true,
    hasUI: true,
    select: (_prompt, options) => options.find((option) => option.includes("Bash(git push:*)"))
  });

  assert.equal(first.result, undefined);
  assert.ok(first.selectPrompt?.includes("git push origin main"));
  assert.deepEqual(first.selectOptions?.map((option) => option.startsWith("Yes") ? "yes" : option), ["yes", "yes", "No"]);

  const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(persisted.env, { keep: true });
  assert.deepEqual(persisted.permissions.ask, ["Bash(docker:*)"]);
  assert.deepEqual(persisted.permissions.allow, ["Bash(git status:*)", "Bash(git push:*)"]);

  let promptedAgain = false;
  const second = await runBashTool("git push origin main", {
    cwd,
    trusted: true,
    hasUI: true,
    select: () => {
      promptedAgain = true;
      return "No";
    }
  });

  assert.equal(second.result, undefined);
  assert.equal(promptedAgain, false);
  const afterSecondRun = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(afterSecondRun.permissions.allow, ["Bash(git status:*)", "Bash(git push:*)"]);
});
