const DEFAULT_SAFE_WRAPPERS = ["timeout", "gtimeout", "time", "nice", "nohup", "command", "env"];

export const DEFAULT_CONFIG = {
  // `coding` mirrors Claude Code's acceptEdits fast path: normal local file edits and
  // git index operations are allowed after deny/ask safety checks. Set to `default`
  // if you want every unknown mutating command to prompt.
  mode: "coding",
  noUiAskDecision: "deny",
  autoApproveAsk: false,
  sandboxToggleShortcut: "ctrl+shift+p",
  safeWrappers: DEFAULT_SAFE_WRAPPERS,
  allowPrefixes: [
    "pwd",
    "whoami",
    "date",
    "ls",
    "find",
    "grep",
    "rg",
    "cat",
    "head",
    "tail",
    "wc",
    "stat",
    "file",
    "du",
    "df",
    "which",
    "git status",
    "git diff",
    "git log",
    "git show",
    "git blame",
    "git remote -v",
    "git ls-files",
    "git rev-parse",
    "git merge-base",
    "git stash list",
    "gh pr list",
    "gh pr view",
    "gh pr diff",
    "gh pr checks",
    "gh pr status",
    "gh search prs",
    "true",
    "false",
    "pytest",
    "python -m pytest",
    "uv run pytest",
    "uv run ruff check",
    "uv run ruff format --check",
    "uv run pyright",
    "uv run mypy",
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run build",
    "pnpm test",
    "pnpm run test",
    "pnpm run lint",
    "pnpm run build",
    "bun test",
    "go test",
    "cargo test",
    "make test",
    "make lint"
  ],
  // Allowed only when mode === "coding". These are analogous to Claude Code's
  // acceptEdits allowance for local filesystem edits, with git conflict/index
  // operations included because they are common during coding tasks.
  acceptEditsPrefixes: [
    "mkdir",
    "touch",
    "rm",
    "rmdir",
    "mv",
    "cp",
    "sed",
    "git add",
    "git rm",
    "git mv",
    "git restore",
    "git restore --staged",
    "git checkout --ours",
    "git checkout --theirs"
  ],
  askPrefixes: [
    "sudo",
    "doas",
    "su",
    "ssh",
    "scp",
    "rsync",
    "curl",
    "wget",
    "brew",
    "npm install",
    "pnpm install",
    "yarn install",
    "bun install",
    "pip install",
    "uv pip install",
    "docker",
    "docker-compose",
    "kubectl",
    "psql",
    "mysql",
    "redis-cli",
    "gh api",
    "git commit",
    "git push",
    "git pull",
    "git fetch",
    "git merge",
    "git rebase",
    "git reset",
    "git clean"
  ],
  denyPrefixes: [
    "prod-psql"
  ],
  askRegexes: [
    "[`]",
    "\\$\\(",
    "\\b(chmod|chown)\\b.*\\b777\\b",
    "\\bcurl\\b.*\\|\\s*(?:\\S*/)?(sh|bash|zsh)\\b",
    "\\bwget\\b.*\\|\\s*(?:\\S*/)?(sh|bash|zsh)\\b"
  ],
  denyRegexes: [],
  // Optional: rules imported from Claude Code settings files. Each entry uses
  // Claude Code's settings syntax, e.g. Bash(git status), Bash(git rm:*),
  // Bash(rm *). They are evaluated semantically per subcommand, not as raw
  // substrings over the full shell command.
  claudeAllowRules: [],
  claudeAskRules: [],
  claudeDenyRules: [],
  sandbox: {
    enabled: true,
    allowedDomains: [],
    allowWrite: [],
    denyWrite: [],
    denyRead: [],
    excludedCommands: [],
    annotateViolations: true
  }
};

export function mergeConfig(base = DEFAULT_CONFIG, override = {}) {
  const merged = { ...base, ...override };
  for (const key of [
    "safeWrappers",
    "allowPrefixes",
    "acceptEditsPrefixes",
    "askPrefixes",
    "denyPrefixes",
    "askRegexes",
    "denyRegexes",
    "claudeAllowRules",
    "claudeAskRules",
    "claudeDenyRules"
  ]) {
    if (Array.isArray(override[key])) {
      const baseValues = Array.isArray(base[key]) ? base[key] : [];
      merged[key] = [...baseValues, ...override[key]];
    }
  }

  if (base.sandbox || override.sandbox) {
    const baseSandbox = base.sandbox && typeof base.sandbox === "object" ? base.sandbox : {};
    const overrideSandbox = override.sandbox && typeof override.sandbox === "object" ? override.sandbox : {};
    merged.sandbox = { ...baseSandbox, ...overrideSandbox };
    for (const key of ["allowedDomains", "deniedDomains", "allowWrite", "denyWrite", "denyRead", "excludedCommands"]) {
      if (Array.isArray(overrideSandbox[key])) {
        const baseValues = Array.isArray(baseSandbox[key]) ? baseSandbox[key] : [];
        merged.sandbox[key] = [...baseValues, ...overrideSandbox[key]];
      }
    }
  }

  return merged;
}

