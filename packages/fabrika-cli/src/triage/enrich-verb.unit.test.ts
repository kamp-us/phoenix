import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	COMMENTS,
	claimPage,
	EXPIRED,
	type GuardedSeams,
	guardedShell,
	LIVE,
} from "./claim-fixtures.test-support.ts";
import {
	BARE_AT_PATH,
	CLAIMED_ELSEWHERE,
	EMPTY_STDIN,
	LEAKED_PATH,
	MALFORMED_CRITERIA,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {MARKER_RE, renderMarker, SUMMARY_LINE} from "./enrich.ts";
import {runEnrich} from "./enrich-verb.ts";

const READ = /GET .*\/repos\/o\/r\/issues\/4312$/;
const PATCH = /PATCH .*\/repos\/o\/r\/issues\/4312$/;

const ACCEPTED: HttpReply = {status: 200, body: "{}"};
const UNREADABLE: HttpReply = {status: 502, body: "{}"};
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const WRITE_FAILED: HttpReply = {status: 500, body: "{}"};

const ORIGINAL = "## Summary\n\nThe editor loses focus after a save.";
const REWRITE = "## What to build\n\nKeep focus on the editor across a save.";
const PITCH =
	"**Problem:** yazars lose their place\n**Arc:** fabrika campaign\n**Appetite:** 2 cycles\n**Rabbit-holes:** none\n**No-gos:** no rewrite";

const issue = (body: string): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4312,
		title: "t",
		body,
		state: "open",
		labels: [],
		html_url: "https://example.test/issues/4312",
		milestone: null,
	}),
});

const options = {
	issue: 4312,
	epic: false,
	token: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: REWRITE}),
};

/** The body the PATCH carried, or `null` when the verb wrote nothing. */
const written = (seams: GuardedSeams): string | null => {
	const at = seams.requests.findIndex((line) => PATCH.test(line));
	if (at < 0) return null;
	const sent: unknown = JSON.parse(seams.bodies[at] ?? "{}");
	const body = (sent as {readonly body?: unknown}).body;
	return typeof body === "string" ? body : null;
};

/**
 * Run the verb against a body, echoing whatever it PATCHes back on the read-back.
 *
 * A live GitHub round-trip returns what was written, so a fake that returned a fixed body would
 * make every read-back assertion a statement about the fixture rather than about the verb.
 */
const run = async (before: string, overrides: Partial<typeof options> = {}) => {
	const shell = guardedShell([
		[once(READ), issue(before)],
		[PATCH, ACCEPTED],
	]);
	// Two passes: the first to learn what the verb writes, the second to feed it back as the read-back.
	const probe = await Effect.runPromise(
		Effect.provide(runEnrich({...options, ...overrides}), shell.layer),
	);
	const patched = written(shell);
	if (patched === null) return {outcome: probe, body: null, requests: shell.requests};
	const echoing = guardedShell([
		[once(READ), issue(before)],
		[PATCH, ACCEPTED],
		[READ, issue(patched)],
	]);
	const outcome = await Effect.runPromise(
		Effect.provide(runEnrich({...options, ...overrides}), echoing.layer),
	);
	return {outcome, body: patched, requests: echoing.requests};
};

const runScripted = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runEnrich({...options, ...overrides}), guardedShell(script).layer),
	);

const summaryLines = (body: string): ReadonlyArray<string> =>
	body.split("\n").filter((line) => line === SUMMARY_LINE.rewrite || line === SUMMARY_LINE.wrap);

const markerLines = (body: string): ReadonlyArray<string> =>
	body.split("\n").filter((line) => MARKER_RE.test(line));

