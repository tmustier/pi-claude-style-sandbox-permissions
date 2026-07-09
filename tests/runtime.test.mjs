import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension, {
  __resetPiSdkForTests,
  __resetRuntimeStateForTests,
  __setPiSdkForTests,
  normalizeSandboxToggleShortcuts
} from "../index.ts";
import { __resetSandboxStateForTests, __setSandboxManagerForTests } from "../src/sandbox.js";

function makeFakeSdk(executions) {
  return {
    createLocalBashOperations() {
      return {
        async exec(command, cwd, options = {}) {
          executions.push({ kind: "exec", command, cwd });
          options.onData?.(Buffer.from(`ran:${command}\n`));
          const sandboxedBlocked = command.startsWith("SANDBOXED(") && command.includes("blocked-write");
          return { exitCode: sandboxedBlocked ? 1 : 0 };
        }
      };
    },
    createBashTool(cwd, toolOptions = {}) {
      return {
        name: "bash",
        label: "bash",
        description: "fake bash",
        promptSnippet: "fake bash",
        parameters: {
          type: "object",
          properties: { command: { type: "string" }, timeout: { type: "number" } },
          required: ["command"]
        },
        async execute(_id, params, signal, onUpdate) {
          const operations = toolOptions.operations ?? this.__localOperations ?? {
            async exec(command) {
              executions.push({ kind: "direct", command, cwd });
              return { exitCode: 0 };
            }
          };
          let output = "";
          const result = await operations.exec(params.command, cwd, {
            signal,
            timeout: params.timeout,
            onData(data) {
              output += data.toString();
              onUpdate?.({ content: [{ type: "text", text: output }], details: undefined });
            }
          });
          if (result.exitCode !== 0 && result.exitCode !== null) {
            throw new Error(`${output || "(no output)"}\n\nCommand exited with code ${result.exitCode}`);
          }
          return { content: [{ type: "text", text: output || `(no output) ${params.command}` }], details: {} };
        }
      };
    }
  };
}

function makeFakeSandboxManager({ failInitialize = false, violations = [] } = {}) {
  const store = {
    subscribe(listener) {
      listener(violations);
      return () => {};
    },
    getViolationsForCommand(command) {
      return violations.filter((violation) => violation.command === command);
    },
    getViolations() {
      return violations;
    }
  };
  return {
    initialized: false,
    wrapped: [],
    async initialize() {
      if (failInitialize) throw new Error("boom unavailable");
      this.initialized = true;
    },
    async wrapWithSandbox(command) {
      this.wrapped.push(command);
      return `SANDBOXED(${command})`;
    },
    getSandboxViolationStore() {
      return store;
    },
    cleanupAfterCommand() {},
    async reset() {
      this.initialized = false;
    }
  };
}

async function installExtension(t, { sandboxManager } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const tools = new Map();
  const executions = [];
  __setPiSdkForTests(makeFakeSdk(executions));
  __setSandboxManagerForTests(sandboxManager ?? makeFakeSandboxManager());
  t.after(() => {
    __resetPiSdkForTests();
    __resetSandboxStateForTests();
  });
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerShortcut(key, options) {
      shortcuts.set(key, options);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    }
  };
  await extension(pi);
  return { handlers, commands, shortcuts, tools, executions };
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

async function makeContext({ cwd, trusted = true, hasUI = false, select } = {}) {
  const notifications = [];
  const statuses = [];
  let selectPrompt;
  let selectOptions;
  return {
    ctx: {
      cwd,
      hasUI,
      isProjectTrusted: () => trusted,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
        setStatus(key, value) {
          statuses.push({ key, value });
        },
        async select(prompt, options) {
          selectPrompt = prompt;
          selectOptions = options;
          return select ? select(prompt, options) : undefined;
        }
      }
    },
    notifications,
    statuses,
    get selectPrompt() { return selectPrompt; },
    get selectOptions() { return selectOptions; }
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function installMockFetch(t, handler) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  return calls;
}