export function splitShellCommand(command) {
  const parts = [];
  let buf = "";
  let quote = null;
  let escaped = false;

  const push = () => {
    const part = buf.trim();
    if (part) parts.push(part);
    buf = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      buf += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }

    if (ch === ";" || ch === "\n") {
      push();
      continue;
    }

    if (ch === "&" && next === "&") {
      push();
      i++;
      continue;
    }

    if (ch === "&" && next !== ">" && command[i - 1] !== ">" && command[i - 1] !== "<") {
      push();
      continue;
    }

    if (ch === "|" && next === "|") {
      push();
      i++;
      continue;
    }

    if (ch === "|") {
      push();
      continue;
    }

    buf += ch;
  }

  push();
  return parts;
}

export function tokenizeShellWords(command) {
  const tokens = [];
  let buf = "";
  let quote = null;
  let escaped = false;

  const push = () => {
    if (buf.length > 0) tokens.push(buf);
    buf = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }

    buf += ch;
  }

  push();
  return tokens;
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function stripEnvAssignments(tokens) {
  let i = 0;
  while (i < tokens.length && isEnvAssignment(tokens[i])) i++;
  return tokens.slice(i);
}

function looksLikeDuration(token) {
  return /^\d+(?:\.\d+)?[smhd]?$/i.test(token);
}

export function normalizeTokens(tokens, config = DEFAULT_CONFIG) {
  let current = stripEnvAssignments([...tokens]);
  let changed = true;
  const wrappers = new Set(config.safeWrappers ?? DEFAULT_SAFE_WRAPPERS);

  while (changed && current.length > 0) {
    changed = false;
    current = stripEnvAssignments(current);
    const first = current[0];

    if (!wrappers.has(first)) break;

    if (first === "timeout" || first === "gtimeout") {
      current.shift();
      while (current[0]?.startsWith("-")) {
        const option = current.shift();
        if ((option === "-s" || option === "--signal") && current[0]) current.shift();
        if ((option === "-k" || option === "--kill-after") && current[0]) current.shift();
      }
      if (current[0] && looksLikeDuration(current[0])) current.shift();
      changed = true;
      continue;
    }

    if (first === "nice") {
      current.shift();
      while (current[0]?.startsWith("-")) {
        const option = current.shift();
        if ((option === "-n" || option === "--adjustment") && current[0]) current.shift();
      }
      changed = true;
      continue;
    }

    if (first === "time") {
      current.shift();
      while (current[0]?.startsWith("-")) current.shift();
      changed = true;
      continue;
    }

    if (first === "command") {
      current.shift();
      while (current[0]?.startsWith("-")) current.shift();
      if (current[0] === "--") current.shift();
      changed = true;
      continue;
    }

    if (first === "env") {
      current = normalizeEnvTokens(current);
      changed = true;
      continue;
    }

    current.shift();
    changed = true;
  }

  return current;
}

function normalizeEnvTokens(tokens) {
  const rest = tokens.slice(1);
  let i = 0;

  const splitAndAppend = (value, afterIndex) => {
    const split = tokenizeShellWords(value ?? "");
    return stripEnvAssignments([...split, ...rest.slice(afterIndex)]);
  };

  while (i < rest.length) {
    const token = rest[i];

    if (token === "--") {
      i++;
      break;
    }

    if (token === "-") {
      i++;
      continue;
    }

    if (!token.startsWith("-") || token === "") break;

    if (token === "-S" || token === "--split-string") {
      return splitAndAppend(rest[i + 1], i + 2);
    }
    if (token.startsWith("-S") && token.length > 2) {
      return splitAndAppend(token.slice(2), i + 1);
    }
    if (token.startsWith("--split-string=")) {
      return splitAndAppend(token.slice("--split-string=".length), i + 1);
    }

    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir" || token === "-a" || token === "--argv0") {
      i += 2;
      continue;
    }
    if ((token.startsWith("-u") || token.startsWith("-C") || token.startsWith("-a")) && token.length > 2) {
      i++;
      continue;
    }
    if (token.startsWith("--unset=") || token.startsWith("--chdir=") || token.startsWith("--argv0=")) {
      i++;
      continue;
    }

    i++;
  }

  return stripEnvAssignments(rest.slice(i));
}

