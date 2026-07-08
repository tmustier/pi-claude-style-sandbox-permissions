# pi-claude-style-sandbox-permissions

Claude Code-style Bash permissions for Pi, implemented as an **enforce-first srt sandbox extension**.

v2 runs ordinary Bash commands inside `@anthropic-ai/sandbox-runtime` (`srt`) instead of trying to prove commands safe with string matching. Static classification is still used for hard denies, catastrophic safety prompts, and no-sandbox fallback.

## Architecture

For each `bash` tool call the extension overrides Pi's built-in Bash tool and applies this pipeline:

1. Explicit deny rules (`claudeDenyRules`, `denyPrefixes`, `denyRegexes`) block.
2. Safety asks (catastrophic `rm`, `--no-preserve-root`, `curl | sh`, substitution/redirection when no sandbox is active) prompt and never offer approve-always.
3. `dangerouslyDisableSandbox: true` requests an unsandboxed retry and prompts unless an allow rule already matches.
4. Claude Code allow rules (`Bash(git push:*)`) run unsandboxed with no prompt.
5. `sandbox.excludedCommands` skip the sandbox and prompt.
6. Everything else runs in the OS sandbox with no prompt.
7. If the sandbox is disabled or unavailable, the v1 classify-first behavior is used.

On macOS, enforcement uses Apple's Seatbelt via `/usr/bin/sandbox-exec` through `srt`. Other platforms fall back to classify-only unless `srt` supports them and initializes successfully.

## Sandbox defaults

Sandboxed commands can write to:

- the current Pi workspace (`ctx.cwd`)
- `/tmp`
- Node's `os.tmpdir()`
- any configured `sandbox.allowWrite` paths

Network is blocked by default (`sandbox.allowedDomains: []`). Read access is broad except a short sensitive default deny list: `~/.ssh`, `~/.aws`, `~/.gnupg` plus `sandbox.denyRead`.

When the OS blocks a command, the result is annotated with recorded sandbox violations when available, e.g. `[sandbox] 1 violation(s): ...`.

## Escalation protocol for the model

The Bash schema includes `dangerouslyDisableSandbox?: boolean`.

The system prompt tells the model:

- default to sandboxed Bash;
- do **not** set `dangerouslyDisableSandbox` preemptively;
- if a command fails with sandbox evidence (`Operation not permitted`, denied writes outside the workspace, blocked proxy/network, Unix socket denial), retry once with `dangerouslyDisableSandbox: true`;
- that retry prompts the user for approve-once / approve-always / No.

Approve-always persists the suggested `Bash(<prefix>:*)` rule to `.claude/settings.local.json` using the same writer as v1.

## Config

Copy `config.example.json` to `config.json` next to the extension, or to `.pi/claude-style-permissions.json` in a trusted project.

```jsonc
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
  "claudeAllowRules": ["Bash(git push:*)"],
  "claudeAskRules": [],
  "claudeDenyRules": [],
  "sandbox": {
    "enabled": true,
    "allowedDomains": [],
    "allowWrite": [],
    "denyWrite": [],
    "denyRead": [],
    "excludedCommands": [],
    "annotateViolations": true
  }
}
```

Arrays append to defaults. Project config and project-local Claude settings are loaded only when Pi trusts the project. User Claude settings are read from `CLAUDE_CONFIG_DIR/settings.json` when set, otherwise `~/.claude/settings.json`.

Examples:

- allow npm metadata/network inside sandbox: `"allowedDomains": ["registry.npmjs.org", "*.npmjs.org"]`
- allow a cache directory to be written in sandbox: `"allowWrite": ["~/.cache/my-tool"]`
- force Docker to prompt unsandboxed: `"excludedCommands": ["Bash(docker:*)"]`

## Commands and status

- `/permissions-check <cmd>` shows both the v1 classification and the v2 pipeline action (`run-sandboxed`, `ask-unsandboxed`, etc.).
- Status line:
  - `perms: srt-sandboxed`
  - `perms: classify-only (srt unavailable)`
  - `perms: classify-only (sandbox disabled)`
- User `!` / `!!` shell commands run unsandboxed because the human typed them.

## Threat model / non-goals

This extension protects against accidental or model-initiated Bash effects outside the configured sandbox boundary. It does **not** protect against:

- destructive changes inside the workspace or `/tmp`;
- commands you explicitly approve unsandboxed;
- secrets already present in environment variables visible to Pi/Bash;
- malicious project code that is allowed to run and damage allowed write paths;
- other Pi extensions that override or block tools separately.

Keep backups/git history for workspace damage. Treat approve-always rules as trust decisions.

## Test

```bash
npm test
node --check index.ts src/*.js
npm pack --dry-run
```