function setEnvForTest(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

async function runBashTool(t, command, options = {}, params = {}) {
  const installed = await installExtension(t, { sandboxManager: options.sandboxManager });
  const context = await makeContext(options);
  const tool = installed.tools.get("bash");
  let result;
  let error;
  try {
    result = await tool.execute("tool-1", { command, ...params }, undefined, undefined, context.ctx);
  } catch (err) {
    error = err;
  }
  return { ...installed, ...context, tool, result, error };
}

test("registers bash override, command, shortcut, lifecycle hooks, and extended schema", async (t) => {
  const cwd = await makeTempProject(t);
  const { handlers, commands, shortcuts, tools } = await installExtension(t);
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");
  assert.equal(typeof handlers.get("before_agent_start"), "function");
  assert.equal(typeof handlers.get("user_bash"), "function");
  assert.equal(typeof commands.get("permissions-check")?.handler, "function");
  assert.equal(typeof shortcuts.get("ctrl+shift+p")?.handler, "function");
  const bash = tools.get("bash");
  assert.equal(bash.parameters.properties.dangerouslyDisableSandbox.type, "boolean");

  const context = await makeContext({ cwd });
  await handlers.get("session_start")({}, context.ctx);
  assert.equal(context.statuses.at(-1).value, "perms: srt-sandboxed");
});

test("normalizes configurable sandbox toggle shortcuts", () => {
  assert.deepEqual(normalizeSandboxToggleShortcuts(), ["ctrl+shift+p"]);
  assert.deepEqual(normalizeSandboxToggleShortcuts(" Ctrl+Alt+P "), ["ctrl+alt+p"]);
  assert.deepEqual(normalizeSandboxToggleShortcuts(["ctrl+shift+p", " alt+p ", "none", ""]), ["ctrl+shift+p", "alt+p"]);
  assert.deepEqual(normalizeSandboxToggleShortcuts(null), []);
  assert.deepEqual(normalizeSandboxToggleShortcuts(false), []);
  assert.deepEqual(normalizeSandboxToggleShortcuts("disabled"), []);
});

test("sandbox toggle shortcut switches the current session between sandboxed and classify-only", async (t) => {
  const cwd = await makeTempProject(t);
  const { shortcuts, tools, executions } = await installExtension(t);
  const context = await makeContext({ cwd, hasUI: false });
  const shortcut = shortcuts.get("ctrl+shift+p");
  const tool = tools.get("bash");

  await shortcut.handler(context.ctx);
  assert.equal(context.statuses.at(-1).value, "perms: classify-only (shortcut override)");
  assert.equal(context.notifications.at(-1).level, "warning");

  await tool.execute("tool-1", { command: "git status --short" }, undefined, undefined, context.ctx);
  assert.equal(executions.at(-1).command, "git status --short");

  await shortcut.handler(context.ctx);
  assert.equal(context.statuses.at(-1).value, "perms: srt-sandboxed");
  assert.equal(context.notifications.at(-1).level, "info");

  await tool.execute("tool-2", { command: "git status --short" }, undefined, undefined, context.ctx);
  assert.equal(executions.at(-1).command, "SANDBOXED(git status --short)");

  __resetRuntimeStateForTests();
});

test("imports user Claude Code settings independently of project trust", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(git push:*)"] }
  }));

  const { error, executions } = await runBashTool(t, "git push origin main", { cwd, trusted: false, hasUI: false });
  assert.equal(error, undefined);
  assert.equal(executions.at(-1).command, "git push origin main");
});

test("honors trusted project Claude settings and ignores untrusted project settings for unsandboxed retry", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(git push:*)"] }
  }));

  const trusted = await runBashTool(t, "git push origin main", { cwd, trusted: true, hasUI: false }, { dangerouslyDisableSandbox: true });
  assert.equal(trusted.error, undefined);

  const untrusted = await runBashTool(t, "git push origin main", { cwd, trusted: false, hasUI: false }, { dangerouslyDisableSandbox: true });
  assert.match(untrusted.error?.message, /Permission required but no UI/);
});

test("rejects trailing-comma Claude Code settings with a warning", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), `{
    "permissions": {
      "allow": ["Bash(git push:*)",]
    }
  }\n`);

  const { error, notifications } = await runBashTool(t, "git push origin main", { cwd, trusted: true, hasUI: false }, { dangerouslyDisableSandbox: true });
  assert.match(error?.message, /Permission required but no UI/);
  assert.equal(notifications.some((entry) => entry.level === "warning" && entry.message.includes("failed to parse Claude Code settings")), true);
});

test("cancelled unsandboxed prompt blocks safely", async (t) => {
  const cwd = await makeTempProject(t);
  const { error, selectOptions } = await runBashTool(t, "git push origin main", {
    cwd,
    trusted: true,
    hasUI: true,
    select: () => undefined
  }, { dangerouslyDisableSandbox: true });

  assert.deepEqual(selectOptions?.map((option) => option.startsWith("Yes") ? "yes" : option), ["yes", "yes", "No"]);
  assert.match(error?.message, /Blocked by user/);
});