function tokenPrefixMatches(tokens, prefix) {
  const prefixTokens = tokenizeShellWords(prefix);
  if (prefixTokens.length === 0 || tokens.length < prefixTokens.length) return false;
  for (let i = 0; i < prefixTokens.length; i++) {
    if (tokens[i] !== prefixTokens[i]) return false;
  }
  return true;
}

function firstMatchingPrefix(tokens, prefixes = []) {
  return prefixes.find((prefix) => tokenPrefixMatches(tokens, prefix));
}

function firstMatchingRegex(command, regexes = []) {
  for (const pattern of regexes) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(command)) return pattern;
  }
  return undefined;
}

const SANDBOX_GATED_ASK_REGEXES = new Set(["[`]", "\\$\\("]);

function firstMatchingAskRegex(command, regexes = [], sandboxActive = false) {
  for (const pattern of regexes) {
    if (sandboxActive && SANDBOX_GATED_ASK_REGEXES.has(pattern)) continue;
    const regex = new RegExp(pattern, "i");
    if (regex.test(command)) return pattern;
  }
  return undefined;
}

function wildcardToRegex(pattern) {
  const trimmed = String(pattern).trim();
  const escapedStar = "\u0000ESCAPED_STAR\u0000";
  const escapedBackslash = "\u0000ESCAPED_BACKSLASH\u0000";
  let processed = "";

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];
    if (ch === "\\" && next === "*") {
      processed += escapedStar;
      i++;
      continue;
    }
    if (ch === "\\" && next === "\\") {
      processed += escapedBackslash;
      i++;
      continue;
    }
    processed += ch;
  }

  let regexPattern = processed
    .replace(/[.+?^${}()|[\]\\'"]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replaceAll(escapedStar, "\\*")
    .replaceAll(escapedBackslash, "\\\\");

  const unescapedStarCount = (processed.match(/\*/g) || []).length;
  if (regexPattern.endsWith(" .*") && unescapedStarCount === 1) {
    regexPattern = `${regexPattern.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${regexPattern}$`, "s");
}

export function parseClaudePermissionRule(rule) {
  if (typeof rule !== "string") return undefined;
  const trimmed = rule.trim();
  if (!trimmed) return undefined;

  const match = trimmed.match(/^([^()]+)(?:\((.*)\))?$/);
  if (!match) return undefined;

  const toolName = match[1].trim();
  const content = match[2]?.trim();
  const normalizedTool = toolName.toLowerCase();
  if (normalizedTool !== "bash" && normalizedTool !== "shell") return undefined;

  if (!content || content === "*") {
    return { raw: trimmed, type: "all" };
  }

  if (content.endsWith(":*")) {
    return { raw: trimmed, type: "prefix", prefix: content.slice(0, -2).trim() };
  }

  if (content.includes("*")) {
    return { raw: trimmed, type: "wildcard", pattern: content, regex: wildcardToRegex(content) };
  }

  return { raw: trimmed, type: "exact", command: content };
}

function claudeRuleMatches(rule, tokens, normalized) {
  const parsed = parseClaudePermissionRule(rule);
  if (!parsed) return false;

  switch (parsed.type) {
    case "all":
      return true;
    case "exact":
      return normalized === parsed.command;
    case "prefix":
      return tokenPrefixMatches(tokens, parsed.prefix);
    case "wildcard":
      return parsed.regex.test(normalized);
    default:
      return false;
  }
}

function firstMatchingClaudeRule(tokens, normalized, rules = []) {
  return rules.find((rule) => claudeRuleMatches(rule, tokens, normalized));
}

function normalizeBashRule(rule) {
  if (typeof rule !== "string") return rule;
  const trimmed = rule.trim();
  if (!trimmed) return trimmed;
  return /^[^()]+\(.*\)$/.test(trimmed) ? trimmed : `Bash(${trimmed})`;
}

export function firstMatchingBashRule(command, rules = [], userConfig = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, userConfig);
  const normalizedRules = rules.map(normalizeBashRule);
  const subcommands = splitShellCommand(String(command ?? "").trim());

  for (const subcommand of subcommands) {
    const tokens = normalizeTokens(tokenizeShellWords(subcommand), config);
    const normalized = tokens.join(" ");
    const match = firstMatchingClaudeRule(tokens, normalized, normalizedRules);
    if (match) return match;
  }

  return undefined;
}

export function commandMatchesBashRule(command, rules = [], userConfig = {}) {
  return firstMatchingBashRule(command, rules, userConfig) !== undefined;
}

