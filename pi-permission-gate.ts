/**
 * Pi Permission Gate Extension
 *
 * Uses ctx.modelRegistry.complete() (the coding-agent model runtime) to classify
 * bash commands and MCP tool calls by risk level and require user confirmation
 * before executing potentially harmful ones. The runtime resolves auth (apiKey,
 * headers, env, baseUrl) and credential-resolved endpoints internally, so
 * OAuth-only providers (Claude Pro/Max, ChatGPT Plus, Copilot) and env-scoped
 * provider configs classify correctly, not just API-key providers.
 *
 * Instead of maintaining a long list of regex patterns, this extension
 * asks a fast, cheap model to judge each command. The LLM returns a
 * structured verdict with a risk level and explanation.
 *
 * CWD-Aware Classification:
 *   The current working directory (CWD) is passed to the LLM via both
 *   the system prompt guidelines and the user prompt, enabling the LLM
 *   to treat project-local operations (e.g., rm -rf ./build, npm install)
 *   as less risky than system-wide equivalents. No post-check heuristics
 *   or risk-downgrading logic — the LLM makes CWD-aware judgments directly.
 *
 * Configuration (precedence: settings.json > default):
 *
 *   ~/.pi/agent/settings.json "permissionGate" block:
 *     {
 *       "permissionGate": {
 *         "model": "anthropic/claude-sonnet-4-5",
 *         "blockLevel": "low",
 *         "maxTokens": 4096,
 *         "temperature": 0,
 *         "timeout": 10000,
 *         "thinkingLevel": "low"
 *       }
 *     }
 *
 *   Fields:
 *   model        - Model for classification (format: "provider/modelId" or bare id; default: session model)
 *   blockLevel   - Minimum risk level to block: "low" | "medium" | "high" (default: "low")
 *     "low"    = block on any risk (safest, most confirmations)
 *     "medium" = block on medium and high risk
 *     "high"   = only block on high risk (fewest confirmations)
 *   timeout      - Timeout in ms for the LLM call (default: 10000)
 *   fallback     - What to do if LLM fails: "allow" | "block" | "confirm" (default: "confirm")
 *   maxTokens    - Maximum tokens for the LLM classification call (default: 4096)
 *   temperature  - Sampling temperature for classification, e.g. 0 or 0.1 (optional)
 *   thinkingLevel - Reasoning effort passed to the classifier as `reasoning`:
 *     "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" (optional).
 *     Passed through pi-ai's clampThinkingLevel; no-op on models whose
 *     thinkingLevelMap floors every level (e.g. bitdeerai DeepSeek-V4-Pro
 *     maps low/medium/high -> "high"). Omit to let the model run its default.
 */

import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
	type Model,
	type Api,
	type Context,
	type ThinkingLevel,
	type ModelThinkingLevel,
	contentText,
	parseJsonWithRepair,
} from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";