test("safety asks do not offer approve-always persistence", async (t) => {
  const cwd = await makeTempProject(t);
  const { error, selectOptions, selectPrompt } = await runBashTool(t, "rm -rf node_modules", {
    cwd,
    trusted: true,
    hasUI: true,
    select: () => undefined
  });

  assert.deepEqual(selectOptions, ["Yes, approve once", "No"]);
  assert.match(selectPrompt, /Proceed sandboxed\?/);
  assert.match(error?.message, /Blocked by user/);
});

test("hard-denied root/system destructive commands never prompt or execute", async (t) => {
  const cwd = await makeTempProject(t);
  let prompted = false;
  const run = await runBashTool(t, "sudo bash -c 'echo ok; rm -rf /'", {
    cwd,
    trusted: true,
    hasUI: true,
    select: () => {
      prompted = true;
      return "Yes, approve once";
    }
  });

  assert.match(run.error?.message, /Denied by claude-style-permissions/);
  assert.equal(prompted, false);
  assert.equal(run.executions.length, 0);
});

test("approved destructive workspace safety prompt still runs inside sandbox", async (t) => {
  const cwd = await makeTempProject(t);
  const run = await runBashTool(t, "rm -rf node_modules", {
    cwd,
    trusted: true,
    hasUI: true,
    select: (_prompt, options) => options[0]
  });

  assert.equal(run.error, undefined);
  assert.deepEqual(run.selectOptions, ["Yes, approve once", "No"]);
  assert.equal(run.executions.at(-1).command, "SANDBOXED(rm -rf node_modules)");
});

test("dangerouslyDisableSandbox needs real UI approval even when legacy auto-approve config is set", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "claude-style-permissions.json"), JSON.stringify({
    autoApproveAsk: true,
    noUiAskDecision: "allow"
  }));

  const run = await runBashTool(t, "npm install", {
    cwd,
    trusted: true,
    hasUI: false
  }, { dangerouslyDisableSandbox: true });

  assert.match(run.error?.message, /Permission required but no UI/);
  assert.equal(run.executions.length, 0);
});

test("sandbox-unavailable and sandbox-disabled do not silently run local mutations", async (t) => {
  const unavailableCwd = await makeTempProject(t);
  const sandboxManager = makeFakeSandboxManager({ failInitialize: true });
  const unavailable = await runBashTool(t, "git rm -f -- file.txt", {
    cwd: unavailableCwd,
    trusted: true,
    hasUI: false,
    sandboxManager
  });
  assert.match(unavailable.error?.message, /Permission required but no UI/);
  assert.equal(unavailable.executions.length, 0);

  const disabledCwd = await makeTempProject(t);
  await mkdir(join(disabledCwd, ".pi"), { recursive: true });
  await writeFile(join(disabledCwd, ".pi", "claude-style-permissions.json"), JSON.stringify({
    sandbox: { enabled: false }
  }));
  const disabled = await runBashTool(t, "git rm -f -- file.txt", {
    cwd: disabledCwd,
    trusted: true,
    hasUI: false
  });
  assert.match(disabled.error?.message, /Permission required but no UI/);
  assert.equal(disabled.executions.length, 0);
});

test("explicit UI approval can run sandbox-unavailable fallback unsandboxed", async (t) => {
  const cwd = await makeTempProject(t);
  const sandboxManager = makeFakeSandboxManager({ failInitialize: true });
  const run = await runBashTool(t, "git rm -f -- file.txt", {
    cwd,
    trusted: true,
    hasUI: true,
    sandboxManager,
    select: (_prompt, options) => options[0]
  });

  assert.equal(run.error, undefined);
  assert.equal(run.executions.at(-1).command, "git rm -f -- file.txt");
});

