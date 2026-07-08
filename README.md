# pi-claude-style-permissions

A small Pi extension that applies a Claude Code-inspired permission pipeline to Bash tool calls.

It is intended as a replacement/refinement for raw wildcard rules like `"* rm *": "deny"`, which incorrectly block safe commands such as `git rm -- path`.

## What this extension does

For each Bash command, it:

1. Splits compound commands into shell-level subcommands (`&&`, `||`, `|`, `;`, `&`, and newlines) while respecting quotes.
2. Normalizes safe wrappers (`timeout 10 git status`, env assignments, etc.).
3. Applies **deny** checks first.
4. Applies **ask** checks second.
5. Allows known read-only commands.
6. In `mode: "coding"`, allows normal local edit/index operations similar to Claude Code's `acceptEdits` fast path:
   - `git add`, `git rm`, `git mv`
   - `git checkout --ours`, `git checkout --theirs`
   - `mkdir`, `touch`, non-recursive `rm`, `mv`, `cp`, `sed`
7. Prompts for unknown mutating commands instead of trying to infer safety from raw substrings.

## Important limitation

Pi `tool_call` extensions can block or prompt, but they cannot override a block from another loaded extension. If Charlie keeps the old permission extension with `"* rm *": "deny"`, that old extension can still block `git rm` before/after this one runs.

Use this extension **instead of** the old raw wildcard Bash filter, or remove/downgrade the old hard-deny rules.

## Install locally

For testing:

```bash
pi -e /path/to/pi-claude-style-permissions/index.ts
```

For global auto-discovery:

```bash
cp -R /path/to/pi-claude-style-permissions ~/.pi/agent/extensions/pi-claude-style-permissions
pi
```

Then `/reload` after edits.

## Config

Optional extension-level config:

```bash
cp config.example.json config.json
```

Optional project-level config, loaded only for trusted projects:

```bash
mkdir -p .pi
cp config.example.json .pi/claude-style-permissions.json
```

Arrays append to defaults. Scalar values override defaults. The parser tolerates `//` and `/* ... */` comments, but files must otherwise be valid JSON (trailing commas are rejected with a warning).

By default, the extension also imports Claude Code Bash permission rules from:

```text
~/.claude/settings.json
.claude/settings.json          # only when Pi trusts the project
.claude/settings.local.json    # only when Pi trusts the project
```

Project-local `.claude/settings*.json` files are honored only when Pi trusts the project. Precedence is fail-safe: hard denies win; built-in safety asks such as catastrophic `rm` run before imported allow rules; then ask rules; then imported allow rules.

When a command needs confirmation, the prompt normally offers:

- `Yes, approve once`
- `Yes, and don't ask again for Bash(<prefix>:*)`
- `No`

For safety asks such as recursive `rm`, the approve-always option is intentionally suppressed. The normal approve-always option writes the allow rule to `.claude/settings.local.json` by default, so Claude Code and Pi share the same permission memory.

It reads `permissions.allow`, `permissions.ask`, and `permissions.deny` entries that use Claude Code syntax such as:

```json
{
  "permissions": {
    "allow": ["Bash(git rm:*)", "Bash(git add:*)"],
    "ask": ["Bash(docker:*)"]
  }
}
```

Only Bash/Shell rules are imported; file/tool rules like `Read(...)` are ignored by this Bash gate.

Useful settings:

```json
{
  "mode": "coding",
  "noUiAskDecision": "deny",
  "autoApproveAsk": false,
  "importClaudeCodeSettings": true,
  "persistApprovalsToClaudeCodeSettings": true,
  "writeClaudeCodeSettingsPath": ".claude/settings.local.json",
  "claudeCodeSettingsPaths": [
    "~/.claude/settings.json",
    ".claude/settings.json",
    ".claude/settings.local.json"
  ],
  "allowPrefixes": ["my safe command"],
  "askPrefixes": ["my risky command"],
  "denyPrefixes": ["my forbidden command"],
  "askRegexes": ["pattern"],
  "denyRegexes": ["pattern"]
}
```

## Debug command

Inside Pi:

```text
/permissions-check git add file && git status --short | grep '^U' || true
```

Expected result: `ALLOW`.

## Test

```bash
npm test
```