// Risk levels, ordered from least to most severe
export const RISK_LEVELS = ["safe", "low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

// Risk levels that reach a user-facing confirm prompt (safe is auto-allowed).
// Icons carry severity at a glance across prompt title, notify body, and status.
export type ConfirmRisk = Exclude<RiskLevel, "safe"> | "unknown";
export const RISK_ICON: Record<ConfirmRisk, string> = {
	low: "🟡",
	medium: "🟠",
	high: "🔴",
	unknown: "⚪",
};

export interface Verdict {
	risk: RiskLevel;
	reason: string;
}

// Reason strings are part of the log contract and the test contract; export them
// so the handler can detect parse-failure verdicts without string-matching.
export const PARSE_FAILURE_REASON = "Could not parse LLM verdict";
export const EMPTY_RESPONSE_REASON = "LLM returned empty response";

const SYSTEM_PROMPT = `You are a command safety classifier. You analyze shell commands and determine their risk level.

Respond with EXACTLY this JSON format and nothing else:
{"risk":"safe|low|medium|high","reason":"brief explanation"}

Risk levels:
- safe: Read-only or harmless operations (ls, cat, echo, pwd, which, node -v, git status, git log, etc.)
- low: Minor side effects that are easily reversible or low-impact, including CWD-scoped deletions and modifications (rm -rf ./build, rm -rf ./dist, rm ./temp.log, git add, git commit, npm install, pip install, mkdir ./dir, touch ./file, cp ./a ./b, mv ./a ./b, git checkout, git switch, git stash, kubectl get, kubectl describe, helm list, helm status)
- medium: Significant changes that could affect the system or data, including operations affecting paths outside CWD but not system-critical (rm -rf ../other-project, git push, kubectl apply, helm install, helm upgrade, npm publish, ALTER TABLE with WHERE, DELETE with WHERE, UPDATE with WHERE, docker rm, docker rmi, pip uninstall)
- high: Destructive, irreversible, or security-sensitive operations, including system-wide or irreversible operations, or operations outside CWD that affect system state (rm -rf /etc, sudo, DROP TABLE, TRUNCATE, DELETE without WHERE, UPDATE without WHERE, git push --force, kubectl delete, shutdown, reboot, mkfs, dd, iptables, chmod 777)

MCP tool call context:
- You may also be asked to analyze MCP (Model Context Protocol) tool calls
- MCP read/search/list/describe operations (e.g. web_search, web_fetch, search, list, get, describe) are generally safe or low risk
- MCP write/modify/create/send operations (e.g. create_issue, update, delete, send_notification, publish, apply) are at least medium risk
- MCP operations affecting production infrastructure or external systems (e.g. deploy, release, provision) are at least medium risk
- Destructive MCP operations (delete, remove, drop, terminate, purge, uninstall) are high risk
- Consider the target server: a notification server sending alerts is lower risk than a database server dropping tables

Working directory context:
- You will be given the current working directory (CWD)
- Commands whose effects are contained within the CWD are less risky than system-wide equivalents
- Deleting files/dirs under CWD (e.g., rm -rf ./build, rm -rf ./node_modules) is low risk — it only affects the project, not the system
- Modifying project-local files (e.g., ./src, ./config, ./data within CWD) is low risk
- Commands targeting paths outside CWD or system paths (/etc, /usr, /var, /opt, ~, /) retain their normal risk level
- Package installs (npm install, pip install) within CWD are low risk
- Docker/container operations that only affect project containers are medium risk (still affects runtime)

Important guidelines:
- Analyze the FULL command including all flags and arguments
- Consider chained commands (&&, ||, ;) - rate by the most dangerous segment
- Shell variable expansion and command substitution should raise suspicion slightly since content is unknown
- Piping data into destructive commands is high risk
- Commands that modify live infrastructure (k8s, databases) are at least medium
- When in doubt, rate one level higher rather than lower
- Be concise in your reason - one short sentence max`;

export function riskLevelIndex(level: RiskLevel): number {
	return RISK_LEVELS.indexOf(level);
}

/**
 * Truncate a string to `max` characters, appending an ellipsis if cut.
 * Used for the bash display signature (command prefix).
 */
export function truncateToChars(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + "…";
}

/** Opaque ID-looking strings (UUIDs, Atlassian account IDs, hex hashes) — noise to a human reader. */
const ID_LIKE_RE = /^[0-9a-fA-F-]{16,}$/;
function isIdLike(s: string): boolean {
	return s.length >= 16 && ID_LIKE_RE.test(s);
}

const SIG_VAL_MAX_CHARS = 60;

/**
 * Format a scalar arg value for the display signature, or undefined to drop it
 * (objects, arrays, long strings, opaque IDs, empty values). Dropped values
 * count toward the `+N more` suffix.
 */
function formatSmallValue(val: unknown): string | undefined {
	if (typeof val === "boolean") return String(val);
	if (typeof val === "number" && Number.isFinite(val)) return String(val);
	if (typeof val === "string") {
		if (val.length === 0) return undefined;
		if (val.length > SIG_VAL_MAX_CHARS) return undefined;
		if (isIdLike(val)) return undefined;
		return JSON.stringify(val);
	}
	return undefined;
}

/** Parse `args` (object or JSON string) into a record, or undefined. */
function parseArgsObject(args: unknown): Record<string, unknown> | undefined {
	if (args && typeof args === "object" && !Array.isArray(args)) {
		return args as Record<string, unknown>;
	}
	if (typeof args === "string" && args.trim()) {
		try {
			const parsed = parseJsonWithRepair(args);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// not JSON — fall through
		}
	}
	return undefined;
}

/**
 * Build a compact display signature for the permission prompt. The full command
 * is already rendered by pi at execution time; this signature only needs to
 * identify which operation this is (the link handle) and surface small scalar
 * arg values. Long free-text values (e.g. a Jira ticket `description` body) and
 * opaque IDs are dropped with a `+N more` count so the user knows the detail
 * lives in pi's render. The classifier LLM still sees the full command — this
 * is display-only.
 */
export function buildDisplaySignature(
	toolName: string,
	input: Record<string, unknown>,
): string {
	if (toolName === "bash") {
		const cmd = (input?.command as string) ?? "";
		return truncateToChars(cmd.replace(/\n/g, " "), 80);
	}
	if (toolName === "mcp") {
		const server =
			typeof input?.server === "string" && input.server.trim() ? input.server : undefined;
		const tool =
			typeof input?.tool === "string" && input.tool.trim() ? input.tool : "mcp";
		const argsObj = parseArgsObject(input?.args);
		const prefix = server ? `${server}/${tool}` : tool;
		if (!argsObj) return prefix;
		const keys = Object.keys(argsObj);
		if (keys.length === 0) return prefix;
		const parts: string[] = [];
		let more = 0;
		for (const k of keys) {
			const v = formatSmallValue(argsObj[k]);
			if (v !== undefined) parts.push(`${k}=${v}`);
			else more++;
		}
		const moreSuffix = more > 0 ? `, +${more} more` : "";
		if (parts.length === 0) return `${prefix}(+${more} more)`;
		return `${prefix}(${parts.join(", ")}${moreSuffix})`;
	}
	return toolName;
}

export function stripCodeFences(raw: string): string {
	let text = raw.trim();
	// Strip markdown code fences: ```json ... ``` or ``` ... ```
	text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
	return text.trim();
}

/**
 * Try to parse `text` as a Verdict-shaped JSON object.
 * Returns undefined if `text` is not JSON or does not have a valid
 * {risk, reason} shape. Uses parseJsonWithRepair so malformed control
 * chars / bad escapes inside an otherwise-valid JSON body are tolerated.
 */
function tryParseVerdict(text: string): Verdict | undefined {
	let parsed: { risk?: unknown; reason?: unknown } | undefined;
	try {
		parsed = parseJsonWithRepair(text);
	} catch {
		return undefined;
	}
	if (
		parsed &&
		typeof parsed.risk === "string" &&
		RISK_LEVELS.includes(parsed.risk as RiskLevel) &&
		typeof parsed.reason === "string"
	) {
		return parsed as Verdict;
	}
	return undefined;
}

/**
 * Yield every balanced {...} span in `text`, in order of each opening brace.
 *
 * Reasoning models (MiniMax-M3, DeepSeek-V4-Pro) wrap the JSON verdict in
 * thinking prose and may include braces inside that prose. A single regex
 * cannot robustly extract the JSON object: it breaks on nested braces,
 * reversed key order, or braces inside string values. Instead, for every
 * `{`, scan forward to its matching `}` (depth-tracked from that brace) and
 * yield the span. parseJsonWithRepair then validates each candidate — JSON
 * parses handle braces inside string literals correctly, so the scanner does
 * not need to be string-aware; it only needs to produce plausible spans.
 */
function* extractJsonCandidates(text: string): Iterable<string> {
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue;
		let depth = 0;
		for (let j = i; j < text.length; j++) {
			const ch = text[j];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					yield text.slice(i, j + 1);
					break;
				}
			}
		}
	}
}

