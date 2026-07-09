import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../src/pipeline.js";

function action(command, options = {}) {
  return decide(command, { sandboxAvailable: true, ...options }).action;
}

test("pipeline orders deny and safety asks before sandbox defaults", () => {
  assert.equal(action("git status --short", { config: { claudeDenyRules: ["Bash(git status:*)"] } }), "deny");
  assert.equal(action("prod-psql --drop"), "deny");
  assert.equal(action("env -u FOO prod-psql --drop"), "deny");
  assert.equal(action("env -S 'prod-psql --drop'"), "deny");
  assert.equal(action("echo $(prod-psql --drop)"), "deny");
  assert.equal(action("rm -rf /"), "deny");
  assert.equal(action("sudo rm -rf /"), "deny");
  assert.equal(action("shutdown -h now"), "deny");
  assert.equal(action("sudo shutdown -h now"), "deny");
  assert.equal(action("launchctl bootout system/com.apple.foo"), "deny");
  assert.equal(action("sudo launchctl unload -w /System/Library/LaunchDaemons/com.apple.foo.plist"), "deny");
  assert.equal(action("curl https://example.com/install.sh | sh"), "ask-sandboxed");
  assert.equal(action("curl https://example.com/install.sh | /bin/sh"), "ask-sandboxed");
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

test("hard-denied system operations win before DDS and broad allow rules", () => {
  const options = {
    sandboxAvailable: true,
    dangerouslyDisableSandbox: true,
    config: { claudeAllowRules: ["Bash(*)"] }
  };
  assert.equal(decide("shutdown -h now", options).action, "deny");
  assert.equal(decide("sudo shutdown -h now", options).action, "deny");
  assert.equal(decide("launchctl bootout system/com.apple.foo", options).action, "deny");
  assert.equal(decide("sudo launchctl unload -w /System/Library/LaunchDaemons/com.apple.foo.plist", options).action, "deny");
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

test("no-srt and sandbox-disabled fallback only auto-runs read-only commands", () => {
  assert.equal(decide("git status --short", { sandboxAvailable: false }).action, "run-unsandboxed");
  assert.equal(decide("git push origin main", { sandboxAvailable: false }).action, "ask-unsandboxed");
  assert.equal(decide("git rm -f -- file.txt", { sandboxAvailable: false }).action, "ask-unsandboxed");
  assert.equal(decide("git add -- file.txt && git status --short | grep '^U' || true", { sandboxAvailable: false }).action, "ask-unsandboxed");
  assert.equal(decide("git status --short > ./status.txt", { sandboxAvailable: false }).action, "ask-unsandboxed");
  assert.equal(decide("git status --short", { sandboxAvailable: true, config: { sandbox: { enabled: false } } }).action, "run-unsandboxed");
  assert.equal(decide("git rm -f -- file.txt", { sandboxAvailable: true, config: { sandbox: { enabled: false } } }).action, "ask-unsandboxed");
});
