# Gondolin evaluation for issue #4

## Recommendation

**Separate now, docs/design only.** Gondolin is value-additive for this project, but it should not be folded into the PR #6 / issue #2 permission-pipeline hardening path and it should not become a default backend yet.

PR #6 has now landed the immediate usable path: an enforce-first `srt` sandbox for Bash plus fail-closed permission semantics. Gondolin belongs in the next, opt-in track: a local micro-VM execution backend for sessions that need a stronger or more portable boundary than the host OS sandbox can provide.

For this first issue #4 slice, keep the repository free of Gondolin runtime dependencies and backend code. The smallest coherent step is this design note plus README discoverability.

## Why Gondolin is value-additive

Gondolin changes the isolation layer rather than the command classifier. The Pi example extension runs Pi's built-in file/search/Bash tools inside a local Linux micro-VM, mounts the host workspace at `/workspace`, and keeps Pi itself, provider auth, and host credentials outside the guest.

That is useful for this project because:

- **Stronger execution boundary:** risky commands execute in a VM guest rather than directly in the host process environment.
- **Clearer credential boundary:** the model can run tools against the mounted workspace without inheriting host auth files unless they are deliberately mounted or exposed.
- **Cross-platform direction:** it can become the non-macOS answer where Apple's Seatbelt via `sandbox-exec` is unavailable or insufficient.
- **Policy continuity:** the existing Claude Code-style allow/ask/deny pipeline can still decide whether a command is blocked, sandboxed, or escalated before anything reaches the backend.

## Relation to PR #6 / issue #2

PR #6 closes issue #2 and remains the immediate hardening path:

- `srt` is still the default enforcement backend.
- hard safety denies still have no approval path;
- no-UI unsandboxed approval remains fail-closed;
- fallback/classify-only behavior still requires explicit approval for local mutations;
- Charlie-tomorrow usability should rely on PR #6, not Gondolin.

Gondolin should **not** change the PR #6 merge decision. It belongs to the issue #4 evaluation track and should remain opt-in/experimental until packaging, startup, compatibility, and test coverage are proven.

## Setup requirements and operator UX

Known requirements from the Pi/Gondolin examples and package metadata:

- Node.js `>=23.6.0`;
- QEMU available on PATH for the default backend;
- optional `krun` backend where supported;
- first-run guest image download/cache, currently hundreds of MB;
- macOS/Linux focus; Windows is not an initial target;
- guest environment is Linux, so workflows that assume host macOS tools may differ.

A production-quality integration should surface these checks before first use and fail with a clear operator message, e.g.:

> `sandbox.backend: "gondolin"` requested, but QEMU or Gondolin guest assets are unavailable. Command was not run. Install QEMU / pre-warm the image cache, or switch back to `sandbox.backend: "srt"`.

It should never silently fall back from a requested micro-VM backend to unsandboxed host execution.

## Fail-closed semantics

The existing permission pipeline should stay authoritative:

1. apply explicit deny rules and hard safety denies first;
2. decide allow/ask/deny exactly as today;
3. only then dispatch approved sandboxed execution to the selected backend;
4. if Gondolin is selected but cannot start, deny the command with a setup error;
5. never treat `dangerouslyDisableSandbox` or no-UI config as approval to run on the host;
6. keep approve-always persistence scoped to explicit permission rules, not backend availability.

Network policy should remain default-deny. Future Gondolin execution should map `sandbox.allowedDomains` to Gondolin HTTP policy hooks and keep `sandbox.allowedDomains: []` as no outbound network. SSH/TCP escape hatches should require explicit configuration.

## Smallest future backend architecture

The first code PR, if approved after this design slice, should be an **opt-in experimental Bash backend only**:

```jsonc
{
  "sandbox": {
    "enabled": true,
    "backend": "srt", // "srt" | "gondolin"
    "allowedDomains": []
  }
}
```

Proposed shape:

- introduce a tiny backend adapter boundary used only by the Bash override;
- keep `srt` as the default adapter;
- load Gondolin with a dynamic import only when `sandbox.backend === "gondolin"`;
- mount the current Pi workspace read/write at `/workspace` using Gondolin's real filesystem provider;
- execute Bash in the guest with cwd `/workspace`;
- map network allowlist config to Gondolin HTTP hooks;
- set status text such as `perms: gondolin-sandboxed` and show startup/setup failures clearly;
- close VMs on Pi shutdown/reload where possible, and provide enough state for stale-session cleanup.

Do **not** start by overriding Pi `read`, `write`, `edit`, `grep`, `find`, or `ls` in this package. The Pi example does that for a full VM-routed session, but this repository is a Bash permission extension. A full built-in-tool routing package may be valuable later, but it is a larger packaging and UX decision.

## Tests before enabling by default

Unit tests should cover the policy contract without booting a real VM:

- `backend: "gondolin"` selected -> VM adapter receives only commands that the pipeline would run sandboxed;
- hard-denied commands never reach the adapter;
- VM startup/import/setup failures fail closed;
- `allowedDomains` translates into the expected network policy;
- no-UI approval config cannot cause unsandboxed host execution when Gondolin is unavailable.

Integration tests should be opt-in, for example behind `GONDOLIN_INTEGRATION=1`, because QEMU/image boot is slow and environment-dependent. A useful smoke test is: create a temp workspace, run `pwd`/`touch` inside `/workspace`, verify the file appears on the host, and verify a disallowed network request fails.

## Risks and open questions

- **Setup cost:** Node `>=23.6`, QEMU, guest image cache, and optional native runners add friction.
- **VM startup UX:** first run can download/boot; failures need crisp status and no silent host fallback.
- **Portability:** macOS/Linux first; Linux guest tools may not match host toolchains.
- **Dependency surface:** adding `@earendil-works/gondolin` brings extra transitive and optional native dependencies, so it should be dynamic/optional until proven.
- **Filesystem policy:** the first backend should mount only the workspace read/write; broader reads, caches, and secrets need explicit design.
- **Network/secrets policy:** default-deny network and no implicit host credential mounts are essential to preserve the security story.
- **Test cost:** real VM coverage is valuable but should not become the default fast test path.
- **Charlie-tomorrow usability:** PR #6 / `srt` is the path to use now; Gondolin should not be required for near-term demos or operator confidence.

## Current issue #4 outcome

This PR satisfies the design-note acceptance shape for issue #4: adopt Gondolin as a worthwhile future opt-in micro-VM backend, but do not add dependency or backend code until the experimental Bash adapter can be built and tested deliberately. The next follow-up, if approved, should be the prototype PR described above.
