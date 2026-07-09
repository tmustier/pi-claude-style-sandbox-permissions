# Omnigent managed backend for issue #3

## Recommendation

**Do a real opt-in slice now, but do not pretend it is a full managed-session product yet.**

This PR adds an experimental `sandbox.backend: "omnigent-managed"` Bash backend that delegates commands to the Omnigent session environment shell API for an already-created Omnigent session. That is the smallest coherent implementation because it exercises the actual managed-cloud execution boundary without making Pi's local host the fallback boundary.

The backend is intentionally not the default. `srt` remains the default local sandbox.

## What is implemented now

When configured, sandboxed Bash commands are sent to:

```text
POST <serverUrl>/v1/sessions/<sessionId>/resources/environments/<environmentId>/shell
```

The extension preflights the session with:

```text
GET <serverUrl>/v1/sessions/<sessionId>?include_items=false&include_liveness=true
```

The command is run only if that Omnigent session/runner is available. Missing config, auth failure, server errors, launch failure, in-flight launch, and offline runners all fail closed with an explicit error. The extension does **not** silently fall back to local host Bash for this backend.

Hard safety denies still run before the backend is initialized, so catastrophic/root/system-destructive commands never reach Omnigent and still have no unsandboxed host path.

## Configuration

Project or extension config:

```jsonc
{
  "sandbox": {
    "enabled": true,
    "backend": "omnigent-managed",
    "omnigent": {
      "serverUrl": "https://your-omnigent-server.example",
      "sessionId": "conv_...",
      "environmentId": "default",
      "bearerTokenEnv": "OMNIGENT_BEARER_TOKEN"
    }
  }
}
```

`serverUrl` and `sessionId` may also come from `OMNIGENT_SERVER_URL` and `OMNIGENT_SESSION_ID`. `environmentId` defaults to `default`.

Authentication is deployment-specific in Omnigent. Keep raw secrets out of config; reference environment variables instead:

- `bearerTokenEnv` sends `Authorization: Bearer <value>`.
- `cookieEnv` sends `Cookie: <value>`.
- `authHeaderName` + `authHeaderValueEnv` sends one custom header. Use this only for local/trusted proxy setups where the server expects that header; a public proxy must strip spoofed inbound identity headers.

## First provider target

Use **Modal** as the first end-to-end managed-provider target for Pi validation:

- Omnigent documents `host_type: "managed"` with Modal as a first-class provider.
- The official host image (`ghcr.io/omnigent-ai/omnigent-host:latest`) includes `pi`, `codex`, and `claude` CLIs.
- Modal has clear server credentials (`MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` or `~/.modal.toml`) and managed sandbox credentials via Modal secrets.
- Known limits are explicit: 2 CPU / 4 GiB default sandbox resources and a 24-hour lifetime cap.

Keep the Pi extension itself provider-agnostic by using Omnigent's session/environment API rather than calling Modal directly. Daytona/Islo/E2B can then work once the Omnigent server/session is configured for those providers.

## Security model

The permission pipeline stays authoritative:

1. explicit deny rules and hard safety denies run first;
2. safety prompts and `dangerouslyDisableSandbox` semantics are unchanged;
3. only `run-sandboxed` / approved `ask-sandboxed` decisions reach the Omnigent backend;
4. backend setup/API/session/runner failures fail closed;
5. no backend error includes configured auth values;
6. `srt` remains the default backend.

Use Omnigent's host placement together with Omnibox / `os_env.sandbox` policy. The managed host decides *where* the runner runs; Omnibox decides what filesystem, network, and environment access that runner gets. In production, disallow `sandbox.type: none` / equivalent sandbox-off overrides at the Omnigent policy layer, and keep MCP subprocesses disabled or separately constrained unless their sandboxing story is explicit.

Explicit Claude Code allow rules and `sandbox.excludedCommands` still opt into the existing unsandboxed-host approval/allow paths once the backend is available. Do not configure those when the operator intent is “all Bash must stay off the local host.”

## What remains blocked / not faked

This PR does **not** auto-create or tear down Omnigent managed sessions. The missing pieces are real product/API choices, not code we should fake locally:

- **Agent/session bootstrap:** Pi needs a concrete Omnigent `agent_id` or bundled agent spec strategy before it can call `POST /v1/sessions {"host_type":"managed"}` on behalf of a Pi run.
- **Workspace sync:** Omnigent managed sessions can clone repositories, including private ones with `GIT_TOKEN`, but Pi still needs a safe story for unpushed local changes, ignored files, generated artifacts, and writeback.
- **Credential injection:** provider, git, and model credentials belong in Omnigent server/provider secret stores, not in this Pi extension config. The UX for choosing which secrets a run gets needs a deliberate allowlist.
- **Lifecycle/cost policy:** session deletion tears down managed sandboxes, but Pi needs ownership rules for when to delete, keep warm, resume, or archive.
- **Approval/log return path:** this slice only returns shell stdout/stderr/exit code. Full Pi-in-Omnigent sessions should decide how approvals, artifacts, changed files, and logs return to the local Pi UI.

## Validation hooks for the heavier follow-up lane

The later adversarial/non-adversarial validation lane should use only dummy resources:

- create throwaway public/private GitHub repositories and branch/worktree fixtures to test repo clone, ignored files, unpushed local edits, writeback, and `git push` behavior;
- simulate AWS/prod-DB-shaped secrets with inert names and dummy values, then verify they are not present unless explicitly allowlisted via provider secrets;
- use fake `prod-psql`, fake AWS CLIs, and local stub endpoints instead of live customer/prod credentials;
- assert missing Modal/provider credentials, missing Omnigent auth, offline runners, in-flight launches, and failed sandbox launches all fail closed;
- re-run the #2 invariants: `rm -rf /` / root destructive forms never reach the backend or host, DDS/off/no-UI paths do not silently approve, and incident commands (`git rm`, `git add && git status | grep`) stay sandboxed/no-prompt.

## Next minimal code slice

After one manual Omnigent managed session is proven with this backend, the next coherent PR should add explicit session lifecycle commands:

1. validate Omnigent server capabilities and auth mode;
2. create a managed session from a configured `agentId` / agent bundle and optional git repository URL;
3. wait for `sandbox_status` to become ready;
4. run Bash through the environment shell endpoint as this PR does;
5. delete or retain the session according to an explicit config flag.

Do not make managed cloud the default until workspace sync, credential scoping, teardown, and cost/lifetime behavior are proven end-to-end.