const SYSTEM_ROOT_TARGETS = new Set([
  "/",
  "/Applications",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/Library",
  "/opt",
  "/private",
  "/sbin",
  "/System",
  "/usr",
  "/var",
  "/Volumes"
]);

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function normalizeDestructiveTarget(target) {
  if (typeof target !== "string") return "";
  let t = target.trim();
  if (!t) return t;
  while (t.length > 1 && t.endsWith("/")) t = t.slice(0, -1);
  if (t.endsWith("/*") && t.length > 2) t = t.slice(0, -2);
  while (t.startsWith("//")) t = t.slice(1);
  return t;
}

function targetLooksCatastrophic(target) {
  // Normalize trailing slashes so `rm -rf ~/`, `$HOME/`, `./`, `../`, `//`,
  // and `///` are treated the same as their slash-less catastrophic forms.
  // Stripping slashes from a real child path, e.g. `$HOME/project/`, still leaves
  // `$HOME/project`, so genuine subdirectories are not escalated to deny.
  const t = normalizeDestructiveTarget(target);
  return t === "/" || t === "/*" || t === "." || t === ".." || t === "~" || t === "$HOME" || t === "${HOME}";
}

function targetLooksLikeSystemRoot(target) {
  const t = normalizeDestructiveTarget(target);
  for (const root of SYSTEM_ROOT_TARGETS) {
    if (t === root || (root !== "/" && t.startsWith(`${root}/`))) return true;
  }
  return false;
}

function classifyRm(tokens) {
  if (tokens[0] !== "rm") return undefined;
  const args = tokens.slice(1);
  const optionTokens = [];
  const targets = [];
  let afterDoubleDash = false;

  for (const arg of args) {
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) optionTokens.push(arg);
    else targets.push(arg);
  }

  const joinedOptions = optionTokens.join(" ");
  const recursive = /(^|\s)-[^\s-]*[rR][^\s]*(\s|$)/.test(joinedOptions) || optionTokens.includes("--recursive");
  const force = /(^|\s)-[^\s-]*f[^\s]*(\s|$)/.test(joinedOptions) || optionTokens.includes("--force");

  if (optionTokens.includes("--no-preserve-root")) {
    return { behavior: "deny", reason: "rm used --no-preserve-root", allowPersistentApproval: false };
  }

  if (recursive && targets.some(targetLooksCatastrophic)) {
    return { behavior: "deny", reason: "recursive rm targets a catastrophic path", allowPersistentApproval: false };
  }

  if (recursive && targets.some(targetLooksLikeSystemRoot)) {
    return { behavior: "deny", reason: "recursive rm targets a system root", allowPersistentApproval: false };
  }

  if (recursive && force) {
    return { behavior: "ask", reason: "recursive forced rm needs confirmation", allowPersistentApproval: false };
  }

  if (recursive) {
    return { behavior: "ask", reason: "recursive rm needs confirmation", allowPersistentApproval: false };
  }

  return undefined;
}

function commandBasename(command) {
  return String(command ?? "").split("/").pop();
}

const SHELL_LONG_OPTIONS_WITH_ARG = new Set(["--init-file", "--rcfile"]);
const SHELL_SHORT_OPTIONS_WITH_ARG = new Set(["-o", "-O", "+O"]);
const SHELL_PAYLOAD_PREFIX_KEYWORDS = new Set([
  "!",
  "case",
  "do",
  "elif",
  "else",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while"
]);

function shellCommandFromTokens(tokens) {
  if (!SHELL_COMMANDS.has(commandBasename(tokens[0]))) return undefined;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") return undefined;
    if (token === "-c") return tokens[i + 1];
    if (/^-[^-].*c/.test(token)) return tokens[i + 1];

    if (token.startsWith("--")) {
      const [option] = token.split("=", 1);
      i += SHELL_LONG_OPTIONS_WITH_ARG.has(option) && !token.includes("=") ? 2 : 1;
      continue;
    }

    if (SHELL_SHORT_OPTIONS_WITH_ARG.has(token)) {
      i += 2;
      continue;
    }

    if ((token.startsWith("-") || token.startsWith("+")) && token.length > 1) {
      i++;
      continue;
    }

    return undefined;
  }
  return undefined;
}

function cleanShellPayloadToken(token) {
  let t = String(token ?? "").trim();
  while (t.startsWith("(") || t.startsWith("{")) t = t.slice(1);
  while (t.endsWith(")") || t.endsWith("}") || t.endsWith(";")) t = t.slice(0, -1);
  return t;
}

