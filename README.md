# pi-claude-style-sandbox-permissions

Claude Code-style Bash permissions for Pi, implemented as an **enforce-first srt sandbox extension**.

v2 runs ordinary Bash commands inside `@anthropic-ai/sandbox-runtime` (`srt`) instead of trying to prove commands safe with string matching. Static classification is still used for hard denies, catastrophic safety prompts, and no-sandbox fallback.

## Install

> Security note: Pi extensions run with your full system permissions. Review the source before installing any third-party extension.

### Recommended: install from GitHub

```bash
pi install git:github.com/tmustier/pi-claude-style-sandbox-permissions
```

Then restart Pi, or run `/reload` in an existing Pi session.

Pi will clone the package under `~/.pi/agent/git/...`, install runtime dependencies, and load the extension declared in `package.json`.

### Try temporarily without installing

```bash
pi -e git:github.com/tmustier/pi-claude-style-sandbox-permissions
```

This loads the package for that Pi run only.

### Install from a local checkout

```bash
git clone https://github.com/tmustier/pi-claude-style-sandbox-permissions.git
cd pi-claude-style-sandbox-permissions
npm install
pi install "$PWD"
```

Then restart Pi or run `/reload`.

### Manual auto-discovery install

If you prefer Pi's extension auto-discovery directories:

```bash
git clone https://github.com/tmustier/pi-claude-style-sandbox-permissions.git \
  ~/.pi/agent/extensions/pi-claude-style-sandbox-permissions
cd ~/.pi/agent/extensions/pi-claude-style-sandbox-permissions
npm install
```

Then run `/reload` in Pi. Project-local install is also possible at `.pi/extensions/pi-claude-style-sandbox-permissions` after the project is trusted.

### If replacing another permission extension

Disable older Bash permission gates before testing this one, especially raw wildcard rules such as:

```json
"* rm *": "deny",
"rm *": "deny"
```

One extension cannot override another extension's hard block.

### Smoke test after install

In Pi:

```text
/permissions-check git rm -f -- path/to/file.py
/permissions-check git add -- foo && git status --short | grep '^U' || true
/permissions-check rm -rf /
```

Expected:

- `git rm` and the `git add && git status` chain: `run-sandboxed`, no prompt.
- `rm -rf /`: hard deny, no unsandboxed approval path.

## Architecture

For each `bash` tool call the extension overrides Pi's built-in Bash tool and applies this pipeline:

1. Explicit deny rules (`claudeDenyRules`, `denyPrefixes`, `denyRegexes`) block, including after safe wrapper normalization and inside command substitutions.
2. Hard safety denies block catastrophic/root/system-destructive commands (`rm -rf /`, `--no-preserve-root`, recursive deletes of obvious system roots, and privileged wrappers around those forms). These commands have no unsandboxed host execution path.
3. Safety asks (`curl | sh`, non-catastrophic recursive `rm`, substitution/redirection when no sandbox is active) prompt and never offer approve-always. When the sandbox is active, approved safety asks still run sandboxed.
4. `dangerouslyDisableSandbox: true` requests an unsandboxed retry and prompts unless an explicit allow rule already matches; the flag itself is not an approval path.
5. Claude Code allow rules (`Bash(git push:*)`) run unsandboxed with no prompt, except hard safety denies still win.
6. `sandbox.excludedCommands` skip the sandbox and prompt.
7. Everything else runs in the OS sandbox with no prompt.
8. If the sandbox is disabled or unavailable, read-only commands may still run, but local mutations fail closed to an explicit UI approval instead of using coding-mode accept-edits shortcuts.

On macOS, enforcement uses Apple's Seatbelt via `/usr/bin/sandbox-exec` through `srt`. Other platforms fall back to classify-only unless `srt` supports them and initializes successfully.

## Gondolin / micro-VM evaluation

