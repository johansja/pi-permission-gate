/**
 * Tests for the Pi Permission Gate extension.
 *
 * Run with: node --import tsx --test pi-permission-gate.test.mjs
 *
 * Two layers:
 *   - Pure helpers imported from the extension module via tsx (same TS loader
 *     pi uses at runtime). Covers parseVerdict / riskLevelIndex /
 *     buildDisplaySignature / truncateToChars / stripCodeFences invariants.
 *   - Source-shape assertions for config/env plumbing and the CWD-aware system
 *     prompt.
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

	it("mcp: server/tool absent → 'mcp' fallback", () => {
		assert.equal(buildDisplaySignature("mcp", {}), "mcp");
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
			description: "## Intent\n\nCAPI creates BitdeerAIMachine objects…".repeat(10),
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

	it("thinkingLevel setting is read and passed as reasoning", () => {
		assert.match(extensionSource, /settings\.thinkingLevel/);
		assert.match(extensionSource, /reasoning: thinkingLevel/);
	});

	it("fallback setting is validated against allow/block/confirm", () => {
		assert.match(extensionSource, /FALLBACK_LEVELS/);
	});

	it("has readPermissionGateConfig function (consolidated single read)", () => {
		assert.match(extensionSource, /function readPermissionGateConfig/);
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

	it("logCommandDecision accepts an optional rawResponse param", () => {
		assert.match(extensionSource, /reason\?: string,\s*\n\s*rawResponse\?: string,\s*\n\): void/);
		// rawResponse is attached to the log entry (capped at 2000 chars) ...
		assert.match(extensionSource, /if \(rawResponse !== undefined\)/);
		assert.match(extensionSource, /rawResponse\.length > 2000/);
		assert.match(extensionSource, /\u2026\[truncated\]/);
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

	it("confirmWithUser threads rawResponse to its log calls", () => {
		assert.match(
			extensionSource,
			/async function confirmWithUser\([\s\S]*?opts: ConfirmOptions,\s*\n\s*rawResponse\?: string,\s*\n\)/,
		);
		assert.match(
			extensionSource,
			/logCommandDecision\(command, opts\.risk, blockLevel, "blocked", opts\.blockedLogReason, rawResponse\)/,
		);
		assert.match(
			extensionSource,
			/logCommandDecision\(command, opts\.risk, blockLevel, "confirmed", opts\.confirmedLogReason, rawResponse\)/,
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
		const matches = extensionSource.match(/confirmWithUser\(pi, ctx, command, signature, blockLevel/g) ?? [];
		assert.equal(matches.length, 2, "expected signature at both call sites");
	});

	it("notify body carries the notifyLabel (tool name)", () => {
		assert.match(extensionSource, /risk — \$\{notifyLabel\}/);
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
		assert.equal(a.opts.notifyBody, "Permission gate failed: kaboom: detail");
		assert.equal(a.opts.promptTitle, "AI safety check failed");
		assert.equal(a.opts.promptBody, "The LLM could not classify this operation: kaboom: detail");
		assert.equal(a.opts.blockedLogReason, "Blocked by user (AI check failed)");
		assert.equal(a.opts.confirmedLogReason, "User confirmed after AI check failed");
		assert.equal(a.opts.blockReason, "Blocked by user (AI check failed)");
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
		notifyLabel: "bash",
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

	it("block + hasUI=true → confirm with risk-scoped opts and notifyLabel", () => {
		const a = decideThreshold({ risk: "medium", reason: "moderate" }, cfg({ blockLevel: "low", hasUI: true, notifyLabel: "atlassian_createIssue" }));
		assert.equal(a.kind, "confirm");
		assert.equal(a.opts.risk, "medium");
		assert.equal(a.opts.notifyBody, "Permission gate: medium risk — atlassian_createIssue");
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
