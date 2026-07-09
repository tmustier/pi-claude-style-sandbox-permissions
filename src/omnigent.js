const DEFAULT_ENVIRONMENT_ID = "default";
const DEFAULT_ENSURE_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeHeaderName(name) {
  const value = stringValue(name);
  if (!value) return undefined;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) {
    throw new Error(`Invalid Omnigent auth header name '${value}'`);
  }
  return value;
}

function normalizeServerUrl(value) {
  const raw = stringValue(value);
  if (!raw) return undefined;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Omnigent serverUrl '${raw}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Omnigent serverUrl must use http or https");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function envValue(env, name) {
  const key = stringValue(name);
  if (!key) return undefined;
  return stringValue(env?.[key]);
}

export function getOmnigentManagedConfig(config = {}, env = process.env) {
  const sandbox = config.sandbox && typeof config.sandbox === "object" ? config.sandbox : {};
  const omnigent = sandbox.omnigent && typeof sandbox.omnigent === "object" ? sandbox.omnigent : {};

  const missing = [];
  let serverUrl;
  try {
    serverUrl = normalizeServerUrl(omnigent.serverUrl ?? env?.OMNIGENT_SERVER_URL);
  } catch (error) {
    return { missing: [error instanceof Error ? error.message : String(error)] };
  }
  if (!serverUrl) missing.push("sandbox.omnigent.serverUrl (or OMNIGENT_SERVER_URL)");

  const sessionId = stringValue(omnigent.sessionId ?? env?.OMNIGENT_SESSION_ID);
  if (!sessionId) missing.push("sandbox.omnigent.sessionId (or OMNIGENT_SESSION_ID)");

  const environmentId = stringValue(omnigent.environmentId ?? env?.OMNIGENT_ENVIRONMENT_ID) ?? DEFAULT_ENVIRONMENT_ID;

  const bearerTokenEnv = stringValue(omnigent.bearerTokenEnv);
  const bearerToken = envValue(env, bearerTokenEnv);
  if (bearerTokenEnv && !bearerToken) missing.push(`environment variable ${bearerTokenEnv}`);

  const cookieEnv = stringValue(omnigent.cookieEnv);
  const cookie = envValue(env, cookieEnv);
  if (cookieEnv && !cookie) missing.push(`environment variable ${cookieEnv}`);

  let authHeaderName;
  try {
    authHeaderName = sanitizeHeaderName(omnigent.authHeaderName);
  } catch (error) {
    return { missing: [error instanceof Error ? error.message : String(error)] };
  }
  const authHeaderValueEnv = stringValue(omnigent.authHeaderValueEnv);
  const authHeaderValue = envValue(env, authHeaderValueEnv);
  if (authHeaderName && !authHeaderValueEnv) missing.push("sandbox.omnigent.authHeaderValueEnv");
  if (authHeaderValueEnv && !authHeaderValue) missing.push(`environment variable ${authHeaderValueEnv}`);

  const ensureTimeoutMs = Number.isFinite(omnigent.ensureTimeoutMs)
    ? Math.max(1, Number(omnigent.ensureTimeoutMs))
    : DEFAULT_ENSURE_TIMEOUT_MS;
  const commandTimeoutMs = Number.isFinite(omnigent.commandTimeoutMs)
    ? Math.max(1, Number(omnigent.commandTimeoutMs))
    : DEFAULT_COMMAND_TIMEOUT_MS;

  return {
    serverUrl,
    sessionId,
    environmentId,
    bearerToken,
    cookie,
    authHeaderName,
    authHeaderValue,
    ensureTimeoutMs,
    commandTimeoutMs,
    missing
  };
}

function buildHeaders(runtime, { json = false } = {}) {
  const headers = {
    Accept: "application/json"
  };
  if (json) headers["Content-Type"] = "application/json";
  if (runtime.bearerToken) headers.Authorization = `Bearer ${runtime.bearerToken}`;
  if (runtime.cookie) headers.Cookie = runtime.cookie;
  if (runtime.authHeaderName && runtime.authHeaderValue) headers[runtime.authHeaderName] = runtime.authHeaderValue;
  return headers;
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abortFromParent);
    }
  };
}

function displayHttpError(status, bodyText) {
  const message = sanitizeBackendMessage(bodyText);
  return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
}

function sanitizeBackendMessage(value) {
  if (value === undefined || value === null) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  text = text.replace(/[\r\n]+/g, " ").trim();
  if (text.length > 300) text = `${text.slice(0, 297)}...`;
  return text;
}

async function readResponseBody(response) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