Gondolin is being tracked separately as an opt-in local micro-VM backend, not as part of the default `srt` path. See [`docs/gondolin-evaluation.md`](docs/gondolin-evaluation.md) for the issue #4 recommendation, setup requirements, fail-closed semantics, future backend slice, tests, and risks.

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
- that retry prompts the user for approve-once / approve-always / No unless a matching explicit allow rule already exists;
- never retry hard-denied catastrophic/root/system-destructive commands unsandboxed.

Approve-always persists the suggested `Bash(<prefix>:*)` rule to `.claude/settings.local.json` using the same writer as v1. Hard safety denies never get an approve-always option and cannot be approved once.

## Config

Copy `config.example.json` to `config.json` next to the extension, or to `.pi/claude-style-permissions.json` in a trusted project.

```jsonc
{
  "mode": "coding",
  "noUiAskDecision": "deny",
  "autoApproveAsk": false,
  "sandboxToggleShortcut": "ctrl+shift+p",
  "importClaudeCodeSettings": true,
  "persistApprovalsToClaudeCodeSettings": true,
  "writeClaudeCodeSettingsPath": ".claude/settings.local.json",
  "claudeCodeSettingsPaths": [
    "~/.claude/settings.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
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
    "annotateViolations": true,
  },
}
```

Arrays append to defaults. Project config and project-local Claude settings are loaded only when Pi trusts the project. User Claude settings are read from `CLAUDE_CONFIG_DIR/settings.json` when set, otherwise `~/.claude/settings.json`.

`autoApproveAsk` and `noUiAskDecision: "allow"` are legacy/development knobs and are fail-closed for unsandboxed execution: if no UI is available, commands that need approval are denied.

Examples:

- allow npm metadata/network inside sandbox: `"allowedDomains": ["registry.npmjs.org", "*.npmjs.org"]`
- allow a cache directory to be written in sandbox: `"allowWrite": ["~/.cache/my-tool"]`
- force Docker to prompt unsandboxed: `"excludedCommands": ["Bash(docker:*)"]`

## Commands, shortcut, and status

- `/permissions-check <cmd>` shows both the v1 classification and the v2 pipeline action (`run-sandboxed`, `ask-sandboxed`, `ask-unsandboxed`, etc.).
- `Ctrl+Shift+P` toggles the sandbox for the current session only (`srt-sandboxed` ↔ `classify-only`). It does not edit config files and does not approve local mutations; classify-only mode prompts/denies instead of using sandbox-protected edit shortcuts.
- Configure the shortcut with `"sandboxToggleShortcut": "ctrl+alt+p"`, use an array for multiple bindings, or set it to `null`, `false`, `"none"`, or `"disabled"` to disable registration.
- Status line:
  - `perms: srt-sandboxed`
  - `perms: classify-only (srt unavailable)`
  - `perms: classify-only (sandbox disabled)`
  - `perms: classify-only (shortcut override)`
- User `!` / `!!` shell commands run unsandboxed because the human typed them.

## Threat model / non-goals

This extension protects against accidental or model-initiated Bash effects outside the configured sandbox boundary. It does **not** protect against:

- destructive changes inside the workspace or `/tmp` by commands that run sandboxed or are explicitly approved;
- non-hard-denied commands you explicitly approve unsandboxed;
- secrets already present in environment variables visible to Pi/Bash;
- malicious project code that is allowed to run and damage allowed write paths;
- other Pi extensions that override or block tools separately.

Keep backups/git history for workspace damage. Treat approve-always rules as trust decisions.

## Quality checks

The lint/format setup follows the `gugu91/extensions` baseline: ESLint flat config with Node globals, TypeScript-aware rules for `.ts`, no explicit `any`, no unused variables, and a guardrail against generic `isRecord` helpers; Prettier enforces formatting.

```bash
npm run lint
npm run static
npm test
npm run format:check
npm pack --dry-run
```

`npm run check` runs lint, static syntax checks, tests, and format verification together.