export function parseVerdict(raw: string): Verdict {
	const cleaned = stripCodeFences(raw);
	// Empty / whitespace-only response is a distinct failure mode from parse
	// failure — the model may have spent its entire budget on untracked reasoning
	// and emitted nothing visible (observed on MiniMax-M3 with long prompts).
	if (!cleaned) {
		return { risk: "medium", reason: EMPTY_RESPONSE_REASON };
	}

	// Fast path: the whole cleaned text is the JSON object (possibly with
	// control chars / bad escapes that parseJsonWithRepair repairs).
	const direct = tryParseVerdict(cleaned);
	if (direct) return direct;

	// Fallback: extract every balanced {...} candidate and try each. Handles
	// JSON wrapped in prose, braces in reasoning text, and reversed key order.
	for (const candidate of extractJsonCandidates(cleaned)) {
		const v = tryParseVerdict(candidate);
		if (v) return v;
	}

	return { risk: "medium", reason: PARSE_FAILURE_REASON };
}

function logCommandDecision(
	command: string,
	risk: RiskLevel,
	blockLevel: RiskLevel,
	decision: "allowed" | "blocked" | "confirmed",
	reason?: string,
	rawResponse?: string,
): void {
	const timestamp = new Date().toISOString();
	const entry: Record<string, unknown> = {
		timestamp,
		command,
		risk,
		blockLevel,
		decision,
		reason,
	};
	// Attach the raw LLM response only when the parser could not extract a
	// verdict, so successful classifications don't bloat the log. Cap at 2000
	// chars — enough to diagnose format drift without unbounded growth from
	// reasoning-model thinking traces.
	if (rawResponse !== undefined) {
		entry.rawResponse = rawResponse.length > 2000
			? rawResponse.slice(0, 2000) + "…[truncated]"
			: rawResponse;
	}
	const logLine = JSON.stringify(entry) + "\n";

	const logFile = path.join(process.env.HOME || "/tmp", ".pi", "pi-permission-gate.jsonl");
	try {
		const dir = path.dirname(logFile);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.appendFileSync(logFile, logLine, { encoding: "utf-8" });
	} catch {
		// Silently fail if we can't write to log
	}
}