function classifyDestructiveShellTokenRun(tokens, depth) {
  const cleaned = tokens.map(cleanShellPayloadToken).filter(Boolean);
  while (cleaned.length > 0 && SHELL_PAYLOAD_PREFIX_KEYWORDS.has(cleaned[0])) cleaned.shift();
  if (cleaned.length === 0) return undefined;
  return classifyDestructiveSystemCommand(normalizeTokens(cleaned), depth + 1);
}

function shellPayloadCommandStartIndexes(tokens) {
  const indexes = new Set([0]);
  tokens.forEach((token, index) => {
    const cleaned = cleanShellPayloadToken(token);
    if (cleaned === "" || SHELL_PAYLOAD_PREFIX_KEYWORDS.has(cleaned) || token.includes("{") || token.includes("(")) {
      indexes.add(index + 1);
    }
  });
  return [...indexes].filter((index) => index < tokens.length);
}

function classifyDestructiveShellPayload(shellCommand, depth) {
  if (depth > 4) return undefined;

  for (const substitution of extractCommandSubstitutions(shellCommand)) {
    const decision = classifyDestructiveShellPayload(substitution, depth + 1);
    if (decision?.behavior === "deny") return { ...decision, reason: `command substitution contains hard-denied operation: ${decision.reason}` };
  }

  for (const subcommand of splitShellCommand(shellCommand)) {
    const rawTokens = tokenizeShellWords(subcommand);
    for (const index of shellPayloadCommandStartIndexes(rawTokens)) {
      const decision = classifyDestructiveShellTokenRun(rawTokens.slice(index), depth);
      if (decision?.behavior === "deny") return decision;
    }
  }
  return undefined;
}

function privilegedCommandTokens(tokens) {
  if (tokens[0] === "sudo") {
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") {
        i++;
        break;
      }
      if (!token.startsWith("-") || token === "-") break;
      i++;
      if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout", "-D", "--chdir", "-r", "--role", "-t", "--type"].includes(token) && i < tokens.length) i++;
    }
    return tokens.slice(i);
  }

  if (tokens[0] === "doas") {
    let i = 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === "--") {
        i++;
        break;
      }
      if (!token.startsWith("-") || token === "-") break;
      i++;
      if (["-C", "-u"].includes(token) && i < tokens.length) i++;
    }
    return tokens.slice(i);
  }

  if (tokens[0] === "su") {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if ((token === "-c" || token === "--command") && tokens[i + 1]) {
        return ["sh", "-c", tokens[i + 1]];
      }
      if (token.startsWith("--command=") && token.length > "--command=".length) {
        return ["sh", "-c", token.slice("--command=".length)];
      }
    }
  }

  return undefined;
}

function classifyChmodChown(tokens) {
  if (!["chmod", "chown"].includes(tokens[0])) return undefined;
  const recursive = tokens.some((token) => token === "-R" || token === "--recursive" || /^-[^-]*R/.test(token));
  if (!recursive) return undefined;
  const targets = tokens.slice(1).filter((token) => !token.startsWith("-") && !/^[0-7]{3,4}$/.test(token));
  if (targets.some((target) => targetLooksCatastrophic(target) || targetLooksLikeSystemRoot(target))) {
    return { behavior: "deny", reason: `${tokens[0]} recursively targets a catastrophic/system path`, allowPersistentApproval: false };
  }
  return undefined;
}

function classifyDestructiveSystemCommand(tokens, depth = 0) {
  if (depth > 4 || tokens.length === 0) return undefined;

  const rmDecision = classifyRm(tokens);
  if (rmDecision?.behavior === "deny") return rmDecision;

  const chmodDecision = classifyChmodChown(tokens);
  if (chmodDecision?.behavior === "deny") return chmodDecision;

  if (tokens[0] === "dd" && tokens.some((token) => /^of=\/dev\/(?:r?disk|sd|nvme)/.test(token))) {
    return { behavior: "deny", reason: "dd writes directly to a disk device", allowPersistentApproval: false };
  }

  if (tokens[0] === "diskutil" && ["eraseDisk", "eraseVolume", "partitionDisk", "deleteVolume", "deleteContainer"].includes(tokens[1])) {
    return { behavior: "deny", reason: `diskutil ${tokens[1]} is system-destructive`, allowPersistentApproval: false };
  }

  if (/^(?:mkfs|newfs)(?:\.|$)/.test(tokens[0]) || ["fdisk", "sfdisk", "parted"].includes(tokens[0])) {
    return { behavior: "deny", reason: `${tokens[0]} can rewrite disks/partitions`, allowPersistentApproval: false };
  }

  const shellCommand = shellCommandFromTokens(tokens);
  if (shellCommand) {
    const decision = classifyDestructiveShellPayload(shellCommand, depth);
    if (decision) return { ...decision, reason: `shell command contains hard-denied operation: ${decision.reason}` };
  }

  const privilegedTokens = privilegedCommandTokens(tokens);
  if (privilegedTokens?.length) {
    const innerTokens = normalizeTokens(privilegedTokens);
    const decision = classifyDestructiveSystemCommand(innerTokens, depth + 1);
    if (decision) return { ...decision, reason: `privileged command contains hard-denied operation: ${decision.reason}` };
  }

  return undefined;
}

