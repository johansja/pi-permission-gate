/**
 * Tests for the Pi Permission Gate extension.
 *
 * Run with: node --import tsx --test pi-permission-gate.test.mjs
 *
 * Two layers:
 *   - Pure helpers imported from the extension module via tsx (same TS loader
 *     pi uses at runtime). Covers parseVerdict / riskLevelIndex /
 *     buildDisplaySignature / truncateToChars / stripCodeFences invariants.
 *   - Source-shape assertions for config/env plumbing, the CWD-aware system
 *     prompt, and the gate activity indicator (status-pill phases).
 *
 * The extension's pi-bundled deps (@earendil-works/pi-coding-agent,
 * @earendil-works/pi-ai) resolve from local node_modules (devDependencies);
 * no global-pi or PI_ROOT discovery is needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import extension, {
	RISK_LEVELS,
	riskLevelIndex,
	truncateToChars,
	buildDisplaySignature,
	stripCodeFences,
	parseVerdict,
	PARSE_FAILURE_REASON,
	EMPTY_RESPONSE_REASON,
	decideFallback,
	decideThreshold,
	formatEmptyResponseDetail,
	cacheKey,
	cacheGetVerdict,
	cachePutVerdict,
	createConfirmQueue,
	renderMcpCommand,
	parseMcpToolName,
	renderBuiltinMcpCommand,
} from "./pi-permission-gate.ts";

// ---------------------------------------------------------------------------
// Read the source file for source-shape assertions
// ---------------------------------------------------------------------------

const extensionSource = fs.readFileSync(
	path.join(import.meta.dirname, "pi-permission-gate.ts"),
	"utf-8",
);

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("riskLevelIndex", () => {
	it("returns correct indices for all risk levels", () => {
		assert.equal(riskLevelIndex("safe"), 0);
		assert.equal(riskLevelIndex("low"), 1);
		assert.equal(riskLevelIndex("medium"), 2);
		assert.equal(riskLevelIndex("high"), 3);
	});

	it("returns -1 for unknown risk level", () => {
		assert.equal(riskLevelIndex("unknown"), -1);
	});
});

describe("stripCodeFences", () => {
	it("strips code fence with json language tag", () => {
		assert.equal(
			stripCodeFences('```json\n{"risk":"low","reason":"test"}\n```'),
			'{"risk":"low","reason":"test"}',
		);
	});

	it("strips code fence without language tag", () => {
		assert.equal(
			stripCodeFences('```\n{"risk":"low","reason":"test"}\n```'),
			'{"risk":"low","reason":"test"}',
		);
	});

	it("returns plain text unchanged", () => {
		assert.equal(stripCodeFences("hello world"), "hello world");
	});

	it("returns already-stripped JSON unchanged", () => {
		const json = '{"risk":"safe","reason":"ok"}';
		assert.equal(stripCodeFences(json), json);
	});

	it("handles leading/trailing whitespace", () => {
		assert.equal(
			stripCodeFences('  \n  {"risk":"low","reason":"test"}  \n  '),
			'{"risk":"low","reason":"test"}',
		);
	});
});

describe("parseVerdict", () => {
	it("parses valid JSON verdict", () => {
		const result = parseVerdict('{"risk":"low","reason":"minor side effects"}');
		assert.deepEqual(result, { risk: "low", reason: "minor side effects" });
	});

	it("parses valid JSON verdict wrapped in code fences", () => {
		const result = parseVerdict('```json\n{"risk":"high","reason":"dangerous"}\n```');
		assert.deepEqual(result, { risk: "high", reason: "dangerous" });
	});

	it("parses valid JSON with extra whitespace", () => {
		const result = parseVerdict('  \n  {"risk":"safe","reason":"read-only"}  \n  ');
		assert.deepEqual(result, { risk: "safe", reason: "read-only" });
	});

	it("extracts JSON from surrounding prose via fallback", () => {
		// Models that ignore the JSON-only instruction still produce a parseable verdict.
		const result = parseVerdict('Here is my verdict: {"risk":"medium","reason":"moderate risk"} Done.');
		assert.deepEqual(result, { risk: "medium", reason: "moderate risk" });
	});

	// --- Failure cases ---

	it("returns medium fallback for unparseable text", () => {
		const result = parseVerdict("This is not JSON at all");
		assert.deepEqual(result, { risk: "medium", reason: PARSE_FAILURE_REASON });
		assert.equal(result.reason, PARSE_FAILURE_REASON,
			"parseVerdict fallback reason must equal the exported constant");
	});

	it("returns medium fallback for JSON with invalid risk level", () => {
		const result = parseVerdict('{"risk":"extreme","reason":"unknown risk"}');
		assert.deepEqual(result, { risk: "medium", reason: PARSE_FAILURE_REASON });
	});

	it("returns medium fallback for JSON missing reason", () => {
		const result = parseVerdict('{"risk":"low"}');
		assert.deepEqual(result, { risk: "medium", reason: PARSE_FAILURE_REASON });
	});

	it("returns a distinct fallback for empty / whitespace-only response", () => {
		// MiniMax-M3 burns its full budget on untracked reasoning and emits nothing
		// visible — distinguish from parse failure so the log surfaces the real cause.
		assert.deepEqual(parseVerdict(""), { risk: "medium", reason: EMPTY_RESPONSE_REASON });
		assert.deepEqual(parseVerdict("   \n  \t  "), { risk: "medium", reason: EMPTY_RESPONSE_REASON });
	});

	// --- Hardened parser: cases the old single-regex fallback missed ---

	it("parses verdict with reversed key order (reason before risk)", () => {
		// Old regex required "risk" before "reason"; reversed order broke it.
		const result = parseVerdict('{"reason":"moderate risk","risk":"medium"}');
		assert.deepEqual(result, { risk: "medium", reason: "moderate risk" });
	});

	it("parses verdict wrapped in thinking prose", () => {
		// Reasoning models (MiniMax-M3, DeepSeek-V4-Pro) wrap JSON in prose.
		const result = parseVerdict(
			'Thinking about this command... it modifies files outside CWD so it is medium risk.\n' +
			'Here is my verdict: {"risk":"medium","reason":"affects paths outside CWD"} Done.',
		);
		assert.deepEqual(result, { risk: "medium", reason: "affects paths outside CWD" });
	});

	it("parses verdict when prose contains code-example braces", () => {
		// Prose may include `function foo() { ... }` or `for i { x }` fragments.
		// The scanner must still locate the real JSON object independently.
		const result = parseVerdict(
			'I considered `for i := 0; i < n; i++ { x }` but that is irrelevant.\n' +
			'{"risk":"low","reason":"read-only loop in prose"}',
		);
		assert.deepEqual(result, { risk: "low", reason: "read-only loop in prose" });
	});

	it("parses verdict when a string value contains literal braces", () => {
		// JSON string values may contain { or } (e.g. reasons quoting code/config).
		// parseJsonWithRepair handles braces inside strings; the scanner must
		// yield the full object span so the parser sees them in context.
		const result = parseVerdict('{"risk":"low","reason":"touches only `{cwd}` var"}');
		assert.deepEqual(result, { risk: "low", reason: "touches only `{cwd}` var" });
	});

	it("parses the first valid verdict when prose contains other JSON-like spans", () => {
		// Model may emit an example object before the real verdict.
		const result = parseVerdict(
			'Example shape: {"foo":"bar"}. Actual verdict: {"risk":"high","reason":"irreversible"}',
		);
		assert.deepEqual(result, { risk: "high", reason: "irreversible" });
	});

	it("parses verdict embedded in a longer balanced-brace prose span", () => {
		// Outer brace in prose pairs with a brace inside the JSON's reason string,
		// so the first candidate span is prose+JSON and fails; the scanner must
		// still try the inner JSON span starting at its own `{`.
		const result = parseVerdict(
			'Here { is some prose with a } char and then ' +
			'{"risk":"medium","reason":"nested object literal"} follows.',
		);
		assert.deepEqual(result, { risk: "medium", reason: "nested object literal" });
	});

	it("exports PARSE_FAILURE_REASON and EMPTY_RESPONSE_REASON constants", () => {
		// The handler compares verdict.reason to these to decide whether to attach
		// the raw response to the log. They must stay string-equal to the values
		// historical log entries and tests rely on.
		assert.equal(PARSE_FAILURE_REASON, "Could not parse LLM verdict");
		assert.equal(EMPTY_RESPONSE_REASON, "LLM returned empty response");
	});
});

describe("formatEmptyResponseDetail", () => {
	it("clean stop, no content parts, no reasoning breakdown", () => {
		const detail = formatEmptyResponseDetail({
			stopReason: "stop",
			content: [],
			usage: { output: 0 },
		});
		assert.equal(detail, "finish=stop, parts=none, outputTokens=0");
	});

	it("budget exhausted mid-reasoning: finish=length with reasoning-only content", () => {
		const detail = formatEmptyResponseDetail({
			stopReason: "length",
			content: [{ type: "thinking" }],
			usage: { output: 1600, reasoning: 1600 },
		});
		assert.equal(detail, "finish=length, parts=thinking, outputTokens=1600 (1600 reasoning)");
	});

	it("rawStopReason appended only when it differs from stopReason", () => {
		const base = { content: [], usage: { output: 10 } };
		assert.match(
			formatEmptyResponseDetail({ ...base, stopReason: "length", rawStopReason: "max_tokens" }),
			/^finish=length\/max_tokens, /,
		);
		assert.match(
			formatEmptyResponseDetail({ ...base, stopReason: "stop", rawStopReason: "stop" }),
			/^finish=stop, /,
		);
	});

	it("mixed part layout joins types with +", () => {
		const detail = formatEmptyResponseDetail({
			stopReason: "stop",
			content: [{ type: "thinking" }, { type: "toolCall" }],
			usage: { output: 5 },
		});
		assert.equal(detail, "finish=stop, parts=thinking+toolCall, outputTokens=5");
	});
});

describe("truncateToChars", () => {
	it("returns short string unchanged", () => {
		assert.equal(truncateToChars("abc", 10), "abc");
	});

	it("returns string of exactly max length unchanged", () => {
		assert.equal(truncateToChars("abc", 3), "abc");
	});

	it("truncates to max chars and appends …", () => {
		assert.equal(truncateToChars("abcdef", 3), "abc…");
	});

	it("handles an empty string", () => {
		assert.equal(truncateToChars("", 80), "");
	});
});

describe("buildDisplaySignature", () => {
	// --- bash ---

	it("bash: short command unchanged", () => {
		assert.equal(buildDisplaySignature("bash", { command: "ls -la" }), "ls -la");
	});

	it("bash: long command truncated to 80 chars + …", () => {
		const cmd = "x".repeat(100);
		assert.equal(buildDisplaySignature("bash", { command: cmd }), "x".repeat(80) + "…");
	});

	it("bash: newlines collapsed to spaces before truncation", () => {
		// Multi-line command signature is a one-line prefix; newlines become spaces.
		assert.equal(
			buildDisplaySignature("bash", { command: "line1\nline2\nline3" }),
			"line1 line2 line3",
		);
	});

	it("bash: empty command → empty string", () => {
		assert.equal(buildDisplaySignature("bash", { command: "" }), "");
	});

	// --- mcp prefix ---

	it("mcp: server present → server/tool prefix", () => {
		assert.equal(buildDisplaySignature("mcp", { server: "exa", tool: "search" }), "exa/search");
	});

	it("mcp: server absent → tool only (absorbs server=undefined noise)", () => {
		assert.equal(
			buildDisplaySignature("mcp", { tool: "atlassian_createJiraIssue" }),
			"atlassian_createJiraIssue",
		);
		assert.equal(buildDisplaySignature("mcp", { server: undefined, tool: "foo" }), "foo");
	});

	it("mcp meta-op: no tool key → bare 'mcp' (no server/tool identity to show)", () => {
		assert.equal(buildDisplaySignature("mcp", {}), "mcp");
		assert.equal(buildDisplaySignature("mcp", { server: "atlassian" }), "mcp");
		assert.equal(buildDisplaySignature("mcp", { search: "create jira issue", server: "atlassian" }), "mcp");
		assert.equal(buildDisplaySignature("mcp", { action: "auth-complete", server: "atlassian" }), "mcp");
	});

	// --- mcp args: small values shown ---

	it("mcp: small scalar values shown (string, number, bool)", () => {
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { a: "x", b: 1, c: true } }),
			'foo(a="x", b=1, c=true)',
		);
	});

	it("mcp: strings quoted; numbers/bools bare", () => {
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { s: "v", n: 42, b: false } }),
			'foo(s="v", n=42, b=false)',
		);
	});

	// --- mcp args: dropped values → +N more ---

	it("mcp: long string dropped + counted in +N more", () => {
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { short: "ok", long: "x".repeat(100) } }),
			'foo(short="ok", +1 more)',
		);
	});

	it("mcp: object/array/null dropped + counted", () => {
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { obj: { a: 1 }, arr: [1, 2], nul: null, s: "k" } }),
			'foo(s="k", +3 more)',
		);
	});

	it("mcp: opaque IDs (UUID, Atlassian account ID, hex) dropped + counted", () => {
		// Atlassian account ID (24 hex, no dashes)
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { id: "641a5e161273131f2ae21205", name: "n" } }),
			'foo(name="n", +1 more)',
		);
		// Standard UUID
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { id: "3e3d218b-6aaf-41d8-8120-15bbe4bc7793", name: "n" } }),
			'foo(name="n", +1 more)',
		);
	});

	it("mcp: empty string value dropped + counted", () => {
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { empty: "", s: "k" } }),
			'foo(s="k", +1 more)',
		);
	});

	it("mcp: all values dropped → tool(+N more)", () => {
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { big: "x".repeat(100), obj: { a: 1 } } }),
			"foo(+2 more)",
		);
	});

	it("mcp: no +N more suffix when nothing dropped", () => {
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: { a: "x" } }),
			'foo(a="x")',
		);
	});

	// --- mcp args shape ---

	it("mcp: empty args object → prefix only (no parens)", () => {
		assert.equal(buildDisplaySignature("mcp", { tool: "foo", args: {} }), "foo");
	});

	it("mcp: args as JSON string parsed like an object", () => {
		const argsStr = JSON.stringify({ a: "x", b: { nested: true }, c: "y".repeat(100) });
		assert.equal(
			buildDisplaySignature("mcp", { tool: "foo", args: argsStr }),
			'foo(a="x", +2 more)',
		);
	});

	it("mcp: non-JSON args string → prefix only (can't extract)", () => {
		assert.equal(buildDisplaySignature("mcp", { tool: "foo", args: "not json" }), "foo");
	});

	it("mcp: args undefined → prefix only", () => {
		assert.equal(buildDisplaySignature("mcp", { tool: "foo" }), "foo");
		assert.equal(buildDisplaySignature("mcp", { tool: "foo", args: undefined }), "foo");
	});

	// --- the motivating example (approximate) ---

	it("mcp: createJiraIssue with a big description → compact signature", () => {
		const args = {
			additional_fields: { customfield_10014: "AIC-3250" },
			assignee_account_id: "641a5e161273131f2ae21205",
			cloudId: "3e3d218b-6aaf-41d8-8120-15bbe4bc7793",
			contentFormat: "markdown",
			description: "## Intent\n\nCAPI creates AWSMachine objects…".repeat(10),
			issueTypeName: "Task",
			projectKey: "AIC",
			summary: "B2 nodepool_reconciler: set Cluster topology.workers (cluster_worker-VM)",
		};
		// Shown: contentFormat, issueTypeName, projectKey (small, non-ID).
		// Dropped: additional_fields (object), assignee_account_id (hex ID),
		//          cloudId (UUID), description (long), summary (>60 chars).
		assert.equal(
			buildDisplaySignature("mcp", { tool: "atlassian_createJiraIssue", args }),
			'atlassian_createJiraIssue(contentFormat="markdown", issueTypeName="Task", projectKey="AIC", +5 more)',
		);
	});

	// --- other tools ---

	it("unknown toolName → just toolName", () => {
		assert.equal(buildDisplaySignature("read", { path: "/x" }), "read");
	});
});

describe("risk level comparison logic", () => {
	it("safe is below low threshold", () => {
		assert.equal(riskLevelIndex("safe") < riskLevelIndex("low"), true);
	});

	it("low meets the low block threshold", () => {
		assert.equal(riskLevelIndex("low") >= riskLevelIndex("low"), true);
	});

	it("high exceeds all thresholds", () => {
		assert.equal(riskLevelIndex("high") > riskLevelIndex("medium"), true);
		assert.equal(riskLevelIndex("high") > riskLevelIndex("low"), true);
	});
});

// ---------------------------------------------------------------------------
// Source-shape regression guards (config/env/auth plumbing)
// ---------------------------------------------------------------------------

describe("config plumbing", () => {
	it("does NOT reference any PI_PERM_GATE env var (env tier removed)", () => {
		assert.doesNotMatch(extensionSource, /PI_PERM_GATE/);
	});

	it("default maxTokens is 4096 (raised from 128)", () => {
		assert.match(extensionSource, /settings\.maxTokens \?\? 4096/);
	});

	it("fallback setting is validated against allow/block/confirm", () => {
		assert.match(extensionSource, /FALLBACK_LEVELS/);
	});

	it("has readRuntimeConfig function (consolidated single read)", () => {
		assert.match(extensionSource, /function readRuntimeConfig/);
	});

	it("reasoningEffort setting honored (openai-completions adapter maps thinkingLevelMap[reasoningEffort] → reasoning_effort; the plain `reasoning` key is what that adapter drops)", () => {
		assert.match(extensionSource, /reasoningEffort/);
		assert.doesNotMatch(extensionSource, /\breasoning:/);
	});

	it("classifies via ctx.modelRegistry.complete", () => {
		assert.match(extensionSource, /ctx\.modelRegistry\.complete\(/);
	});

	it("does NOT resolve auth manually (runtime owns it)", () => {
		assert.doesNotMatch(extensionSource, /getApiKeyAndHeaders/);
		assert.doesNotMatch(extensionSource, /getProvider\(/);
		assert.doesNotMatch(extensionSource, /provider\s*\.\s*streamSimple/);
	});

	it("does NOT use compat entrypoint", () => {
		assert.doesNotMatch(extensionSource, /from ["']@earendil-works\/pi-ai\/compat["']/);
		assert.doesNotMatch(extensionSource, /\bcompleteSimple\s*\(/);
	});

	it("exports PARSE_FAILURE_REASON and EMPTY_RESPONSE_REASON constants", () => {
		assert.match(extensionSource, /export const PARSE_FAILURE_REASON/);
		assert.match(extensionSource, /export const EMPTY_RESPONSE_REASON/);
	});

	it("classifyCommand returns { verdict, rawResponse }", () => {
		// The handler threads rawResponse to the log only on parse failure.
		assert.match(extensionSource, /Promise<\{ verdict: Verdict; rawResponse: string \}>/);
		assert.match(extensionSource, /return \{ verdict: parseVerdict\(responseText\), rawResponse: responseText \}/);
	});

	it("classifyCommand surfaces the provider error instead of a bare empty-response", () => {
		// complete() resolves on provider failure with stopReason "error"/"aborted"
		// and the provider message in errorMessage — that message must win.
		assert.match(extensionSource, /response\.stopReason === "error" \|\| response\.stopReason === "aborted"/);
		assert.match(extensionSource, /response\.errorMessage \|\|/);
		// Genuine empties still throw, but with finish/usage diagnostics attached.
		assert.match(extensionSource, /formatEmptyResponseDetail\(response\)/);
	});

	it("fallback allow/block branches log errDetail as errorDetail", () => {
		assert.match(
			extensionSource,
			/logCommandDecision\(command, "unknown", blockLevel, action\.logDecision, action\.logReason, undefined, errDetail\)/,
		);
	});

	it("logCommandDecision accepts optional rawResponse and errorDetail params", () => {
		assert.match(extensionSource, /reason\?: string,\s*\n\s*rawResponse\?: string,\s*\n\s*errorDetail\?: string,\s*\n\): void/);
		// rawResponse is attached to the log entry (capped at 2000 chars) ...
		assert.match(extensionSource, /if \(rawResponse !== undefined\)/);
		assert.match(extensionSource, /rawResponse\.length > 2000/);
		assert.match(extensionSource, /\u2026\[truncated\]/);
		// ... and errorDetail gets the same attach-and-cap treatment.
		assert.match(extensionSource, /if \(errorDetail !== undefined\)/);
		assert.match(extensionSource, /errorDetail\.length > 2000/);
});

	it("decideThreshold owns the parse-failure log rule (behaviorally tested above)", () => {
		// The parse-failure log-attachment rule moved from an inline parseFailureRaw
		// block in the handler into decideThreshold (via shouldLogRawResponse).
		// Source-shape guard is demoted to a contract pointer; the matrix is locked
		// by the decideThreshold behavior tests.
		assert.match(extensionSource, /function decideThreshold/);
		assert.match(extensionSource, /PARSE_FAILURE_REASON/);
		assert.match(extensionSource, /EMPTY_RESPONSE_REASON/);
	});

	it("confirmWithUser threads rawResponse and logErrorDetail to its log calls", () => {
		assert.match(
			extensionSource,
			/function confirmWithUser\([\s\S]*?opts: ConfirmOptions,\s*\n\s*rawResponse\?: string,\s*\n\)/,
		);
		assert.match(
			extensionSource,
			/logCommandDecision\(command, opts\.risk, blockLevel, "blocked", opts\.blockedLogReason, rawResponse, opts\.logErrorDetail\)/,
		);
		assert.match(
			extensionSource,
			/logCommandDecision\(command, opts\.risk, blockLevel, "confirmed", opts\.confirmedLogReason, rawResponse, opts\.logErrorDetail\)/,
		);
	});

	it("confirmWithUser takes a displaySignature param", () => {
		assert.match(extensionSource, /displaySignature:\s*string/);
	});

	it("select prompt uses displaySignature, not truncateCommand", () => {
		assert.match(extensionSource, /\$\{displaySignature\}/);
		assert.doesNotMatch(extensionSource, /truncateCommand/);
	});

	it("exports buildDisplaySignature and truncateToChars", () => {
		assert.match(extensionSource, /export function buildDisplaySignature/);
		assert.match(extensionSource, /export function truncateToChars/);
	});

	it("handler builds signature from event.toolName + event.input", () => {
		assert.match(extensionSource, /buildDisplaySignature\(\s*event\.toolName,\s*event\.input/);
	});

	it("handler passes signature to both confirmWithUser call sites", () => {
		// fallback-confirm (classifier failed) and success-block both thread signature.
		const matches = extensionSource.match(/confirmWithUser\(ctx, command, signature, blockLevel/g) ?? [];
		assert.equal(matches.length, 2, "expected signature at both call sites");
	});
});

describe("gate activity indicator", () => {
	it("uses one shared setStatus key for both gate pills", () => {
		assert.match(extensionSource, /const GATE_STATUS_KEY = "pi-permission-gate";/);
		assert.doesNotMatch(extensionSource, /const statusKey =/);
	});

	it("sets the classify pill in gate grammar before classifying", () => {
		assert.match(
			extensionSource,
			/ctx\.ui\.setStatus\(GATE_STATUS_KEY, theme\.fg\("accent", "🛡 gate: classifying…"\)\)/,
		);
	});

	it("clears the pill in the classify try's finally", () => {
		assert.match(
			extensionSource,
			/\} finally \{\s*try \{\s*ctx\.ui\.setStatus\?\.\(GATE_STATUS_KEY, undefined\)/,
		);
	});

	it("rewords the confirm-wait pill into gate grammar, risk icon kept", () => {
		assert.match(extensionSource, /🛡 gate: \$\{icon\} awaiting input/);
	});

	it("defers the fallback-confirm dispatch past the classify finally", () => {
		assert.match(extensionSource, /let fallbackConfirmOpts: ConfirmOptions \| undefined;/);
		assert.match(extensionSource, /fallbackConfirmOpts = action\.opts;/);
		assert.match(
			extensionSource,
			/if \(fallbackConfirmOpts\) \{\s*return confirmWithUser\(ctx, command, signature, blockLevel, fallbackConfirmOpts\);/,
		);
	});
});

describe("CWD-aware system prompt content", () => {
	it("contains Working directory context section", () => {
		assert.match(extensionSource, /Working directory context:/);
	});

	it("mentions CWD in the user prompt template", () => {
		assert.match(extensionSource, /Current working directory:/);
	});

	it("classifyCommand accepts cwd parameter", () => {
		assert.match(extensionSource, /classifyCommand\([^)]*command:\s*string[^)]*cwd:\s*string/s);
	});

	it("passes ctx.cwd to classifyCommand", () => {
		assert.match(extensionSource, /classifyCommand\(\s*command,\s*ctx\.cwd/);
	});

	it("tells LLM that CWD-scoped deletions are low risk", () => {
		assert.match(extensionSource, /Deleting files\/dirs under CWD.*low risk/);
	});

	it("tells LLM that system paths retain normal risk", () => {
		assert.match(extensionSource, /paths outside CWD.*retain their normal risk/);
	});

	it("low risk definition includes CWD-scoped deletions", () => {
		assert.match(extensionSource, /CWD-scoped deletions and modifications/);
	});

	it("high risk definition mentions outside CWD", () => {
		assert.match(extensionSource, /operations outside CWD that affect system state/);
	});

	it("package installs are described as low risk (not safe)", () => {
		assert.match(extensionSource, /Package installs.*within CWD are low risk/);
	});

	it("medium risk examples include CWD-outside path", () => {
		assert.match(extensionSource, /rm -rf \.\.\/other-project/);
	});

	it("CWD is delimited with backticks in user prompt", () => {
		assert.match(extensionSource, /Current working directory: \\`\$\{cwd\}\\`/);
	});

	it("classifyCommand has CWD fallback guard", () => {
		assert.match(extensionSource, /if \(!cwd\)\s*\{\s*cwd = process\.cwd\(\)/);
	});

	it("does NOT include isCwdScoped heuristic", () => {
		assert.doesNotMatch(extensionSource, /function isCwdScoped/);
	});

	it("does NOT include hasSystemEscapePattern", () => {
		assert.doesNotMatch(extensionSource, /function hasSystemEscapePattern/);
	});
});

// ---------------------------------------------------------------------------
// Verdict cache — session-scoped, keyed (cwd, command); stores the
// classifier's opinion, never a permission. Failure-mode verdicts are never
// cached; denial keeps the verdict (deterministic re-prompt, no re-sample).
// ---------------------------------------------------------------------------

describe("verdict cache", () => {
	it("cacheKey is unambiguous across cwd/command boundaries", () => {
		assert.equal(cacheKey("/a", "ls"), cacheKey("/a", "ls"));
		// JSON pair key: no separator collision between cwd/command boundaries
		assert.notEqual(cacheKey("/a", "ls"), cacheKey("/ab", "ls"));
		assert.notEqual(cacheKey("/a", "ls"), cacheKey("/a", "lsb"));
		assert.notEqual(cacheKey("/a", "ls"), cacheKey("/a/b", "ls"));
	});

	it("put/get round-trips a parsed verdict", () => {
		const k = cacheKey("/test-cache", "echo hi");
		assert.equal(cacheGetVerdict(k), undefined);
		assert.equal(cachePutVerdict(k, { risk: "low", reason: "fine" }), true);
		assert.deepEqual(cacheGetVerdict(k), { risk: "low", reason: "fine" });
	});

	it("never caches parse-failure or empty-response verdicts", () => {
		const k1 = cacheKey("/test-cache", "cmd-parse-failure");
		const k2 = cacheKey("/test-cache", "cmd-empty-response");
		assert.equal(cachePutVerdict(k1, { risk: "medium", reason: PARSE_FAILURE_REASON }), false);
		assert.equal(cachePutVerdict(k2, { risk: "medium", reason: EMPTY_RESPONSE_REASON }), false);
		assert.equal(cacheGetVerdict(k1), undefined);
		assert.equal(cacheGetVerdict(k2), undefined);
	});

	it("caps memory with FIFO eviction", () => {
		for (let i = 0; i < 2100; i++) {
			cachePutVerdict(cacheKey("/cap", `cmd-${i}`), { risk: "low", reason: "ok" });
		}
		// Oldest entries of the batch are gone; a recent one survives
		assert.equal(cacheGetVerdict(cacheKey("/cap", "cmd-0")), undefined);
		assert.deepEqual(cacheGetVerdict(cacheKey("/cap", "cmd-2099")), { risk: "low", reason: "ok" });

		// Regression: re-putting an existing key at cap must NOT evict another
		// entry — Map.set keeps the key's original insertion position, so the
		// FIFO guard only fires for keys that would grow the map.
		cachePutVerdict(cacheKey("/cap", "cmd-1500"), { risk: "medium", reason: "updated" });
		assert.deepEqual(
			cacheGetVerdict(cacheKey("/cap", "cmd-100")),
			{ risk: "low", reason: "ok" },
		);
		assert.deepEqual(
			cacheGetVerdict(cacheKey("/cap", "cmd-1500")),
			{ risk: "medium", reason: "updated" },
		);
		// A genuinely new key at cap still evicts the oldest
		cachePutVerdict(cacheKey("/cap", "cmd-new"), { risk: "low", reason: "ok" });
		assert.equal(cacheGetVerdict(cacheKey("/cap", "cmd-100")), undefined);
	});
});

// ---------------------------------------------------------------------------
// renderMcpCommand — the classified string for every mcp gateway invocation:
// legacy call-mode shape only for tool-without-action (pi dispatch precedence);
// everything else is a verbatim meta-op dump (interpretation lives in the prompt).
// ---------------------------------------------------------------------------

describe("renderMcpCommand", () => {
	it("call mode renders the legacy string unchanged (log contract)", () => {
		assert.equal(
			renderMcpCommand({ server: "atlassian", tool: "atlassian_getJiraIssue", args: { id: "AIC-1" } }),
			'MCP tool call: server="atlassian", tool="atlassian_getJiraIssue", args={"id":"AIC-1"}',
		);
		assert.equal(
			renderMcpCommand({ tool: "atlassian_createJiraIssue" }),
			'MCP tool call: tool="atlassian_createJiraIssue", args={}',
		);
		assert.equal(
			renderMcpCommand({ server: "exa", tool: "web_search", args: '{"q":"x"}' }),
			'MCP tool call: server="exa", tool="web_search", args={"q":"x"}',
		);
	});

	it("every non-call invocation renders as a verbatim meta-op dump", () => {
		assert.equal(
			renderMcpCommand({ search: "create jira issue", server: "atlassian" }),
			'MCP gateway meta-op: input={"search":"create jira issue","server":"atlassian"} (executes NO MCP server tool)',
		);
		assert.equal(
			renderMcpCommand({}),
			"MCP gateway meta-op: input={} (executes NO MCP server tool)",
		);
		assert.equal(
			renderMcpCommand({ connect: "exa" }),
			'MCP gateway meta-op: input={"connect":"exa"} (executes NO MCP server tool)',
		);
	});

	it("action beats tool (pi dispatch precedence) — a dormant tool key does not fake a call", () => {
		assert.equal(
			renderMcpCommand({ action: "auth-start", tool: "atlassian_deleteIssue", server: "atlassian" }),
			'MCP gateway meta-op: input={"action":"auth-start","tool":"atlassian_deleteIssue","server":"atlassian"} (executes NO MCP server tool)',
		);
	});

	it("blank tool value falls through to the meta-op dump", () => {
		assert.equal(
			renderMcpCommand({ tool: "  ", server: "atlassian" }),
			'MCP gateway meta-op: input={"tool":"  ","server":"atlassian"} (executes NO MCP server tool)',
		);
	});
});

// ---------------------------------------------------------------------------
// Source-shape guards: credential-disclosure taxonomy, verdict-cache plumbing,
// and MCP input-shape robustness.
// ---------------------------------------------------------------------------

describe("credential-disclosure taxonomy", () => {
	it("system prompt has a Credential disclosure section", () => {
		assert.match(extensionSource, /Credential disclosure:/);
	});

	it("exposing live secrets to transcript or off-host rates at least medium", () => {
		assert.match(extensionSource, /expose live secret values[^\n]*at least medium risk/);
	});

	it("literal secrets in command text count as disclosure", () => {
		assert.match(extensionSource, /literal secrets embedded in the command text/);
	});

	it("in-place credential use stays low (use-vs-leak line)", () => {
		assert.match(extensionSource, /Using credentials in place stays low when the destination is the credential's own service/);
	});

	it("credential values to unrelated hosts rate at least medium", () => {
		assert.match(extensionSource, /sending credential values to unrelated or unknown hosts[^\n]*is at least medium/);
	});

	it("config metadata and public keys stay safe or low", () => {
		assert.match(extensionSource, /[Rr]eading config metadata[^\n]*stays safe or low/);
	});
});

describe("verdict cache plumbing", () => {
	it("handler checks the cache before classifying", () => {
		assert.match(extensionSource, /cacheGetVerdict\(cacheK\)/);
	});

	it("handler keys the cache on ctx.cwd + command", () => {
		assert.match(extensionSource, /cacheKey\(ctx\.cwd, command\)/);
	});

	it("handler stores the verdict after a successful classify", () => {
		assert.match(extensionSource, /cachePutVerdict\(cacheK, verdict\)/);
	});

	it("cache hit skips the classify phase (no LLM call)", () => {
		assert.match(extensionSource, /if \(cachedVerdict\) \{[\s\S]*?verdict = cachedVerdict;[\s\S]*?\} else \{[\s\S]*?classifyCommand/);
	});

	it("user denial keeps the cached verdict (no wear-down re-sample)", () => {
		assert.doesNotMatch(extensionSource, /cacheEvictVerdict/);
	});

	it("cache lives at module scope (session/pi-process lifetime)", () => {
		assert.match(extensionSource, /const verdictCache = new Map<string, Verdict>\(\);/);
	});
});

describe("MCP input-shape robustness", () => {
	it("handler renders every gateway invocation via renderMcpCommand", () => {
		assert.match(extensionSource, /export function renderMcpCommand/);
		assert.match(extensionSource, /command = renderMcpCommand\(\(event\.input \?\? \{\}\) as Record<string, unknown>\)/);
	});

	it("never stringifies an absent server into the classified command", () => {
		assert.doesNotMatch(extensionSource, /server="\$\{server\}", tool=/);
	});

	it("call mode requires a tool key and no action key (pi dispatch precedence: action > tool)", () => {
		assert.match(extensionSource, /action > tool/);
		assert.match(extensionSource, /tool && !mcpField\(input, "action"\)/);
	});

	it("meta-ops render as a verbatim input dump — no <unknown> placeholder, no per-mode switch", () => {
		// Placeholder ban targets rendered string literals, not type annotations
		// (e.g. Promise<unknown> in queue plumbing).
		assert.doesNotMatch(extensionSource, /["'`]<unknown>["'`]/);
		assert.match(extensionSource, /MCP gateway meta-op: input=\$\{JSON\.stringify\(input\)\}/);
	});

	it("system prompt teaches the key-based meta-op taxonomy", () => {
		assert.match(extensionSource, /MCP gateway meta-op context:/);
		assert.match(extensionSource, /a "search" key \(tool-index search\)/);
	});
});

// ---------------------------------------------------------------------------
// Built-in MCP (pi >= built-in MCP support): tools register as
// mcp__<server>__<tool>, and codemode scripts issue the same calls as nested
// tool_calls. A mcp__ prefix match + the same "MCP tool call:" render covers
// all exposure modes.
// ---------------------------------------------------------------------------

describe("built-in MCP tool calls", () => {
	it("parseMcpToolName: first __ after the prefix splits server/tool", () => {
		assert.deepEqual(parseMcpToolName("mcp__atlassian__create_issue"), {
			server: "atlassian",
			tool: "create_issue",
		});
		// Server names can't contain __ (validated config); a tool name can —
		// the remainder after the first separator is the tool, verbatim.
		assert.deepEqual(parseMcpToolName("mcp__srv__my__tool"), { server: "srv", tool: "my__tool" });
	});

	it("parseMcpToolName: degenerate names gate with server undefined, non-MCP names don't parse", () => {
		assert.deepEqual(parseMcpToolName("mcp__solo"), { server: undefined, tool: "solo" });
		assert.deepEqual(parseMcpToolName("mcp__"), { server: undefined, tool: "" });
		for (const notMcp of ["read", "mcp", "codemode", "tool_search"]) {
			assert.equal(parseMcpToolName(notMcp), undefined, notMcp);
		}
	});

	it("renderBuiltinMcpCommand: same 'MCP tool call:' shape as the gateway render (one prompt taxonomy)", () => {
		assert.equal(
			renderBuiltinMcpCommand("mcp__atlassian__create_issue", { summary: "x" }),
			'MCP tool call: server="atlassian", tool="create_issue", args={"summary":"x"}',
		);
		// Args verbatim (no server/tool stripping) — the verbatim-dump property
		// the gateway meta-op eval validated.
		assert.equal(
			renderBuiltinMcpCommand("mcp__exa__web_fetch", { url: "https://x", b: 1 }),
			'MCP tool call: server="exa", tool="web_fetch", args={"url":"https://x","b":1}',
		);
	});

	it("renderBuiltinMcpCommand: degenerate names omit the server segment", () => {
		assert.equal(
			renderBuiltinMcpCommand("mcp__weird", {}),
			'MCP tool call: tool="weird", args={}',
		);
	});

	it("display signature: server/tool prefix with small-args filtering", () => {
		assert.equal(
			buildDisplaySignature("mcp__atlassian__create_issue", {
				summary: "B2 fix",
				description: "long".repeat(40),
				id: "641a5e161273131f2ae21205",
			}),
			'atlassian/create_issue(summary="B2 fix", +2 more)',
		);
		// Array values are dropped like other non-scalars.
		assert.equal(
			buildDisplaySignature("mcp__parallel-search__web_search", { queries: ["q1"] }),
			"parallel-search/web_search(+1 more)",
		);
	});

	it("handler dispatches mcp__ tool names through the classifier", () => {
		assert.match(extensionSource, /else if \(event\.toolName\.startsWith\("mcp__"\)\)/);
		assert.match(extensionSource, /renderBuiltinMcpCommand\(\s*event\.toolName,/s);
	});

	it("system prompt documents built-in MCP naming", () => {
		assert.match(extensionSource, /mcp__<server>__<tool>/);
	});

	it("codemode and tool_search stay ungated (their effectful surface is nested tool_calls)", () => {
		assert.match(extensionSource, /event\.toolName\.startsWith\("mcp__"\)/);
		assert.doesNotMatch(extensionSource, /event\.toolName === "codemode"/);
		assert.doesNotMatch(extensionSource, /event\.toolName === "tool_search"/);
	});
});

// ---------------------------------------------------------------------------
// Retry plumbing — source-shape guards for the retry.provider budget
// (ADR 0006, amends 0004). The gate reads pi's retry.provider block (shared
// with chat turns) via SettingsManager.getProviderRetrySettings() and forwards
// it through complete() → prepareRequest → provider.stream() → retryProviderRequest.
// Legacy gate-local keys (permissionGate.maxRetries/maxRetryDelayMs/timeout)
// are silently ignored.
// ---------------------------------------------------------------------------

describe("retry plumbing (ADR 0006)", () => {
	it("reads the retry budget from getProviderRetrySettings (shared with chat turns), never agent-level retry.*", () => {
		assert.match(extensionSource, /getProviderRetrySettings\(\)/);
		assert.doesNotMatch(extensionSource, /getRetrySettings\(\)|getRetryEnabled\(\)/);
		assert.doesNotMatch(extensionSource, /settings\.maxRetries \?\? 3/);
		assert.doesNotMatch(extensionSource, /settings\.maxRetryDelayMs \?\? 5000/);
		assert.doesNotMatch(extensionSource, /settings\.timeout \?\? 10000/);
	});

	it("PermissionGateConfig no longer declares gate-local retry keys", () => {
		const m = extensionSource.match(/interface PermissionGateConfig \{([^}]*)\}/);
		assert.ok(m, "PermissionGateConfig interface exists");
		assert.doesNotMatch(m[1], /maxRetries|maxRetryDelayMs|timeout/);
	});

	it("classifyCommand options type carries timeoutMs, maxRetries and maxRetryDelayMs", () => {
		assert.match(
			extensionSource,
			/timeoutMs\?:\s*number;\s*maxRetries\?:\s*number;\s*maxRetryDelayMs\?:\s*number[^)]*\): Promise<\{ verdict: Verdict; rawResponse: string \}>/,
		);
	});

	it("handler passes the retry.provider budget into classifyCommand", () => {
		assert.match(extensionSource, /timeoutMs: providerRetry\.timeoutMs/);
		assert.match(extensionSource, /maxRetries: providerRetry\.maxRetries/);
		assert.match(extensionSource, /maxRetryDelayMs: providerRetry\.maxRetryDelayMs/);
	});

	it("forwards only finite-number retry.provider values (junk cannot stall the gate)", () => {
		assert.match(extensionSource, /Number\.isFinite/);
	});

	it("complete() applies caller maxRetries (no manual maxRetries:0 override)", () => {
		// The provider API (openai-completions.js) overrides the SDK's
		// maxRetries:0 with options?.maxRetries via retryProviderRequest — the
		// gate must not re-introduce a literal zero over the configured budget.
		// (The ...options spread itself is locked by the ADR 0005 suite.)
		assert.doesNotMatch(extensionSource, /maxRetries: 0/);
	});

	it("fallback governs post-exhaustion (no gate-side retryAssistantCall wrap)", () => {
		// Path A (HTTP-layer retryProviderRequest) only — no message-level
		// retryAssistantCall wrap. Path B declined: it cannot see Retry-After
		// headers (loses "retry after x seconds" fidelity) and duplicates the
		// HTTP layer.
		assert.doesNotMatch(extensionSource, /retryAssistantCall/);
		assert.doesNotMatch(extensionSource, /isRetryableAssistantError/);
	});
});

// Timeout-retry redesign (ADR 0005) — source-shape guards.

describe("timeout-retry redesign (ADR 0005)", () => {
	it("classifyCommand threads timeoutMs into complete() via the options spread (ADR 0006 source)", () => {
		assert.match(
			extensionSource,
			/await modelRegistry\.complete\(model, context, \{\s*\.\.\.options,\s*signal,\s*\}\)/s,
		);
		assert.doesNotMatch(extensionSource, /timeoutMs: timeout\b/);
	});

	it("classifyCommand drops the envelope (no AbortController/setTimeout/timedOut/onAbort/clearTimeout)", () => {
		// Envelope constructs must not reappear inside classifyCommand.
		assert.doesNotMatch(extensionSource, /new AbortController\(\)/);
		assert.doesNotMatch(extensionSource, /let timedOut = false;/);
		assert.doesNotMatch(extensionSource, /\bonAbort\b/);
		assert.doesNotMatch(extensionSource, /clearTimeout\(timer\)/);
		assert.doesNotMatch(extensionSource, /\bsetTimeout\(\(/);
		assert.doesNotMatch(extensionSource, /timeoutController/);
		assert.doesNotMatch(extensionSource, /signal\.addEventListener\("abort", onAbort/);
	});

	it("classifyCommand catch-block no longer rewrites timeout/abort errors", () => {
		// Thrown errors carry their native message through to errDetail → decideFallback.
		assert.doesNotMatch(extensionSource, /LLM classification timed out/);
		assert.doesNotMatch(extensionSource, /LLM classification aborted/);
	});

});

// ---------------------------------------------------------------------------
// Behavioral extension tests
// ---------------------------------------------------------------------------

describe("extension load", () => {
	it("default export is a function", () => {
		assert.equal(typeof extension, "function");
	});
});

// ---------------------------------------------------------------------------
// decideFallback — pure decision matrix (classifier threw)
// 6 cells: fallback ∈ {allow, block, confirm} × hasUI {true, false}
// ---------------------------------------------------------------------------

describe("decideFallback", () => {
	const cfg = (overrides) => ({
		blockLevel: "low",
		fallback: "confirm",
		hasUI: true,
		...overrides,
	});

	it("allow → allow action with log-contract reason", () => {
		const a = decideFallback("boom", cfg({ fallback: "allow" }));
		assert.deepEqual(a, {
			kind: "allow",
			logDecision: "allowed",
			logReason: "Fallback allow after LLM failure",
		});
	});

	it("block + hasUI → block with UI reason", () => {
		const a = decideFallback("boom", cfg({ fallback: "block", hasUI: true }));
		assert.equal(a.kind, "block");
		assert.equal(a.logDecision, "blocked");
		assert.equal(a.logReason, "Fallback block after LLM failure");
		assert.equal(
			a.blockReason,
			"Operation blocked: AI safety check failed and fallback is set to block",
		);
	});

	it("block + !hasUI → block with headless reason", () => {
		const a = decideFallback("boom", cfg({ fallback: "block", hasUI: false }));
		assert.equal(a.kind, "block");
		assert.equal(a.logDecision, "blocked");
		assert.equal(a.logReason, "Fallback block after LLM failure");
		assert.equal(a.blockReason, "Operation blocked: AI safety check failed");
	});

	it("confirm + hasUI → confirm with unknown-risk opts embedding errDetail", () => {
		const a = decideFallback("kaboom: detail", cfg({ fallback: "confirm", hasUI: true }));
		assert.equal(a.kind, "confirm");
		assert.equal(a.opts.risk, "unknown");
		assert.equal(a.opts.promptTitle, "AI safety check failed");
		assert.equal(a.opts.promptBody, "The LLM could not classify this operation: kaboom: detail");
		assert.equal(a.opts.blockedLogReason, "Blocked by user (AI check failed)");
		assert.equal(a.opts.confirmedLogReason, "User confirmed after AI check failed");
		assert.equal(a.opts.blockReason, "Blocked by user (AI check failed)");
		assert.equal(a.opts.logErrorDetail, "kaboom: detail");
	});

	it("confirm + !hasUI → block (headless cannot prompt; safety-favoring block)", () => {
		// Headless mode can't prompt, so block rather than silently allow when the
		// classifier fails. Safety-favoring: when in doubt and the user can't weigh
		// in, block. This is the default fallback (confirm), so headless
		// classifier-failures fail-closed, not fail-open.
		const a = decideFallback("boom", cfg({ fallback: "confirm", hasUI: false }));
		assert.equal(a.kind, "block");
		assert.equal(a.logDecision, "blocked");
		assert.equal(a.logReason, "Fallback confirm without UI — blocked");
		assert.equal(a.blockReason, "Operation blocked: AI safety check failed (headless mode cannot confirm)");
	});

	it("blockLevel threads through but does not branch the matrix", () => {
		// blockLevel is carried for the log; the fallback matrix is fallback × hasUI only.
		const aLow = decideFallback("boom", cfg({ fallback: "block", hasUI: true, blockLevel: "low" }));
		const aHigh = decideFallback("boom", cfg({ fallback: "block", hasUI: true, blockLevel: "high" }));
		assert.equal(aLow.blockReason, aHigh.blockReason);
		assert.equal(aLow.logReason, aHigh.logReason);
	});
});

// ---------------------------------------------------------------------------
// decideThreshold — pure decision matrix (classifier succeeded)
// safe-edge + logRawResponse rule + block/confirm/allow branches
// ---------------------------------------------------------------------------

describe("decideThreshold", () => {
	const cfg = (overrides) => ({
		blockLevel: "low",
		hasUI: true,
		...overrides,
	});
	const ok = { risk: "low", reason: "minor" };
	const parseFail = { risk: "medium", reason: PARSE_FAILURE_REASON };
	const emptyFail = { risk: "medium", reason: EMPTY_RESPONSE_REASON };

	it("allow when risk below threshold", () => {
		const a = decideThreshold({ risk: "safe", reason: "read-only" }, cfg({ blockLevel: "low" }));
		assert.equal(a.kind, "allow");
		assert.equal(a.log.risk, "safe");
		assert.equal(a.log.decision, "allowed");
		assert.equal(a.log.reason, "read-only");
		assert.equal(a.log.logRawResponse, false);
	});

	it("block + hasUI=false → block with the do-not-retry reason", () => {
		const a = decideThreshold({ risk: "high", reason: "irreversible" }, cfg({ blockLevel: "low", hasUI: false }));
		assert.equal(a.kind, "block");
		assert.equal(a.log.risk, "high");
		assert.equal(a.log.decision, "blocked");
		assert.equal(a.log.reason, "irreversible");
		assert.match(
			a.blockReason,
			/Permission gate blocked this operation \(risk: high\): irreversible\. Do not retry/,
		);
	});

	it("block + hasUI=true → confirm with risk-scoped opts", () => {
		const a = decideThreshold({ risk: "medium", reason: "moderate" }, cfg({ blockLevel: "low", hasUI: true }));
		assert.equal(a.kind, "confirm");
		assert.equal(a.opts.risk, "medium");
		assert.equal(a.opts.promptTitle, "Potentially dangerous operation (medium risk)");
		assert.equal(a.opts.promptBody, "moderate");
		assert.equal(a.opts.blockedLogReason, "Blocked by user");
		assert.equal(a.opts.confirmedLogReason, "moderate");
		assert.equal(a.opts.blockReason, "Blocked by user");
	});

	// --- safe-edge carve-out (preserved + under test) ---

	it("safe-edge: blockLevel=safe + risk=safe → allow (carve-out prevents false block at threshold 0)", () => {
		// Without the `&& risk !== "safe"` guard, 0 >= 0 would wrongly block.
		const a = decideThreshold({ risk: "safe", reason: "read-only" }, cfg({ blockLevel: "safe" }));
		assert.equal(a.kind, "allow");
		assert.equal(a.log.logRawResponse, false);
	});

	it("safe-edge: blockLevel=safe + risk=low → block (threshold 0, non-safe risk meets it)", () => {
		const a = decideThreshold({ risk: "low", reason: "minor" }, cfg({ blockLevel: "safe", hasUI: false }));
		assert.equal(a.kind, "block");
	});

	// --- logRawResponse rule (parse-failure only) ---

	it("logRawResponse=true when verdict.reason is PARSE_FAILURE_REASON", () => {
		const a = decideThreshold(parseFail, cfg({ blockLevel: "low", hasUI: false }));
		assert.equal(a.kind, "block");
		assert.equal(a.log.logRawResponse, true);
	});

	it("logRawResponse=true when verdict.reason is EMPTY_RESPONSE_REASON", () => {
		const a = decideThreshold(emptyFail, cfg({ blockLevel: "low", hasUI: false }));
		assert.equal(a.kind, "block");
		assert.equal(a.log.logRawResponse, true);
	});

	it("logRawResponse=false for a normal reason (no raw bloat)", () => {
		const a = decideThreshold({ risk: "medium", reason: "moderate" }, cfg({ blockLevel: "low", hasUI: false }));
		assert.equal(a.kind, "block");
		assert.equal(a.log.logRawResponse, false);
	});

	it("confirm action carries logRawResponse for parse-failure verdicts", () => {
		const a = decideThreshold(parseFail, cfg({ blockLevel: "low", hasUI: true }));
		assert.equal(a.kind, "confirm");
		assert.equal(a.logRawResponse, true);
	});

	it("confirm action logRawResponse=false for normal reason", () => {
		const a = decideThreshold(ok, cfg({ blockLevel: "low", hasUI: true }));
		// risk=low at blockLevel=low: 1 >= 1 → confirm path
		assert.equal(a.kind, "confirm");
		assert.equal(a.logRawResponse, false);
	});
});

// ---------------------------------------------------------------------------
// Confirm serialization — parallel tool_call events must not confirm
// concurrently: pi's extension selector is single-slot (showExtensionSelector
// disposes the previous component, orphaning its promise), so a displaced
// confirm would never settle and the awaiting tool_call handler wedges.
// ---------------------------------------------------------------------------

describe("createConfirmQueue", () => {
	it("runs tasks one at a time, in arrival order (FIFO)", async () => {
		const queue = createConfirmQueue();
		const order = [];
		let release1;
		const gate1 = new Promise((resolve) => { release1 = resolve; });
		const p1 = queue(async () => {
			order.push("1-start");
			await gate1;
			order.push("1-end");
			return "one";
		});
		const p2 = queue(async () => {
			order.push("2");
			return "two";
		});
		// A macrotask gives a broken (non-serializing) queue ample ticks to
		// start task 2 while task 1 is still parked on gate1.
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(order, ["1-start"]);
		release1();
		assert.equal(await p1, "one");
		assert.equal(await p2, "two");
		assert.deepEqual(order, ["1-start", "1-end", "2"]);
	});

	it("a rejected task doesn't poison the queue; later tasks still run", async () => {
		const queue = createConfirmQueue();
		const failing = queue(async () => {
			throw new Error("boom");
		});
		const following = queue(async () => "two");
		await assert.rejects(failing, /boom/);
		assert.equal(await following, "two");
	});

	it("value and rejection propagate to each caller only", async () => {
		const queue = createConfirmQueue();
		const ok = queue(async () => "value");
		assert.equal(await ok, "value");
		const failing = queue(async () => {
			throw new Error("caller-sees-this");
		});
		await assert.rejects(failing, /caller-sees-this/);
	});
});

describe("confirm serialization plumbing", () => {
	it("confirmWithUser routes through the process-wide queue", () => {
		assert.match(extensionSource, /const queueConfirm = createConfirmQueue\(\);/);
		assert.match(extensionSource, /return queueConfirm\(\(\) =>\s*\n\s*confirmWithUserInner\(/);
	});

	it("only the confirm phase is queued — classification stays parallel", () => {
		const queuedCalls = extensionSource.match(/queueConfirm\(\(\) =>/g) ?? [];
		assert.equal(queuedCalls.length, 1);
		assert.match(extensionSource, /await classifyCommand\(/);
	});

	it("aborted turn fails a queued confirm fast (no pill, no select)", () => {
		assert.match(
			extensionSource,
			/async function confirmWithUserInner[\s\S]{0,600}?if \(ctx\.signal\?\.aborted\) \{[\s\S]{0,600}?logCommandDecision/,
		);
	});
});

