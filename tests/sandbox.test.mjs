import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { deriveSandboxConfig } from "../src/sandbox.js";
import { decide } from "../src/pipeline.js";

const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, cwd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runSandboxed(command, cwd) {
  const wrapped = await SandboxManager.wrapWithSandbox(command);
  return run(wrapped, cwd);
}

function integrationUnavailableReason() {
  if (process.platform !== "darwin") return `requires darwin, got ${process.platform}`;
  if (!existsSync("/usr/bin/sandbox-exec")) return "/usr/bin/sandbox-exec missing";
  return undefined;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("deriveSandboxConfig expands defaults and overrides", () => {
  const cwd = resolve(tmpdir(), "derive-sandbox-config-project");
  const config = deriveSandboxConfig({ cwd }, {
    sandbox: {
      allowedDomains: ["github.com", "*.npmjs.org"],
      allowWrite: ["~/cache", "relative-out"],
      denyWrite: ["/blocked"],
      denyRead: ["~/secrets"]
    }
  });

  assert.deepEqual(config.network.allowedDomains, ["github.com", "*.npmjs.org"]);
  assert.equal(config.network.deniedDomains.length, 0);
  assert.ok(config.filesystem.allowWrite.includes(cwd));
  assert.ok(config.filesystem.allowWrite.includes("/tmp"));
  assert.ok(config.filesystem.allowWrite.includes(tmpdir()));
  assert.ok(config.filesystem.allowWrite.includes(resolve(homedir(), "cache")));
  assert.ok(config.filesystem.allowWrite.includes(resolve(cwd, "relative-out")));
  assert.ok(config.filesystem.denyWrite.includes("/blocked"));
  assert.ok(config.filesystem.denyRead.includes(resolve(homedir(), ".ssh")));
  assert.ok(config.filesystem.denyRead.includes(resolve(homedir(), "secrets")));
});

test("srt integration wraps commands, blocks writes, blocks network, and records violations", async (t) => {
  const skip = integrationUnavailableReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const allowed = await mkdtemp(join(tmpdir(), "pi-srt-allow-"));
  const blockedPath = join(EXTENSION_DIR, `.srt-blocked-${process.pid}-${Date.now()}`);
  t.after(async () => {
    await SandboxManager.reset();
    await rm(allowed, { recursive: true, force: true });
    await rm(blockedPath, { force: true });
  });

  const config = {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [allowed], denyWrite: [] }
  };

  try {
    await SandboxManager.initialize(config, undefined, true);
  } catch (error) {
    t.skip(`srt init failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const echo = await runSandboxed("echo hi", allowed);
  assert.equal(echo.code, 0);
  assert.equal(echo.stdout, "hi\n");

  const insideWrite = await runSandboxed(`echo ok > ${JSON.stringify(join(allowed, "ok.txt"))}`, allowed);
  assert.equal(insideWrite.code, 0);

  const blockedCommand = `echo no > ${JSON.stringify(blockedPath)}`;
  const blocked = await runSandboxed(blockedCommand, allowed);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /Operation not permitted|operation not permitted|Permission denied/i);
  await wait(1200);
  const violations = SandboxManager.getSandboxViolationStore().getViolationsForCommand(blockedCommand);
  assert.ok(violations.length > 0, "expected correlated sandbox violation");
  assert.match(violations.map((violation) => violation.line).join("\n"), /file-write/);

  const curlCheck = await run("command -v curl", allowed);
  if (curlCheck.code === 0) {
    const network = await runSandboxed("curl https://example.com --max-time 5", allowed);
    assert.notEqual(network.code, 0);
  }
});

test("incident git commands decide and execute sandboxed with exit 0", async (t) => {
  const skip = integrationUnavailableReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const repo = await mkdtemp(join(tmpdir(), "pi-srt-incident-"));
  t.after(async () => {
    await SandboxManager.reset();
    await rm(repo, { recursive: true, force: true });
  });

  await run("git init", repo);
  await run("git config user.email test@example.com", repo);
  await run("git config user.name Test", repo);
  await writeFile(join(repo, "incident.txt"), "one\n");
  await run("git add incident.txt && git commit -m init", repo);

  const config = {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [repo], denyWrite: [] }
  };
  try {
    await SandboxManager.initialize(config, undefined, true);
  } catch (error) {
    t.skip(`srt init failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const rmCommand = "git rm -f -- incident.txt";
  assert.equal(decide(rmCommand, { sandboxAvailable: true }).action, "run-sandboxed");
  const rmResult = await runSandboxed(rmCommand, repo);
  assert.equal(rmResult.code, 0, rmResult.stderr);

  const addCommand = "git add -- incident.txt && git status --short | grep '^U' || true";
  assert.equal(decide(addCommand, { sandboxAvailable: true }).action, "run-sandboxed");
  const addResult = await runSandboxed(addCommand, repo);
  assert.equal(addResult.code, 0, addResult.stderr);
});
