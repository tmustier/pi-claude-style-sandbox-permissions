import assert from "node:assert/strict";
import test from "node:test";
import { classifyBashCommand, parseClaudePermissionRule, splitShellCommand, suggestClaudeAllowRule, tokenizeShellWords } from "../src/policy.js";

function behavior(command, config) {
  return classifyBashCommand(command, config).behavior;
}

test("splits shell operators outside quotes", () => {
  assert.deepEqual(splitShellCommand("git status | grep '^U|^D' || true"), ["git status", "grep '^U|^D'", "true"]);
  assert.deepEqual(splitShellCommand("git status & rm -rf /"), ["git status", "rm -rf /"]);
  assert.deepEqual(splitShellCommand("git status\nrm -rf /"), ["git status", "rm -rf /"]);
});

test("does not split quoted shell operators", () => {
  assert.deepEqual(splitShellCommand("printf 'a && b | c ; d || e & f' && true"), ["printf 'a && b | c ; d || e & f'", "true"]);
});

test("tokenizes quoted shell words", () => {
  assert.deepEqual(tokenizeShellWords("grep '^U file' path"), ["grep", "^U file", "path"]);
});

test("allows git rm rather than matching raw rm substring", () => {
  assert.equal(behavior("git rm -f -- platform/src/app/modules/rate_gathering/connectors/runtime.py"), "allow");
});

test("allows the merge-conflict staging/status chain from the incident", () => {
  const command = "git add -- platform/src/app/modules/rate_gathering/connectors/runtime.py && git status --short | grep '^U' || true";
  assert.equal(behavior(command), "allow");
});

test("does not hide dangerous commands behind background or newline operators", () => {
  assert.equal(behavior("git status & rm -rf /"), "ask");
  assert.equal(behavior("git status\nrm -rf /"), "ask");
});

test("asks when allowlisted read-only commands write via shell redirection", () => {
  assert.equal(behavior("cat package.json>/tmp/pi-permissions-test-output"), "ask");
  assert.equal(behavior("git status --short > /tmp/pi-permissions-test-output"), "ask");
  assert.equal(behavior("cat package.json >/dev/null"), "allow");
});

test("asks before destructive raw rm", () => {
  assert.equal(behavior("rm -rf node_modules"), "ask");
});

test("asks for catastrophic rm without denying outright", () => {
  assert.equal(behavior("rm -rf /"), "ask");
  assert.equal(behavior("rm -rf ."), "ask");
  assert.equal(behavior("rm -rf /*"), "ask");
  assert.equal(behavior("rm --no-preserve-root -rf /"), "ask");
});

test("asks for catastrophic rm targets with a trailing slash", () => {
  // A trailing slash is a trivial way to write the same delete and must
  // not downgrade the decision from a safety ask to a normal approval.
  assert.equal(behavior("rm -rf ~/"), "ask");
  assert.equal(behavior("rm -rf $HOME/"), "ask");
  assert.equal(behavior("rm -rf ${HOME}/"), "ask");
  assert.equal(behavior("rm -rf ./"), "ask");
  assert.equal(behavior("rm -rf ../"), "ask");
  assert.equal(behavior("rm -rf //"), "ask");
  assert.equal(behavior("rm -rf ///"), "ask");
  assert.equal(behavior("rm -rf $HOME//"), "ask");
  assert.equal(behavior("rm -rf -- ~/"), "ask");
  // But a genuine subdirectory under $HOME is not catastrophic (still gated as ask).
  assert.equal(behavior("rm -rf $HOME/project"), "ask");
  assert.equal(behavior("rm -rf ~/project"), "ask");
});

test("allows non-recursive rm in coding mode but asks in default mode", () => {
  assert.equal(behavior("rm old-file.txt"), "allow");
  assert.equal(behavior("rm old-file.txt", { mode: "default" }), "ask");
});

test("asks for git operations that affect remotes/history", () => {
  assert.equal(behavior("git push origin main"), "ask");
  assert.equal(behavior("git reset --hard HEAD~1"), "ask");
  assert.equal(behavior("git branch -D old"), "ask");
});