/**
 * Read the permissionGate block from settings.json in one read (one file
 * read, one JSON parse per tool_call — not five). Returns the typed fields
 * the caller derives config from; env-var precedence is applied by the
 * caller, not here. Empty record if the block is absent.
 */
interface PermissionGateConfig {
	model?: string;
	blockLevel?: RiskLevel;
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	fallback?: "allow" | "block" | "confirm";
	thinkingLevel?: ModelThinkingLevel;
}

const FALLBACK_LEVELS = ["allow", "block", "confirm"] as const;

function readPermissionGateConfig(cwd: string, agentDir: string): PermissionGateConfig {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	// SettingsManager doesn't expose custom keys, so read the raw global settings
	const globalSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
	const gate = globalSettings.permissionGate as Record<string, unknown> | undefined;
	if (!gate) return {};
	const config: PermissionGateConfig = {};
	if (typeof gate.model === "string") config.model = gate.model;
	if (typeof gate.blockLevel === "string" && RISK_LEVELS.includes(gate.blockLevel as RiskLevel)) {
		config.blockLevel = gate.blockLevel as RiskLevel;
	}
	if (typeof gate.maxTokens === "number") config.maxTokens = gate.maxTokens;
	if (typeof gate.temperature === "number") config.temperature = gate.temperature;
	if (typeof gate.timeout === "number") config.timeout = gate.timeout;
	if (typeof gate.fallback === "string" && FALLBACK_LEVELS.includes(gate.fallback as "allow" | "block" | "confirm")) {
		config.fallback = gate.fallback as "allow" | "block" | "confirm";
	}
	// thinkingLevel is not validated against a static list. pi-ai's
	// clampThinkingLevel(model, level) clamps to the model's supported levels
	// at the provider layer, so any ModelThinkingLevel string is safe here.
	if (typeof gate.thinkingLevel === "string") {
		config.thinkingLevel = gate.thinkingLevel as ModelThinkingLevel;
	}
	return config;
}