async function fetchJson(fetchImpl, url, init, { timeoutMs, signal } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable; Node.js 18+ is required for the Omnigent backend");
  }

  const timeout = withTimeout(signal, timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: timeout.signal });
  } catch (error) {
    if (timeout.signal.aborted) throw new Error(`request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    timeout.cleanup();
  }

  const body = await readResponseBody(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`HTTP ${response.status}: Omnigent authentication or authorization failed`);
    }
    const detail = typeof body === "object" && body !== null
      ? (body.error?.message ?? body.detail ?? body.message ?? body)
      : body;
    throw new Error(displayHttpError(response.status, detail));
  }
  return body;
}

function sessionUrl(runtime) {
  return `${runtime.serverUrl}/v1/sessions/${encodeURIComponent(runtime.sessionId)}?include_items=false&include_liveness=true`;
}

function shellUrl(runtime) {
  return `${runtime.serverUrl}/v1/sessions/${encodeURIComponent(runtime.sessionId)}/resources/environments/${encodeURIComponent(runtime.environmentId)}/shell`;
}

function unavailable(reason) {
  return { available: false, initialized: false, reason, failClosed: true, backend: "omnigent-managed" };
}

function malformedSessionReason(reason) {
  return `Omnigent managed session preflight returned malformed response${reason ? `: ${reason}` : ""}`;
}

function validateSessionResponse(runtime, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return malformedSessionReason("expected a session object");
  }

  if (typeof body.id !== "string" || !body.id.trim()) {
    return malformedSessionReason("missing session id");
  }
  if (body.id !== runtime.sessionId) {
    return malformedSessionReason("session id did not match configured session");
  }

  if (body.runner_online !== undefined && body.runner_online !== null && typeof body.runner_online !== "boolean") {
    return malformedSessionReason("runner_online must be boolean or null");
  }

  if (body.sandbox_status !== undefined && body.sandbox_status !== null) {
    if (typeof body.sandbox_status !== "object" || Array.isArray(body.sandbox_status)) {
      return malformedSessionReason("sandbox_status must be object or null");
    }
    if (body.sandbox_status.stage !== undefined && typeof body.sandbox_status.stage !== "string") {
      return malformedSessionReason("sandbox_status.stage must be a string");
    }
  }

  return undefined;
}

export async function ensureOmnigentManagedSandbox(ctx, config = {}, { fetchImpl = globalThis.fetch } = {}) {
  const runtime = getOmnigentManagedConfig(config);
  if (runtime.missing?.length) {
    return unavailable(`Omnigent managed backend is not configured: missing ${runtime.missing.join(", ")}`);
  }

  try {
    const body = await fetchJson(fetchImpl, sessionUrl(runtime), {
      method: "GET",
      headers: buildHeaders(runtime)
    }, { timeoutMs: runtime.ensureTimeoutMs });

    const malformedReason = validateSessionResponse(runtime, body);
    if (malformedReason) return unavailable(malformedReason);

    const sandboxStatus = body?.sandbox_status;
    if (sandboxStatus?.stage === "failed") {
      return unavailable(`Omnigent managed sandbox launch failed${sandboxStatus.error ? `: ${sanitizeBackendMessage(sandboxStatus.error)}` : ""}`);
    }
    if (sandboxStatus?.stage && sandboxStatus.stage !== "ready") {
      return unavailable(`Omnigent managed sandbox is not ready yet (stage: ${sanitizeBackendMessage(sandboxStatus.stage)})`);
    }
    if (body?.runner_online === false) {
      return unavailable("Omnigent session runner is offline; environment shell is not available");
    }

    ctx?.ui?.setStatus?.("claude-perms", "perms: omnigent-managed");
    return { available: true, initialized: true, backend: "omnigent-managed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(`Omnigent managed backend check failed: ${sanitizeBackendMessage(message)}`);
  }
}

export function createOmnigentManagedOperations(config = {}, ctx, { fetchImpl = globalThis.fetch } = {}) {
  return {
    async exec(command, _cwd, { onData, signal, timeout } = {}) {
      const runtime = getOmnigentManagedConfig(config);
      if (runtime.missing?.length) {
        throw new Error(`Omnigent managed backend is not configured: missing ${runtime.missing.join(", ")}`);
      }

      const timeoutMs = typeof timeout === "number" && timeout > 0
        ? timeout * 1000
        : runtime.commandTimeoutMs;
      const body = await fetchJson(fetchImpl, shellUrl(runtime), {
        method: "POST",
        headers: buildHeaders(runtime, { json: true }),
        body: JSON.stringify({ command, timeout: typeof timeout === "number" ? Math.ceil(timeout) : undefined })
      }, { timeoutMs, signal });

      if (!body || typeof body !== "object") {
        throw new Error("Omnigent shell endpoint returned a malformed response");
      }

      const stdout = typeof body.stdout === "string" ? body.stdout : "";
      const stderr = typeof body.stderr === "string" ? body.stderr : "";
      if (stdout) onData?.(Buffer.from(stdout));
      if (stderr) onData?.(Buffer.from(stderr));

      const exitCode = Number.isInteger(body.exit_code)
        ? body.exit_code
        : body.timed_out === true
          ? 124
          : undefined;
      if (!Number.isInteger(exitCode)) {
        throw new Error("Omnigent shell endpoint returned a malformed exit_code");
      }
      return { exitCode };
    }
  };
}
