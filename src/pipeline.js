import {
  classifyBashCommand,
  classifyBashSafety,
  firstMatchingBashRule,
  mergeConfig,
  DEFAULT_CONFIG,
  suggestClaudeAllowRule
} from "./policy.js";

function fallbackSuggestedRule(command, config) {
  return suggestClaudeAllowRule(classifyBashCommand(command, { ...config, sandboxActive: false }));
}

function sandboxIsEnabled(config) {
  return config.sandbox?.enabled !== false;
}

export function decide(command, { config = {}, dangerouslyDisableSandbox = false, sandboxAvailable = false } = {}) {
  const merged = mergeConfig(DEFAULT_CONFIG, config);
  const sandboxActive = sandboxIsEnabled(merged) && sandboxAvailable;
  const policyConfig = { ...merged, sandboxActive };

  const denyDecision = classifyBashCommand(command, policyConfig);
  if (denyDecision.behavior === "deny") {
    return { action: "deny", reason: denyDecision.reason };
  }

  const safetyDecision = classifyBashSafety(command, policyConfig);
  if (safetyDecision.behavior === "ask") {
    return { action: "safety-ask", reason: safetyDecision.reason };
  }

  const allowRule = firstMatchingBashRule(command, merged.claudeAllowRules, merged);

  if (dangerouslyDisableSandbox === true) {
    if (allowRule) {
      return { action: "run-unsandboxed", reason: `matched Claude Code allow rule '${allowRule}'` };
    }
    return {
      action: "ask-unsandboxed",
      reason: "dangerouslyDisableSandbox requested",
      suggestedRule: fallbackSuggestedRule(command, merged)
    };
  }

  const askRule = firstMatchingBashRule(command, merged.claudeAskRules, merged);
  if (askRule) {
    return {
      action: "ask-unsandboxed",
      reason: `matched Claude Code ask rule '${askRule}'`,
      suggestedRule: fallbackSuggestedRule(command, merged)
    };
  }

  if (allowRule) {
    return { action: "run-unsandboxed", reason: `matched Claude Code allow rule '${allowRule}'` };
  }

  const excludedRule = firstMatchingBashRule(command, merged.sandbox?.excludedCommands ?? [], merged);
  if (excludedRule) {
    return {
      action: "ask-unsandboxed",
      reason: `matched sandbox excluded command '${excludedRule}'`,
      suggestedRule: fallbackSuggestedRule(command, merged)
    };
  }

  if (sandboxActive) {
    return { action: "run-sandboxed" };
  }

  const fallbackDecision = classifyBashCommand(command, { ...merged, sandboxActive: false });
  if (fallbackDecision.behavior === "allow") {
    return { action: "run-unsandboxed", reason: fallbackDecision.reason };
  }
  if (fallbackDecision.behavior === "deny") {
    return { action: "deny", reason: fallbackDecision.reason };
  }
  return {
    action: "ask-unsandboxed",
    reason: fallbackDecision.reason,
    suggestedRule: suggestClaudeAllowRule(fallbackDecision)
  };
}