function classifyGit(tokens) {
  if (tokens[0] !== "git") return undefined;
  const sub = tokens[1];
  if (!sub) return { behavior: "allow", reason: "git with no subcommand is read-only help" };

  if (["push", "commit", "pull", "fetch", "merge", "rebase", "clean"].includes(sub)) {
    return { behavior: "ask", reason: `git ${sub} needs confirmation` };
  }

  if (sub === "reset" && tokens.includes("--hard")) {
    return { behavior: "ask", reason: "git reset --hard needs confirmation" };
  }

  if (sub === "branch") {
    const dangerousFlags = new Set(["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy"]);
    if (tokens.some((token) => dangerousFlags.has(token))) {
      return { behavior: "ask", reason: "mutating git branch operation needs confirmation" };
    }
    if (tokens.length === 2 || tokens.slice(2).every((token) => token.startsWith("-"))) {
      return { behavior: "allow", reason: "read-only git branch listing" };
    }
  }

  if (sub === "checkout") {
    if (tokens[2] === "--ours" || tokens[2] === "--theirs") return undefined;
    if (tokens.includes("-f") || tokens.includes("--force")) {
      return { behavior: "ask", reason: "forced git checkout needs confirmation" };
    }
    return { behavior: "ask", reason: "git checkout can rewrite the worktree" };
  }

  return undefined;
}

function readShellWord(command, start) {
  let word = "";
  let quote = null;
  let escaped = false;
  let i = start;

  for (; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }

    if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&") break;

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    word += ch;
  }

  return { word, nextIndex: i };
}

function redirectionTargetFrom(command, start) {
  let i = start;
  if (command[i] === ">") i++;
  if (command[i] === "|") i++;

  if (command[i] === "&") {
    let fdIndex = i + 1;
    while (/\d/.test(command[fdIndex] ?? "")) fdIndex++;
    if (fdIndex > i + 1) return { target: undefined, nextIndex: fdIndex };
  }

  while (/\s/.test(command[i] ?? "")) i++;
  if (i >= command.length) return { target: "", nextIndex: i };

  const { word, nextIndex } = readShellWord(command, i);
  return { target: word, nextIndex };
}

function hasNonNullOutputRedirection(command) {
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (ch === quote) quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch !== ">") continue;

    const { target, nextIndex } = redirectionTargetFrom(command, i + 1);
    i = Math.max(i, nextIndex - 1);
    if (target === undefined) continue;
    if (target !== "/dev/null") return true;
  }

  return false;
}

function extractCommandSubstitutions(command) {
  const substitutions = [];
  let quote = null;
  let escaped = false;

  const readSubstitution = (start) => {
    let depth = 1;
    let inner = "";
    let innerQuote = null;
    let innerEscaped = false;

    for (let i = start; i < command.length; i++) {
      const ch = command[i];
      const next = command[i + 1];

      if (innerEscaped) {
        inner += ch;
        innerEscaped = false;
        continue;
      }

      if (ch === "\\") {
        inner += ch;
        innerEscaped = true;
        continue;
      }

      if (innerQuote) {
        inner += ch;
        if (ch === innerQuote) innerQuote = null;
        continue;
      }

      if (ch === "'" || ch === '"') {
        innerQuote = ch;
        inner += ch;
        continue;
      }

      if (ch === "$" && next === "(") {
        depth++;
        inner += "$";
        inner += "(";
        i++;
        continue;
      }

      if (ch === ")") {
        depth--;
        if (depth === 0) return { content: inner, end: i };
      }

      inner += ch;
    }

    return undefined;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote === "'") {
      if (ch === quote) quote = null;
      continue;
    }

    if (quote === '"') {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "$" && next === "(") {
      const substitution = readSubstitution(i + 2);
      if (substitution) {
        substitutions.push(substitution.content);
        i = substitution.end;
      }
    }
  }

  return substitutions;
}

function firstDeniedCommandSubstitution(command, config) {
  for (const substitution of extractCommandSubstitutions(command)) {
    const decision = classifyBashCommand(substitution, config);
    if (decision.behavior === "deny") return decision;
  }
  return undefined;
}