test("omnigent-managed backend executes sandboxed Bash through the remote shell endpoint", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "claude-style-permissions.json"), JSON.stringify({
    sandbox: {
      backend: "omnigent-managed",
      omnigent: {
        serverUrl: "https://omni.example",
        sessionId: "conv_123",
        environmentId: "default",
        bearerTokenEnv: "OMNI_TEST_TOKEN"
      }
    }
  }));
  setEnvForTest(t, "OMNI_TEST_TOKEN", "secret-token");

  const calls = installMockFetch(t, (url, init) => {
    if (url === "https://omni.example/v1/sessions/conv_123?include_items=false&include_liveness=true") {
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, "Bearer secret-token");
      return jsonResponse({ id: "conv_123", runner_online: true, sandbox_status: null });
    }
    if (url === "https://omni.example/v1/sessions/conv_123/resources/environments/default/shell") {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer secret-token");
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(init.body), { command: "git status --short" });
      return jsonResponse({
        object: "session.environment.shell_result",
        stdout: "remote ok\n",
        stderr: "",
        exit_code: 0,
        timed_out: false,
        cwd: "/workspace"
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const run = await runBashTool(t, "git status --short", { cwd, trusted: true, hasUI: false });
  assert.equal(run.error, undefined);
  assert.equal(run.result.content[0].text, "remote ok\n");
  assert.equal(run.executions.length, 0);
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "POST"]);
  assert.equal(run.statuses.at(-1).value, "perms: omnigent-managed");
});

test("omnigent-managed backend missing setup fails closed without local fallback", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "claude-style-permissions.json"), JSON.stringify({
    sandbox: { backend: "omnigent-managed" }
  }));
  const calls = installMockFetch(t, () => {
    throw new Error("fetch should not be called for missing config");
  });

  const run = await runBashTool(t, "git status --short", { cwd, trusted: true, hasUI: false });
  assert.match(run.error?.message, /Sandbox backend unavailable; command was not run: Omnigent managed backend is not configured/);
  assert.equal(run.executions.length, 0);
  assert.equal(calls.length, 0);
});

test("omnigent-managed backend unavailable fails closed even for read-only commands", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "claude-style-permissions.json"), JSON.stringify({
    sandbox: {
      backend: "omnigent-managed",
      omnigent: {
        serverUrl: "https://omni.example",
        sessionId: "conv_down"
      }
    }
  }));
  const calls = installMockFetch(t, (url, init) => {
    assert.equal(url, "https://omni.example/v1/sessions/conv_down?include_items=false&include_liveness=true");
    assert.equal(init.method, "GET");
    return jsonResponse({ error: { message: "runner unavailable" } }, 503);
  });

  const run = await runBashTool(t, "git status --short", { cwd, trusted: true, hasUI: false });
  assert.match(run.error?.message, /Sandbox backend unavailable; command was not run: Omnigent managed backend check failed: HTTP 503: runner unavailable/);
  assert.equal(run.executions.length, 0);
  assert.equal(calls.length, 1);
});

test("hard-denied commands do not initialize the omnigent-managed backend", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "claude-style-permissions.json"), JSON.stringify({
    claudeAllowRules: ["Bash(*)"],
    sandbox: {
      backend: "omnigent-managed",
      omnigent: {
        serverUrl: "https://omni.example",
        sessionId: "conv_123"
      }
    }
  }));
  const calls = installMockFetch(t, () => {
    throw new Error("hard deny should not touch the backend");
  });

  for (const command of [
    "sudo bash -c 'rm -rf /'",
    "shutdown -h now",
    "sudo shutdown -h now",
    "launchctl bootout system/com.apple.foo",
    "sudo launchctl unload -w /System/Library/LaunchDaemons/com.apple.foo.plist"
  ]) {
    const run = await runBashTool(t, command, { cwd, trusted: true, hasUI: false }, { dangerouslyDisableSandbox: true });
    assert.match(run.error?.message, /Denied by claude-style-permissions/, command);
    assert.equal(run.executions.length, 0, command);
  }
  assert.equal(calls.length, 0);
});

test("project settings.local Bash(git push:*) allow runs unsandboxed without prompting", async (t) => {
  const cwd = await makeTempProject(t);
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.local.json"), JSON.stringify({
    permissions: { allow: ["Bash(git push:*)"] }
  }));

  let prompted = false;
  const run = await runBashTool(t, "git push origin main", {
    cwd,
    trusted: true,
    hasUI: true,
    select: () => {
      prompted = true;
      return "No";
    }
  });

  assert.equal(run.error, undefined);
  assert.equal(prompted, false);
  assert.equal(run.executions.at(-1).command, "git push origin main");
});

