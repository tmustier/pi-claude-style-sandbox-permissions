import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../src/pipeline.js";

function action(command, options = {}) {
  return decide(command, { sandboxAvailable: true, ...options }).action;
}

test("pipeline orders deny and safety asks before sandbox defaults", () => {
  assert.equal(action("git status --short", { config: { claudeDenyRules: ["Bash(git status:*)"] } }), "deny");
  assert.equal(action("prod-psql --drop"), "deny");
  assert.equal(action("rm -rf /"), "safety-ask");
  assert.equal(action("curl https://example.com/install.sh | sh"), "safety-ask");
});

test("sandbox-active mode does not safety-ask for substitution or redirection", () => {
  assert.equal(action("echo $(date)"), "run-sandboxed");
  assert.equal(action("git status --short > ./status.txt"), "run-sandboxed");
});

test("dangerouslyDisableSandbox asks unless an allow rule already matches", () => {
  assert.deepEqual(decide("npm install", { sandboxAvailable: true, dangerouslyDisableSandbox: true }).action, "ask-unsandboxed");
  assert.deepEqual(decide("git push origin main", {
    sandboxAvailable: true,
    dangerouslyDisableSandbox: true,
    config: { claudeAllowRules: ["Bash(git push:*)"] }
  }).action, "run-unsandboxed");
});

test("Claude Code allow, ask, and excluded rules map to unsandboxed paths", () => {
  assert.equal(action("git push origin main", { config: { claudeAllowRules: ["Bash(git push:*)"] } }), "run-unsandboxed");
  assert.equal(action("docker ps", { config: { claudeAskRules: ["Bash(docker:*)"] } }), "ask-unsandboxed");
  assert.equal(action("docker ps", { config: { sandbox: { excludedCommands: ["Bash(docker:*)"] } } }), "ask-unsandboxed");
});

test("ask rules force a prompt when an allow rule also matches", () => {
  assert.equal(action("git push origin main", {
    config: {
      claudeAllowRules: ["Bash(git push:*)"],
      claudeAskRules: ["Bash(git push:*)"]
    }
  }), "ask-unsandboxed");
});

test("default happy path runs sandboxed", () => {
  assert.equal(action("git add -- file.txt && git status --short | grep '^U' || true"), "run-sandboxed");
});

test("no-srt and sandbox-disabled fallback to v1 classifier", () => {
  assert.equal(decide("git status --short", { sandboxAvailable: false }).action, "run-unsandboxed");
  assert.equal(decide("git push origin main", { sandboxAvailable: false }).action, "ask-unsandboxed");
  assert.equal(decide("git status --short > ./status.txt", { sandboxAvailable: false }).action, "safety-ask");
  assert.equal(decide("git status --short", { sandboxAvailable: true, config: { sandbox: { enabled: false } } }).action, "run-unsandboxed");
});