function classifySubcommand(subcommand, config) {
  const rawTokens = tokenizeShellWords(subcommand);
  const tokens = normalizeTokens(rawTokens, config);
  const normalized = tokens.join(" ");

  if (tokens.length === 0) {
    return { behavior: "allow", reason: "empty subcommand", command: subcommand, normalized };
  }

  const denyRegex = firstMatchingRegex(normalized || subcommand, config.denyRegexes);
  if (denyRegex) {
    return { behavior: "deny", reason: `matched deny regex /${denyRegex}/`, command: subcommand, normalized };
  }

  const denyPrefix = firstMatchingPrefix(tokens, config.denyPrefixes);
  if (denyPrefix) {
    return { behavior: "deny", reason: `matched deny prefix '${denyPrefix}'`, command: subcommand, normalized };
  }

  const claudeDeny = firstMatchingClaudeRule(tokens, normalized, config.claudeDenyRules);
  if (claudeDeny) {
    return { behavior: "deny", reason: `matched Claude Code deny rule '${claudeDeny}'`, command: subcommand, normalized };
  }

  const systemDestructiveDecision = classifyDestructiveSystemCommand(tokens);
  if (systemDestructiveDecision?.behavior === "deny") {
    return { ...systemDestructiveDecision, command: subcommand, normalized };
  }

  const rmDecision = classifyRm(tokens);
  if (rmDecision?.behavior === "deny" || rmDecision?.behavior === "ask") {
    return { ...rmDecision, command: subcommand, normalized };
  }

  const askRegex = firstMatchingAskRegex(normalized || subcommand, config.askRegexes, config.sandboxActive === true);
  if (askRegex) {
    return { behavior: "ask", reason: `matched ask regex /${askRegex}/`, command: subcommand, normalized };
  }

  const claudeAsk = firstMatchingClaudeRule(tokens, normalized, config.claudeAskRules);
  if (claudeAsk) {
    return { behavior: "ask", reason: `matched Claude Code ask rule '${claudeAsk}'`, command: subcommand, normalized };
  }

  const claudeAllow = firstMatchingClaudeRule(tokens, normalized, config.claudeAllowRules);
  if (claudeAllow) {
    return { behavior: "allow", reason: `matched Claude Code allow rule '${claudeAllow}'`, command: subcommand, normalized };
  }

  const gitDecision = classifyGit(tokens);
  if (gitDecision?.behavior === "deny" || gitDecision?.behavior === "ask") {
    return { ...gitDecision, command: subcommand, normalized };
  }

  const askPrefix = firstMatchingPrefix(tokens, config.askPrefixes);
  if (askPrefix) {
    return { behavior: "ask", reason: `matched ask prefix '${askPrefix}'`, command: subcommand, normalized };
  }

  if (config.sandboxActive !== true && hasNonNullOutputRedirection(subcommand)) {
    return { behavior: "ask", reason: "writes output via shell redirection", command: subcommand, normalized };
  }

  const allowPrefix = firstMatchingPrefix(tokens, config.allowPrefixes);
  if (allowPrefix) {
    return { behavior: "allow", reason: `matched allow/read-only prefix '${allowPrefix}'`, command: subcommand, normalized };
  }

  if (config.mode === "coding") {
    const acceptPrefix = firstMatchingPrefix(tokens, config.acceptEditsPrefixes);
    if (acceptPrefix) {
      return { behavior: "allow", reason: `matched coding accept-edits prefix '${acceptPrefix}'`, command: subcommand, normalized };
    }
  }

  if (gitDecision?.behavior === "allow") {
    return { ...gitDecision, command: subcommand, normalized };
  }

  return { behavior: "ask", reason: "unknown mutating command", command: subcommand, normalized };
}

function classifySafetySubcommand(subcommand, config) {
  const rawTokens = tokenizeShellWords(subcommand);
  const tokens = normalizeTokens(rawTokens, config);
  const normalized = tokens.join(" ");

  if (tokens.length === 0) {
    return { behavior: "allow", reason: "empty subcommand", command: subcommand, normalized };
  }

  const systemDestructiveDecision = classifyDestructiveSystemCommand(tokens);
  if (systemDestructiveDecision?.behavior === "deny") {
    return { ...systemDestructiveDecision, command: subcommand, normalized };
  }

  const rmDecision = classifyRm(tokens);
  if (rmDecision?.behavior === "deny" || rmDecision?.behavior === "ask") {
    return { ...rmDecision, command: subcommand, normalized };
  }

  const askRegex = firstMatchingAskRegex(normalized || subcommand, config.askRegexes, config.sandboxActive === true);
  if (askRegex) {
    return { behavior: "ask", reason: `matched ask regex /${askRegex}/`, command: subcommand, normalized };
  }

  if (config.sandboxActive !== true && hasNonNullOutputRedirection(subcommand)) {
    return { behavior: "ask", reason: "writes output via shell redirection", command: subcommand, normalized };
  }

  return { behavior: "allow", reason: "no safety prompt needed", command: subcommand, normalized };
}