test("approve-always persists to settings.local.json then suppresses future prompts", async (t) => {
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

  const first = await runBashTool(t, "git push origin main", {
    cwd,
    trusted: true,
    hasUI: true,
    select: (_prompt, options) => options.find((option) => option.includes("Bash(git push:*)"))
  }, { dangerouslyDisableSandbox: true });

  assert.equal(first.error, undefined);
  assert.ok(first.selectPrompt?.includes("git push origin main"));
  assert.deepEqual(first.selectOptions?.map((option) => option.startsWith("Yes") ? "yes" : option), ["yes", "yes", "No"]);

  const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(persisted.env, { keep: true });
  assert.deepEqual(persisted.permissions.ask, ["Bash(docker:*)"]);
  assert.deepEqual(persisted.permissions.allow, ["Bash(git status:*)", "Bash(git push:*)"]);

  let promptedAgain = false;
  const second = await runBashTool(t, "git push origin main", {
    cwd,
    trusted: true,
    hasUI: true,
    select: () => {
      promptedAgain = true;
      return "No";
    }
  });

  assert.equal(second.error, undefined);
  assert.equal(promptedAgain, false);
});

test("srt init failure falls back to classify-only with visible warning/status", async (t) => {
  const cwd = await makeTempProject(t);
  const sandboxManager = makeFakeSandboxManager({ failInitialize: true });
  const { error, notifications, statuses } = await runBashTool(t, "git push origin main", { cwd, hasUI: false, sandboxManager });
  assert.match(error?.message, /Permission required but no UI/);
  assert.equal(notifications.some((entry) => entry.level === "warning" && entry.message.includes("srt sandbox unavailable")), true);
  assert.equal(statuses.at(-1).value, "perms: classify-only (srt unavailable)");

  const allowed = await runBashTool(t, "git status --short", { cwd, hasUI: false, sandboxManager: makeFakeSandboxManager({ failInitialize: true }) });
  assert.equal(allowed.error, undefined);
});

test("blocked sandbox write annotates output and unsandboxed retry prompts", async (t) => {
  const cwd = await makeTempProject(t);
  const command = "python -c 'blocked-write'";
  const sandboxManager = makeFakeSandboxManager({
    violations: [{ line: "bash deny(1) file-write-create /outside", command, encodedCommand: "fake", timestamp: new Date() }]
  });

  const blocked = await runBashTool(t, command, { cwd, hasUI: false, sandboxManager });
  assert.match(blocked.error?.message, /\[sandbox\] 1 violation\(s\):/);
  assert.match(blocked.error?.message, /file-write-create \/outside/);

  const retry = await runBashTool(t, command, {
    cwd,
    hasUI: true,
    sandboxManager: makeFakeSandboxManager(),
    select: (_prompt, options) => options[0]
  }, { dangerouslyDisableSandbox: true });
  assert.equal(retry.error, undefined);
  assert.deepEqual(retry.selectOptions?.map((option) => option.startsWith("Yes") ? "yes" : option), ["yes", "yes", "No"]);
});

test("incident commands run sandboxed with zero prompts", async (t) => {
  const cwd = await makeTempProject(t);
  let prompted = false;
  const first = await runBashTool(t, "git rm -f -- file.txt", {
    cwd,
    hasUI: true,
    select: () => {
      prompted = true;
      return "No";
    }
  });
  assert.equal(first.error, undefined);
  assert.equal(prompted, false);
  assert.equal(first.executions.at(-1).command, "SANDBOXED(git rm -f -- file.txt)");

  const second = await runBashTool(t, "git add -- file.txt && git status --short | grep '^U' || true", {
    cwd,
    hasUI: true,
    select: () => {
      prompted = true;
      return "No";
    }
  });
  assert.equal(second.error, undefined);
  assert.equal(prompted, false);
  assert.equal(second.executions.at(-1).command, "SANDBOXED(git add -- file.txt && git status --short | grep '^U' || true)");
});

test("user_bash remains unsandboxed", async (t) => {
  const { handlers, executions } = await installExtension(t);
  const response = handlers.get("user_bash")({ command: "echo hi", cwd: "/tmp" }, {});
  assert.equal(typeof response.operations.exec, "function");
  await response.operations.exec("echo hi", "/tmp", {});
  assert.equal(executions.at(-1).command, "echo hi");
});

test("before_agent_start appends sandbox escalation instructions", async (t) => {
  const cwd = await makeTempProject(t);
  const { handlers } = await installExtension(t);
  const context = await makeContext({ cwd });
  const result = await handlers.get("before_agent_start")({ systemPrompt: "base" }, context.ctx);
  assert.match(result.systemPrompt, /Bash OS sandbox/);
  assert.match(result.systemPrompt, /dangerouslyDisableSandbox/);
});