/**
 * Resolve a model from the permissionGate.model setting.
 * Accepts "provider/modelId" format (e.g., "anthropic/claude-sonnet-4-5")
 * or a bare model id that's searched across providers.
 * Returns undefined if no model is configured (caller should fall back to ctx.model).
 */
async function resolveModel(
	modelSpec: string | undefined,
	modelRegistry: ModelRegistry,
): Promise<Model<Api> | undefined> {
	if (!modelSpec) return undefined;

	// Support "provider/modelId" format
	const slashIdx = modelSpec.indexOf("/");
	if (slashIdx !== -1) {
		const provider = modelSpec.slice(0, slashIdx);
		const modelId = modelSpec.slice(slashIdx + 1);
		const model = modelRegistry.find(provider, modelId);
		if (!model) {
			throw new Error(
				`Model not found: ${modelSpec}. Available models: ${modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`).join(", ")}`,
			);
		}
		return model;
	}

	// Bare model id — search across all providers
	const available = modelRegistry.getAvailable();
	const exactMatch = available.find((m) => m.id === modelSpec);
	if (exactMatch) return exactMatch;

	// Partial/fuzzy match on model id or name
	const partialMatches = available.filter(
		(m) =>
			m.id.toLowerCase().includes(modelSpec.toLowerCase()) ||
			(m.name && m.name.toLowerCase().includes(modelSpec.toLowerCase())),
	);
	if (partialMatches.length === 1) return partialMatches[0];
	if (partialMatches.length > 1) {
		throw new Error(
			`Ambiguous model "${modelSpec}" matches: ${partialMatches.map((m) => `${m.provider}/${m.id}`).join(", ")}. Use provider/modelId format.`,
		);
	}

	throw new Error(
		`Model not found: ${modelSpec}. Available models: ${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
	);
}

/**
 * Classify a tool operation via ctx.modelRegistry.complete(). Sends a
 * single-shot LLM request with the safety classifier system prompt and
 * returns the parsed verdict. The runtime resolves auth and endpoints.
 */
async function classifyCommand(
	command: string,
	cwd: string,
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	timeout: number,
	signal: AbortSignal | undefined,
	options: { maxTokens?: number; temperature?: number; reasoning?: ModelThinkingLevel },
): Promise<{ verdict: Verdict; rawResponse: string }> {
	// Fallback to process CWD if ctx.cwd is missing
	if (!cwd) {
		cwd = process.cwd();
	}

	const context: Context = {
		systemPrompt: SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: `Analyze this operation for safety: ${command}\n\nCurrent working directory: \`${cwd}\``,
				timestamp: Date.now(),
			},
		],
	};

	// Apply timeout via a combined AbortController
	let timedOut = false;
	const timeoutController = new AbortController();

	const timer = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, timeout);

	// Forward user's abort signal to the timeout controller
	const onAbort = () => timeoutController.abort();
	if (signal) {
		if (signal.aborted) {
			timeoutController.abort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	try {
		// `reasoning` carries a ModelThinkingLevel ("off"|"minimal"|...|"max").
		// SimpleStreamOptions.reasoning is typed as ThinkingLevel (no "off"), but
		// pi-ai's runtime — clampThinkingLevel + the openai-completions
		// reasoningEffort derivation — accepts "off" and maps it to no
		// reasoning_effort sent. Cast bridges the narrower TS type.
		const response = await modelRegistry.complete(model, context, {
			...options,
			reasoning: options.reasoning as ThinkingLevel | undefined,
			signal: timeoutController.signal,
		});

		// Extract text from the assistant response
		const responseText = contentText(response.content);
		if (!responseText) {
			throw new Error("LLM classification returned empty response");
		}
		return { verdict: parseVerdict(responseText), rawResponse: responseText };
	} catch (err) {
		if (timedOut) {
			throw new Error("LLM classification timed out");
		}
		if (signal?.aborted) {
			throw new Error("LLM classification aborted");
		}
		throw err;
	} finally {
		clearTimeout(timer);
		if (signal) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

interface ConfirmOptions {
	risk: ConfirmRisk;
	notifyBody: string;
	promptTitle: string;
	promptBody: string;
	blockedLogReason: string;
	confirmedLogReason: string;
	blockReason: string;
}

// ---------------------------------------------------------------------------
// Pure decisions (extracted from the tool_call handler so the matrices are
// behaviorally testable with no ExtensionAPI fake). The handler owns I/O only:
// classify, log per the action's log fields, prompt via confirmWithUser, and
// emit the block lifecycle. Each action carries the log-contract strings so
// tests can lock them without mocking logCommandDecision.
// ---------------------------------------------------------------------------

/**
 * Action returned by decideFallback when the classifier threw. The handler
 * logs once per allow/block branch (confirm-path logging lives inside
 * confirmWithUser) using the carried logDecision/logReason.
 */
export type FallbackAction =
	| { kind: "allow"; logDecision: "allowed"; logReason: string }
	| { kind: "block"; blockReason: string; logDecision: "blocked"; logReason: string }
	| { kind: "confirm"; opts: ConfirmOptions };

/**
 * Action returned by decideThreshold when the classifier succeeded. logRawResponse
 * flags whether the handler should attach rawResponse to the log (parse-failure
 * only); the handler materializes rawForLog = logRawResponse ? rawResponse : undefined
 * for the log call / confirmWithUser.
 */
export type ThresholdAction =
	| { kind: "allow"; log: { risk: RiskLevel; decision: "allowed"; reason: string; logRawResponse: boolean } }
	| { kind: "block"; blockReason: string; log: { risk: RiskLevel; decision: "blocked"; reason: string; logRawResponse: boolean } }
	| { kind: "confirm"; opts: ConfirmOptions; logRawResponse: boolean };

/**
 * Pure fallback decision. config carries the three knobs that branch the
 * matrix: fallback policy, hasUI, and blockLevel (for the logDecision/logReason
 * fields). errDetail threads through to the confirm-prompt opts only.
 *
 * Six cells (fallback × hasUI):
 *   allow                       → allow
 *   block, !hasUI               → block (headless reason)
 *   block, hasUI                → block (UI reason)
 *   confirm, !hasUI             → block (headless can't prompt; safety-favoring)
 *   confirm, hasUI              → confirm (unknown-risk prompt)
 */
export function decideFallback(
	errDetail: string,
	config: { blockLevel: RiskLevel; fallback: string; hasUI: boolean },
): FallbackAction {
	const { blockLevel, fallback, hasUI } = config;
	if (fallback === "allow") {
		return { kind: "allow", logDecision: "allowed", logReason: "Fallback allow after LLM failure" };
	}
	if (fallback === "block") {
		if (!hasUI) {
			return {
				kind: "block",
				blockReason: "Operation blocked: AI safety check failed",
				logDecision: "blocked",
				logReason: "Fallback block after LLM failure",
			};
		}
		return {
			kind: "block",
			blockReason: "Operation blocked: AI safety check failed and fallback is set to block",
			logDecision: "blocked",
			logReason: "Fallback block after LLM failure",
		};
	}
	// fallback === "confirm"
	if (!hasUI) {
		// Headless can't prompt, so block rather than silently allow — the
		// safety-favoring choice when the classifier fails and confirmation is
		// impossible. When in doubt and the user can't weigh in, block.
		return {
			kind: "block",
			blockReason: "Operation blocked: AI safety check failed (headless mode cannot confirm)",
			logDecision: "blocked",
			logReason: "Fallback confirm without UI — blocked",
		};
	}
	return {
		kind: "confirm",
		opts: {
			risk: "unknown",
			notifyBody: `Permission gate failed: ${errDetail}`,
			promptTitle: "AI safety check failed",
			promptBody: `The LLM could not classify this operation: ${errDetail}`,
			blockedLogReason: "Blocked by user (AI check failed)",
			confirmedLogReason: "User confirmed after AI check failed",
			blockReason: "Blocked by user (AI check failed)",
		},
	};
}

/** logRawResponse rule: attach rawResponse to the log only on parse failure. */
function shouldLogRawResponse(verdict: Verdict): boolean {
	return verdict.reason === PARSE_FAILURE_REASON || verdict.reason === EMPTY_RESPONSE_REASON;
}

/**
 * Pure threshold decision. config carries blockLevel and hasUI. The safe-edge
 * carve-out (risk === "safe" → allow even at blockLevel="safe" threshold 0) is
 * preserved and under test. rawResponse is NOT threaded here — the handler
 * materializes rawForLog from logRawResponse + the classifyCommand result.
 */
export function decideThreshold(
	verdict: Verdict,
	config: { blockLevel: RiskLevel; hasUI: boolean; notifyLabel: string },
): ThresholdAction {
	const { blockLevel, hasUI, notifyLabel } = config;
	const blockThreshold = riskLevelIndex(blockLevel);
	const commandRisk = riskLevelIndex(verdict.risk);
	const logRawResponse = shouldLogRawResponse(verdict);

	const shouldBlock = commandRisk >= blockThreshold && verdict.risk !== "safe";
	if (!shouldBlock) {
		return {
			kind: "allow",
			log: { risk: verdict.risk, decision: "allowed", reason: verdict.reason, logRawResponse },
		};
	}

	if (!hasUI) {
		return {
			kind: "block",
			blockReason: `Permission gate blocked this operation (risk: ${verdict.risk}): ${verdict.reason}. Do not retry or work around it. Report exactly what you needed to run and why to your caller, then stop.`,
			log: { risk: verdict.risk, decision: "blocked", reason: verdict.reason, logRawResponse },
		};
	}

	return {
		kind: "confirm",
		opts: {
			risk: verdict.risk,
			notifyBody: `Permission gate: ${verdict.risk} risk — ${notifyLabel}`,
			promptTitle: `Potentially dangerous operation (${verdict.risk} risk)`,
			promptBody: verdict.reason,
			blockedLogReason: "Blocked by user",
			confirmedLogReason: verdict.reason,
			blockReason: "Blocked by user",
		},
		logRawResponse,
	};
}

/**
 * Emit user-input:blocked (open) + set the TUI footer pill, then prompt the
 * user to allow/deny an operation. Wraps ctx.ui.select() in try/finally so the
 * close emit + pill clear always fire (user answer, abort, or error). A
 * co-loaded user-input:blocked consumer fires the ctx-less transports.
 * Returns {block:true} on denial, undefined on allow.
 */
async function confirmWithUser(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	displaySignature: string,
	blockLevel: RiskLevel,
	opts: ConfirmOptions,
	rawResponse?: string,
): Promise<{ block: true; reason: string } | undefined> {
	const icon = RISK_ICON[opts.risk];
	const statusKey = "pi-permission-gate";
	const statusText = `${icon} awaiting input`;
	const label = `${icon} ${opts.notifyBody}`;
	// Open block: TUI footer pill (producer-owned, ctx-bound) + bus event
	// (consumer fires the ctx-less transports). The open/close pair must stay
	// balanced in this try/finally.
	try {
		try {
			const theme = ctx.ui.theme;
			if (theme?.fg) ctx.ui.setStatus(statusKey, theme.fg("accent", statusText));
		} catch {
			// pi-web: theme proxy can throw before initTheme — best-effort
		}
		pi.events.emit("user-input:blocked", { active: true, label, status: { key: statusKey, text: statusText } });
		const choice = await ctx.ui.select(
			`${icon} ${opts.promptTitle}\n\n  ${displaySignature}\n\n${opts.promptBody}\n\nAllow?`,
			["Yes", "No"],
		);
		if (choice !== "Yes") {
			logCommandDecision(command, opts.risk, blockLevel, "blocked", opts.blockedLogReason, rawResponse);
			return { block: true, reason: opts.blockReason };
		}
		logCommandDecision(command, opts.risk, blockLevel, "confirmed", opts.confirmedLogReason, rawResponse);
		return undefined;
	} finally {
		try {
			ctx.ui.setStatus?.(statusKey, undefined);
		} catch {
			// best-effort
		}
		pi.events.emit("user-input:blocked", { active: false, statusKey });
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		let command: string;
		if (event.toolName === "bash") {
			command = event.input.command as string;
			if (!command?.trim()) return undefined;
		} else if (event.toolName === "mcp") {
			const server = event.input.server as string;
			const tool = event.input.tool as string;
			const args = event.input.args as Record<string, unknown> | string | undefined;
			let argsStr: string;
			if (typeof args === "string") {
				argsStr = args;
			} else if (args && Object.keys(args).length > 0) {
				argsStr = JSON.stringify(args);
			} else {
				argsStr = "{}";
			}
			command = `MCP tool call: server="${server}", tool="${tool}", args=${argsStr}`;
		} else {
			return undefined;
		}

		const signature = buildDisplaySignature(
			event.toolName,
			event.input as Record<string, unknown>,
		);
		const notifyLabel =
			event.toolName === "mcp"
				? (typeof event.input.tool === "string" && event.input.tool
					? event.input.tool
					: "mcp")
				: event.toolName;

		// Load settings: settings.json > default. Read once; derive each field.
		const settings = readPermissionGateConfig(ctx.cwd, `${process.env.HOME}/.pi/agent`);
		const modelSpec = settings.model ?? undefined;
		const blockLevel = settings.blockLevel ?? "low";
		const timeout = settings.timeout ?? 10000;
		const fallback = settings.fallback ?? "confirm";
		const maxTokens = settings.maxTokens ?? 4096;
		const temperature = settings.temperature;
		const thinkingLevel = settings.thinkingLevel;

		let verdict: Verdict;
		let rawResponse: string | undefined;
		try {
			// Use the configured classifier model, falling back to the session's
			// current model as last resort.
			const model = (await resolveModel(modelSpec, ctx.modelRegistry)) ?? ctx.model;
			if (!model) {
				throw new Error("No model available for classification");
			}

			const result = await classifyCommand(
				command,
				ctx.cwd,
				model,
				ctx.modelRegistry,
				timeout,
				ctx.signal,
				{
					maxTokens,
					...(temperature !== undefined && { temperature }),
					...(thinkingLevel !== undefined && { reasoning: thinkingLevel }),
				},
			);
			verdict = result.verdict;
			rawResponse = result.rawResponse;
		} catch (err) {
			// LLM call failed — decide the fallback action (pure), then the handler
			// does the I/O: one log per allow/block branch; confirm delegates to
			// confirmWithUser (which logs blocked/confirmed itself).
			const errDetail = err instanceof Error ? err.message : String(err);
			console.error(`[pi-permission-gate] Classification failed: ${errDetail}`);
			if (ctx.hasUI) {
				ctx.ui.notify(`Permission gate error: ${errDetail}`, "error");
			}
			const action = decideFallback(errDetail, { blockLevel, fallback, hasUI: ctx.hasUI });
			if (action.kind === "allow") {
				logCommandDecision(command, "unknown", blockLevel, action.logDecision, action.logReason);
				return undefined;
			}
			if (action.kind === "block") {
				logCommandDecision(command, "unknown", blockLevel, action.logDecision, action.logReason);
				return { block: true, reason: action.blockReason };
			}
			return confirmWithUser(pi, ctx, command, signature, blockLevel, action.opts);
		}

		// Classifier succeeded — decide on the verdict (pure), then the handler
		// does the I/O. rawForLog threads rawResponse only on parse failure.
		const action = decideThreshold(verdict, { blockLevel, hasUI: ctx.hasUI, notifyLabel });
		const rawForLog = action.logRawResponse ? rawResponse : undefined;
		if (action.kind === "allow") {
			logCommandDecision(command, action.log.risk, blockLevel, action.log.decision, action.log.reason, rawForLog);
			return undefined;
		}
		if (action.kind === "block") {
			logCommandDecision(command, action.log.risk, blockLevel, action.log.decision, action.log.reason, rawForLog);
			return { block: true, reason: action.blockReason };
		}
		return confirmWithUser(pi, ctx, command, signature, blockLevel, action.opts, rawForLog);
	});
}