describe("runEnrich — a first enrichment", () => {
	it("writes the rewrite above the preserved original and prints the enriched line", async () => {
		const {outcome, body} = await run(ORIGINAL);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("enriched\t4312\t0\n");
		expect(body).toBe(
			`${REWRITE}\n\n---\n\n${renderMarker(4312, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`,
		);
	});

	it("heads a pitch under the two headings with --epic, and never writes a rewrite there", async () => {
		const {outcome, body} = await run(ORIGINAL, {
			epic: true,
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: PITCH}),
		});
		expect(outcome.code).toBe(0);
		expect(body).toBe(
			`## Pitch\n\n${PITCH}\n\n## Epic — awaiting plan\n\n\`plan-epic\` appends its plan and dependency topology below.\n\n${renderMarker(4312, "wrap")}\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n`,
		);
	});

	it("emits the record on STDOUT with --json", async () => {
		const {outcome} = await run(ORIGINAL, {json: true});
		expect(JSON.parse(outcome.stdout)).toEqual({
			outcome: "enriched",
			number: 4312,
			redactions: 0,
			mode: "rewrite",
		});
	});

	it("redacts machine-local paths out of the PRESERVED original and counts them", async () => {
		const leaky = `Repro at /Users/someone/scratch/case.md and /tmp/kampus/out.log.`;
		const {outcome, body} = await run(leaky);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe("enriched\t4312\t2\n");
		expect(body).toContain("/Users/<redacted>");
		expect(body).toContain("/tmp/<redacted>");
		expect(body).not.toContain("scratch/case.md");
		expect(outcome.stderr.some((line) => line.includes("redacted 2 machine-local path(s)"))).toBe(
			true,
		);
	});

	it("says on stderr that it found no marker and is wrapping a first enrichment", async () => {
		const {outcome} = await run(ORIGINAL);
		expect(outcome.stderr[0]).toBe(
			"triage enrich: #4312 carries no enrichment marker — wrapping its body as a first enrichment.",
		);
	});
});

describe("runEnrich — re-enrichment is recognised by the marker, in EITHER mode (#4866)", () => {
	const enriched = `${REWRITE}\n\n---\n\n${renderMarker(4312, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`;

	it("replaces the authored region on a same-mode re-run, leaving one envelope", async () => {
		const {outcome, body} = await run(enriched, {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "## A sharper rewrite"}),
		});
		expect(outcome.code).toBe(0);
		expect(body).toBe(
			`## A sharper rewrite\n\n---\n\n${renderMarker(4312, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`,
		);
		expect(summaryLines(body ?? "")).toEqual([SUMMARY_LINE.rewrite]);
	});

	it("does NOT double-wrap a default-mode envelope re-run under --epic — the cross-mode class", async () => {
		const {outcome, body} = await run(enriched, {
			epic: true,
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: PITCH}),
		});
		expect(outcome.code).toBe(0);
		// One envelope, still the default-mode one, and the original was never re-wrapped as a "brief".
		expect(summaryLines(body ?? "")).toEqual([SUMMARY_LINE.rewrite]);
		expect(markerLines(body ?? "")).toEqual([renderMarker(4312, "wrap")]);
		expect(body).toContain(`<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>`);
		expect(body).toContain("## Epic — awaiting plan");
	});

	it("does NOT double-wrap an --epic envelope re-run in default mode either", async () => {
		const epicBody = `## Pitch\n\n${PITCH}\n\n## Epic — awaiting plan\n\n${renderMarker(4312, "wrap")}\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n`;
		const {body} = await run(epicBody);
		expect(summaryLines(body ?? "")).toEqual([SUMMARY_LINE.wrap]);
		expect(body).not.toContain("## Pitch");
	});

	it("preserves the plan and dependency topology plan-epic wrote BELOW the wrap", async () => {
		const planned = `## Pitch\n\nstale\n\n## Epic — awaiting plan\n\n${renderMarker(4312, "wrap")}\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n\n## Plan (plan-epic)\n\nPhase 1: #4400\n\n## Dependencies\n\n#4400 requires: none\n`;
		const {body} = await run(planned, {
			epic: true,
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: PITCH}),
		});
		expect(body).toContain("## Plan (plan-epic)\n\nPhase 1: #4400");
		expect(body).toContain("## Dependencies\n\n#4400 requires: none");
		expect(body).toContain(PITCH);
		expect(body).not.toContain("stale");
		expect(summaryLines(body ?? "")).toEqual([SUMMARY_LINE.wrap]);
	});

	it("re-reports zero redactions on a re-enrich — the preserved bytes are not rescanned", async () => {
		const already = `${REWRITE}\n\n---\n\n${renderMarker(4312, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\nRepro at /Users/<redacted> and one raw /tmp/kampus/out.log.\n\n</details>\n`;
		const {outcome, body} = await run(already);
		expect(outcome.stdout).toBe("enriched\t4312\t0\n");
		// Verbatim means verbatim: the preserved region is not re-redacted behind the caller's back.
		expect(body).toContain("/tmp/kampus/out.log");
	});
});