export function classifyBashSafety(command, userConfig = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, userConfig);
  const trimmed = String(command ?? "").trim();
  if (!trimmed) {
    return { behavior: "allow", reason: "empty command", command: trimmed, subcommands: [] };
  }

  const rawAskRegex = firstMatchingAskRegex(trimmed, config.askRegexes, config.sandboxActive === true);
  const subcommands = splitShellCommand(trimmed).map((subcommand) => classifySafetySubcommand(subcommand, config));

  const denied = subcommands.find((part) => part.behavior === "deny");
  if (denied) {
    return { behavior: "deny", reason: denied.reason, command: trimmed, subcommands };
  }

  const asked = subcommands.find((part) => part.behavior === "ask");
  if (asked) {
    return { behavior: "ask", reason: asked.reason, command: trimmed, subcommands };
  }

  if (rawAskRegex) {
    return {
      behavior: "ask",
      reason: `matched raw ask regex /${rawAskRegex}/`,
      command: trimmed,
      subcommands
    };
  }

  return { behavior: "allow", reason: "no safety prompt needed", command: trimmed, subcommands };
}

export function classifyBashCommand(command, userConfig = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, userConfig);
  const trimmed = String(command ?? "").trim();
  if (!trimmed) {
    return { behavior: "allow", reason: "empty command", command: trimmed, subcommands: [] };
  }

  const rawDenyRegex = firstMatchingRegex(trimmed, config.denyRegexes);
  if (rawDenyRegex) {
    return {
      behavior: "deny",
      reason: `matched raw deny regex /${rawDenyRegex}/`,
      command: trimmed,
      subcommands: []
    };
  }

  const rawAskRegex = firstMatchingAskRegex(trimmed, config.askRegexes, config.sandboxActive === true);
  const deniedSubstitution = firstDeniedCommandSubstitution(trimmed, config);
  if (deniedSubstitution) {
    return {
      behavior: "deny",
      reason: `command substitution contains denied command: ${deniedSubstitution.reason}`,
      command: trimmed,
      subcommands: deniedSubstitution.subcommands ?? []
    };
  }

  const subcommands = splitShellCommand(trimmed).map((subcommand) => classifySubcommand(subcommand, config));

  const denied = subcommands.find((part) => part.behavior === "deny");
  if (denied) {
    return { behavior: "deny", reason: denied.reason, command: trimmed, subcommands };
  }

  const asked = subcommands.find((part) => part.behavior === "ask");
  if (asked) {
    return { behavior: "ask", reason: asked.reason, command: trimmed, subcommands };
  }

  if (rawAskRegex) {
    return {
      behavior: "ask",
      reason: `matched raw ask regex /${rawAskRegex}/`,
      command: trimmed,
      subcommands
    };
  }

  return { behavior: "allow", reason: "all subcommands allowed", command: trimmed, subcommands };
}

export function suggestClaudeAllowRule(decision) {
  const target = decision.subcommands?.find((part) => part.behavior === "ask") ?? decision.subcommands?.[0];
  if (target?.allowPersistentApproval === false) return undefined;

  const normalized = target?.normalized || target?.command || decision.command;
  const tokens = tokenizeShellWords(normalized);
  if (tokens.length === 0) return undefined;

  let prefix;
  if (tokens[0] === "git" && tokens[1]) {
    prefix = `git ${tokens[1]}:*`;
  } else if (["npm", "pnpm", "yarn", "bun"].includes(tokens[0]) && tokens[1] === "run") {
    prefix = `${tokens[0]} run:*`;
  } else {
    prefix = `${tokens[0]}:*`;
  }

  return `Bash(${prefix})`;
}

export function formatDecision(decision) {
  const lines = [
    `${decision.behavior.toUpperCase()}: ${decision.reason}`,
    `Command: ${decision.command}`
  ];

  if (decision.subcommands?.length) {
    lines.push("Subcommands:");
    for (const part of decision.subcommands) {
      const normalized = part.normalized && part.normalized !== part.command ? ` [${part.normalized}]` : "";
      lines.push(`- ${part.behavior}: ${part.command}${normalized} — ${part.reason}`);
    }
  }

  return lines.join("\n");
}