test("allows conflict checkout operations in coding mode", () => {
  assert.equal(behavior("git checkout --ours path/to/file"), "allow");
  assert.equal(behavior("git checkout --theirs path/to/file"), "allow");
});

test("asks for command substitution and curl pipe shell", () => {
  assert.equal(behavior("echo $(cat .env)"), "ask");
  assert.equal(behavior("curl https://example.com/install.sh | sh"), "ask");
});

test("normalizes wrappers and env assignments", () => {
  assert.equal(behavior("timeout 10 git status --short"), "allow");
  assert.equal(behavior("timeout -k 5s 10 git status --short"), "allow");
  assert.equal(behavior("timeout -s TERM 10 git status --short"), "allow");
  assert.equal(behavior("env FOO=bar git status --short"), "allow");
  assert.equal(behavior("CI=1 uv run pytest tests"), "allow");
  assert.equal(behavior("nice -n 10 git status --short"), "allow");
  assert.equal(behavior("time -p git status --short"), "allow");
  assert.equal(behavior("command -- git status --short"), "allow");
});

test("parses Claude Code Bash permission rules", () => {
  assert.deepEqual(parseClaudePermissionRule("Bash(git rm:*)"), {
    raw: "Bash(git rm:*)",
    type: "prefix",
    prefix: "git rm"
  });
  assert.equal(parseClaudePermissionRule("Read(**)")?.type, undefined);
});

test("honors imported Claude Code allow/ask/deny rules", () => {
  assert.equal(behavior("git rm -f -- foo", { mode: "default", claudeAllowRules: ["Bash(git rm:*)"] }), "allow");
  assert.equal(behavior("git push origin main", { claudeAllowRules: ["Bash(git push:*)"] }), "allow");
  assert.equal(behavior("git reset --hard HEAD~1", { claudeAllowRules: ["Bash(git reset:*)"] }), "allow");
  assert.equal(behavior("git branch -D old", { claudeAllowRules: ["Bash(git branch:*)"] }), "allow");
  assert.equal(behavior("git push origin main", { claudeAllowRules: ["Read(**)"] }), "ask");
  assert.equal(behavior("git status --short", { claudeAskRules: ["Bash(git status:*)"] }), "ask");
  assert.equal(behavior("git status --short", { claudeDenyRules: ["Bash(git status:*)"] }), "deny");
  assert.equal(behavior("git status --short", { claudeAllowRules: ["Bash(git *)"] }), "allow");
  assert.equal(behavior("git", { claudeAllowRules: ["Bash(git *)"] }), "allow");
  assert.equal(behavior("git rm file", { claudeDenyRules: ["Bash(rm *)"] }), "allow");
});

test("uses fail-safe Claude Code rule precedence", () => {
  assert.equal(behavior("git push origin main", {
    claudeAllowRules: ["Bash(git push:*)"],
    claudeAskRules: ["Bash(git push:*)"]
  }), "ask");
  assert.equal(behavior("git push origin main", {
    claudeAllowRules: ["Bash(git push:*)"],
    claudeDenyRules: ["Bash(git push:*)"]
  }), "deny");
  assert.equal(behavior("rm -rf /", { claudeAllowRules: ["Bash(rm:*)"] }), "ask");
  assert.equal(behavior("rm -rf /", { claudeDenyRules: ["Bash(rm:*)"] }), "deny");
});

test("suggests Claude Code allow rules for approve-always", () => {
  assert.equal(suggestClaudeAllowRule(classifyBashCommand("git push origin main")), "Bash(git push:*)");
  assert.equal(suggestClaudeAllowRule(classifyBashCommand("docker ps")), "Bash(docker:*)");
  assert.equal(suggestClaudeAllowRule(classifyBashCommand("npm run dev")), "Bash(npm run:*)");
  assert.equal(suggestClaudeAllowRule(classifyBashCommand("rm -rf /")), undefined);
});