describe("runEnrich — the marker binds THIS issue, so a paste reads as fresh", () => {
	it("wraps an enriched body pasted in from another issue instead of overwriting above it", async () => {
		const pasted = `Someone else's rewrite\n\n---\n\n${renderMarker(4290, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`;
		const {outcome, body} = await run(pasted);
		expect(outcome.code).toBe(0);
		// The whole paste — foreign marker included — is preserved as the original, under OUR marker.
		expect(body).toBe(
			`${REWRITE}\n\n---\n\n${renderMarker(4312, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${pasted.trim()}\n\n</details>\n`,
		);
		expect(body?.startsWith(REWRITE)).toBe(true);
		expect(body).toContain("Someone else's rewrite");
	});

	it("says on stderr which issue the foreign marker bound", async () => {
		const pasted = `x\n\n${renderMarker(4290, "wrap")}\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n`;
		const {outcome} = await run(pasted);
		expect(outcome.stderr[0]).toBe(
			"triage enrich: #4312 carries an enrichment marker bound to #4290, not #4312 — reading it as a pasted body and wrapping it as a first enrichment.",
		);
	});

	it("converges on the SECOND pass, because our own marker now leads the body", async () => {
		const pasted = `Someone else's rewrite\n\n---\n\n${renderMarker(4290, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`;
		const first = await run(pasted);
		const second = await run(first.body ?? "");
		expect(second.body).toBe(first.body);
		expect(markerLines(second.body ?? "")).toEqual([
			renderMarker(4312, "rewrite"),
			renderMarker(4290, "rewrite"),
		]);
	});
});

describe("runEnrich — legacy migration", () => {
	const legacy = `${REWRITE}\n\n---\n\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`;

	it("recognises a pre-marker envelope, keeps it, and stamps the marker in passing", async () => {
		const {outcome, body} = await run(legacy, {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "## A sharper rewrite"}),
		});
		expect(outcome.code).toBe(0);
		expect(body).toBe(
			`## A sharper rewrite\n\n---\n\n${renderMarker(4312, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`,
		);
		expect(summaryLines(body ?? "")).toEqual([SUMMARY_LINE.rewrite]);
		expect(outcome.stderr[0]).toContain("pre-marker v1 envelope");
	});

	it("migrates a legacy body across a mode switch without nesting it", async () => {
		const {body} = await run(legacy, {
			epic: true,
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: PITCH}),
		});
		expect(summaryLines(body ?? "")).toEqual([SUMMARY_LINE.rewrite]);
		expect(markerLines(body ?? "")).toEqual([renderMarker(4312, "wrap")]);
	});

	it("wraps a body that merely QUOTES an envelope rather than overwriting the reporter's framing", async () => {
		const quoting = `I think this format is wrong:\n\n<details>\n${SUMMARY_LINE.wrap}\n\n${ORIGINAL}\n\n</details>\n\nWhat should it be?\n`;
		const {body} = await run(quoting);
		expect(body).toContain("I think this format is wrong:");
		expect(body).toContain("What should it be?");
		expect(summaryLines(body ?? "")).toEqual([SUMMARY_LINE.rewrite, SUMMARY_LINE.wrap]);
	});
});

describe("runEnrich — the composed body's criteria block must be one the wire reader accepts (#5565, ADR 0288)", () => {
	it("refuses a level-2 heading on 15, naming the level it read and the level expected", async () => {
		const shell = guardedShell([[READ, issue(ORIGINAL)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runEnrich({
					...options,
					stdin: Effect.succeed<StdinRead>({
						_tag: "Text",
						text: `${REWRITE}\n\n## Acceptance criteria\n\n- [ ] keep focus\n`,
					}),
				}),
				shell.layer,
			),
		);
		expect(outcome.code).toBe(MALFORMED_CRITERIA);
		expect(outcome.stderr.at(-1)).toContain("heading level 2, expected 3");
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("accepts a conforming level-3 block", async () => {
		const {outcome} = await run(ORIGINAL, {
			stdin: Effect.succeed<StdinRead>({
				_tag: "Text",
				text: `${REWRITE}\n\n### Acceptance criteria\n\n- [ ] keep focus\n`,
			}),
		});
		expect(outcome.code).toBe(0);
	});

	it("accepts a rewrite that carries no criteria block at all — Absent is never a defect", async () => {
		const {outcome} = await run(ORIGINAL);
		expect(outcome.code).toBe(0);
	});

	it("never blocks a re-enrichment on a `##` heading inside the PRESERVED original", async () => {
		const driftedOriginal = `## Summary\n\nx\n\n## Acceptance criteria\n\n- [ ] old item`;
		const enriched = `${REWRITE}\n\n---\n\n${renderMarker(4312, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${driftedOriginal}\n\n</details>\n`;
		const {outcome, body} = await run(enriched, {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "## A sharper rewrite"}),
		});
		expect(outcome.code).toBe(0);
		expect(body).toContain("## Acceptance criteria");
	});

	it("refuses a drifted block in an --epic pitch too, where the envelope heads it with `## Pitch`", async () => {
		const shell = guardedShell([[READ, issue(ORIGINAL)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runEnrich({
					...options,
					epic: true,
					stdin: Effect.succeed<StdinRead>({
						_tag: "Text",
						text: "**Problem:** x\n\n## Acceptance criteria\n\n- [ ] keep focus\n",
					}),
				}),
				shell.layer,
			),
		);
		expect(outcome.code).toBe(MALFORMED_CRITERIA);
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});
});

describe("runEnrich — refusals", () => {
	it("refuses a FAILED stdin read as UNKNOWN, never as empty", async () => {
		const outcome = await runScripted([[READ, issue(ORIGINAL)]], {
			stdin: Effect.succeed<StdinRead>({_tag: "Failed", reason: "EAGAIN"}),
		});
		expect(outcome.code).toBe(1);
		expect(outcome.stderr.at(-1)).toContain("never empty");
	});

	it("refuses empty-but-READ stdin on 3, and writes nothing", async () => {
		const shell = guardedShell([[READ, issue(ORIGINAL)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runEnrich({...options, stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "  \n"})}),
				shell.layer,
			),
		);
		expect(outcome.code).toBe(EMPTY_STDIN);
		expect(shell.requests).toEqual([]);
	});

	it("refuses a bare @ reference on 6", async () => {
		const outcome = await runScripted([[READ, issue(ORIGINAL)]], {
			stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "@notes/rewrite.md"}),
		});
		expect(outcome.code).toBe(BARE_AT_PATH);
	});

	it("refuses a machine-local path in the AUTHORED rewrite on 5, while redacting the original", async () => {
		const shell = guardedShell([[READ, issue(ORIGINAL)]]);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runEnrich({
					...options,
					stdin: Effect.succeed<StdinRead>({
						_tag: "Text",
						text: "see /Users/someone/scratch/case.md",
					}),
				}),
				shell.layer,
			),
		);
		expect(outcome.code).toBe(LEAKED_PATH);
		expect(outcome.stderr.at(-1)).toContain("rewrite it repo-relative");
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses an issue proven absent on 7", async () => {
		const outcome = await runScripted([[READ, NOT_FOUND]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.at(-1)).toBe("triage enrich: issue #4312 not found in o/r.");
	});

	it("separates an UNREADABLE issue from an absent one, and writes nothing", async () => {
		const shell = guardedShell([[READ, UNREADABLE]]);
		const outcome = await Effect.runPromise(Effect.provide(runEnrich(options), shell.layer));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("an original that was never read");
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("refuses an EMPTY body rather than preserving nothing as though it were the record", async () => {
		const shell = guardedShell([[READ, issue("   \n")]]);
		const outcome = await Effect.runPromise(Effect.provide(runEnrich(options), shell.layer));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.at(-1)).toContain("there is no original to preserve");
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});

	it("reports a failed PATCH as UNKNOWN on 8, never as a failure to write", async () => {
		const outcome = await runScripted([
			[READ, issue(ORIGINAL)],
			[PATCH, WRITE_FAILED],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("UNKNOWN whether the body changed");
	});

	it("refuses on 9 when the read-back does not match what was written", async () => {
		const outcome = await runScripted([
			[once(READ), issue(ORIGINAL)],
			[PATCH, ACCEPTED],
			[READ, issue("something else entirely")],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("read-back does not match");
	});

	it("refuses on 9 when the read-back itself fails", async () => {
		const outcome = await runScripted([
			[once(READ), issue(ORIGINAL)],
			[PATCH, ACCEPTED],
			[READ, UNREADABLE],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.at(-1)).toContain("could not be read back");
	});

	it("tolerates the round-trip's line-ending and trailing-whitespace normalisation", async () => {
		const composed = `${REWRITE}\n\n---\n\n${renderMarker(4312, "rewrite")}\n<details>\n${SUMMARY_LINE.rewrite}\n\n${ORIGINAL}\n\n</details>\n`;
		const outcome = await runScripted([
			[once(READ), issue(ORIGINAL)],
			[PATCH, ACCEPTED],
			[READ, issue(`${composed.replace(/\n/g, "\r\n")}\r\n\r\n`)],
		]);
		expect(outcome.code).toBe(0);
	});

	it("refuses a non-issue number, and an unresolvable repo, before reading anything", async () => {
		expect((await runScripted([], {issue: -1})).code).toBe(1);
		const shell = guardedShell([]);
		const outcome = await Effect.runPromise(
			Effect.provide(runEnrich({...options, env: {}}), shell.layer),
		);
		expect(outcome.code).toBe(1);
		expect(shell.requests.some((line) => PATCH.test(line))).toBe(false);
	});
});

/** #5644: the claim protocol was advisory, and this is the verb that overwrote #5642's body. */
describe("runEnrich — the target guard", () => {
	const MINE = "session-mine";
	const THEIRS = "session-theirs";
	const mine = {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: MINE} as Record<
		string,
		string | undefined
	>;
	const closed: HttpReply = {
		status: 200,
		body: JSON.stringify({
			number: 4312,
			title: "t",
			body: ORIGINAL,
			state: "closed",
			labels: [],
			html_url: "https://example.test/issues/4312",
			milestone: null,
		}),
	};

	const guard = async (script: ReadonlyArray<Scripted>) => {
		const shell = guardedShell(script);
		const outcome = await Effect.runPromise(
			Effect.provide(runEnrich({...options, env: mine}), shell.layer),
		);
		return {outcome, patched: shell.requests.some((line) => PATCH.test(line))};
	};

	it("refuses a closed issue on 7 and writes nothing", async () => {
		const {outcome, patched} = await guard([[READ, closed]]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(patched).toBe(false);
	});

	it("refuses a live claim held by another session on 17 and writes nothing", async () => {
		const {outcome, patched} = await guard([
			[READ, issue(ORIGINAL)],
			[COMMENTS, claimPage({session: THEIRS, createdAt: LIVE})],
			[PATCH, ACCEPTED],
		]);
		expect(outcome.code).toBe(CLAIMED_ELSEWHERE);
		expect(patched).toBe(false);
	});

	it("writes when the live claim is this session's own", async () => {
		const {patched} = await guard([
			[once(READ), issue(ORIGINAL)],
			[COMMENTS, claimPage({session: MINE, createdAt: LIVE})],
			[PATCH, ACCEPTED],
			[READ, issue(ORIGINAL)],
		]);
		expect(patched).toBe(true);
	});

	it("writes over an issue nobody has claimed", async () => {
		const {patched} = await guard([
			[once(READ), issue(ORIGINAL)],
			[PATCH, ACCEPTED],
			[READ, issue(ORIGINAL)],
		]);
		expect(patched).toBe(true);
	});

	it("writes when the only foreign claim has aged out", async () => {
		const {patched} = await guard([
			[once(READ), issue(ORIGINAL)],
			[COMMENTS, claimPage({session: THEIRS, createdAt: EXPIRED})],
			[PATCH, ACCEPTED],
			[READ, issue(ORIGINAL)],
		]);
		expect(patched).toBe(true);
	});
});
