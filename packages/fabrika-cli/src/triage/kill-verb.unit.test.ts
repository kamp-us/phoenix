import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	HUMAN_FILED,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNCONFIRMED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {KILL_LABEL, runKill} from "./kill-verb.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const DUPLICATE = /^gh api repos\/o\/r\/issues\/4290$/;
const LABELS = /labels\?per_page=100/;
const REASON_COMMENT = /repos\/o\/r\/issues\/4312\/comments -f/;
const FOLD_COMMENT = /repos\/o\/r\/issues\/4290\/comments -f/;
const APPLY_LABEL = /repos\/o\/r\/issues\/4312\/labels/;
const CLOSE = /--method PATCH repos\/o\/r\/issues\/4312 -f state=closed/;

/**
 * A pattern that matches once and then never again.
 *
 * A kill makes the *same* `gh api repos/o/r/issues/<n>` call twice — the precondition read and the
 * read-back — and `fakeShell` resolves a line against the first pattern that matches, so scripting
 * the two to different answers needs a pattern that retires itself. It is a real `RegExp` subclass
 * rather than a cast object because the package forbids type assertions.
 */
class FirstCallOnly extends RegExp {
	private used = false;
	override test(line: string): boolean {
		if (this.used || !super.test(line)) return false;
		this.used = true;
		return true;
	}
}

const firstCallOnly = (re: RegExp): RegExp => new FirstCallOnly(re.source, re.flags);

const FOOTER = "---\n<sub>Filed by an agent · 2026-01-01T00:00:00Z</sub>";

const issue = (over: Record<string, unknown> = {}) =>
	okOut(
		JSON.stringify({
			number: 4312,
			title: "t",
			body: `## Summary\n\nsomething\n\n${FOOTER}`,
			state: "open",
			labels: [],
			html_url: "https://example.test/issues/4312",
			...over,
		}),
	);

const duplicate = (over: Record<string, unknown> = {}) =>
	okOut(
		JSON.stringify({
			number: 4290,
			title: "survivor",
			body: "the surviving issue",
			state: "open",
			labels: [],
			html_url: "https://example.test/issues/4290",
			...over,
		}),
	);

const killed = okOut(
	JSON.stringify({
		number: 4312,
		title: "t",
		body: `## Summary\n\nsomething\n\n${FOOTER}`,
		state: "closed",
		state_reason: "not_planned",
		labels: [{name: KILL_LABEL}],
		html_url: "https://example.test/issues/4312",
	}),
);

const comment = okOut(
	JSON.stringify({id: 99, html_url: "https://example.test/issues/4312#issuecomment-99"}),
);

const labelSet = okOut([KILL_LABEL, "status:needs-triage", "p1"].join("\n"));

const REASON = "Superseded by the merged contract; nothing here moves forward.";

const options = {
	issue: 4312,
	confirm: true,
	duplicateOf: null as number | null,
	repo: null as string | null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: REASON}),
};

/** A placeholder operator set — these tests measure the mechanism, never a real login. */
const OPERATOR_ENV = {
	CLAUDE_PIPELINE_REPO: "o/r",
	FABRIKA_OPERATOR_ACCOUNTS: "operator-account",
} as Record<string, string | undefined>;

/** The whole sequence green: precondition read, label set, three writes, a not-planned read-back. */
const happy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[firstCallOnly(ISSUE), issue()],
	[ISSUE, killed],
	[LABELS, labelSet],
	[REASON_COMMENT, comment],
	[APPLY_LABEL, okOut("[]")],
	[CLOSE, okOut("{}")],
];

const runWith = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(Effect.provide(runKill({...options, ...overrides}), shell.layer)).then(
		(out) => ({out, calls: shell.calls}),
	);
};

describe("runKill", () => {
	it("closes not-planned and prints the outcome line", async () => {
		const {out, calls} = await runWith(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("killed\t4312\tnone\n");
		expect(calls.filter((c) => CLOSE.test(c))).toHaveLength(1);
	});

	it("writes in the order that keeps a failure recoverable: reason, label, close", async () => {
		const {calls} = await runWith(happy());
		const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
		expect(at(REASON_COMMENT)).toBeLessThan(at(APPLY_LABEL));
		expect(at(APPLY_LABEL)).toBeLessThan(at(CLOSE));
	});

	it("reports the label count it scanned", async () => {
		const {out} = await runWith(happy());
		expect(out.stderr.join("\n")).toContain("triage kill: scanned 3 labels in o/r.");
	});

	it("emits the result object with --json", async () => {
		const {out} = await runWith(happy(), {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "killed",
			number: 4312,
			foldedInto: null,
			redactions: 0,
			provenance: "agent",
		});
	});

	// --- the provenance guard ------------------------------------------------------------------

	it("refuses a human-filed issue on 12 and writes nothing", async () => {
		const {out, calls} = await runWith([
			[firstCallOnly(ISSUE), issue({body: "I typed this myself."})],
			...happy().slice(1),
		]);
		expect(out.code).toBe(HUMAN_FILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("Park it with questions instead.");
		expect(calls.some((c) => CLOSE.test(c) || REASON_COMMENT.test(c))).toBe(false);
	});

	it("refuses a body that merely QUOTES the footer — an unanchored match would close it", async () => {
		const {out, calls} = await runWith([
			[
				firstCallOnly(ISSUE),
				issue({body: 'The footer text "Filed by an agent" renders wrong on mobile.'}),
			],
			...happy().slice(1),
		]);
		expect(out.code).toBe(HUMAN_FILED);
		expect(calls.some((c) => CLOSE.test(c))).toBe(false);
	});

	it("refuses an empty body as human, and says the answer was defaulted", async () => {
		const {out} = await runWith([[firstCallOnly(ISSUE), issue({body: ""})], ...happy().slice(1)]);
		expect(out.code).toBe(HUMAN_FILED);
		expect(out.stderr.join("\n")).toContain("fail-closed");
	});

	it("names the unset operator config on a 12, so the cause of the refusal is readable", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue({body: "I typed this myself."})],
			...happy().slice(1),
		]);
		expect(out.stderr.join("\n")).toContain("FABRIKA_OPERATOR_ACCOUNTS");
	});

	it("kills a FOOTERLESS filing authored by a configured operator account (#4619)", async () => {
		const {out, calls} = await runWith(
			[
				[
					firstCallOnly(ISSUE),
					issue({body: "no footer at all", user: {login: "operator-account"}}),
				],
				[ISSUE, killed],
				...happy().slice(2),
			],
			{env: OPERATOR_ENV},
		);
		expect(out.code).toBe(0);
		expect(calls.filter((c) => CLOSE.test(c))).toHaveLength(1);
	});

	it("still refuses a footerless filing by any OTHER author, operator set configured", async () => {
		const {out, calls} = await runWith(
			[
				[firstCallOnly(ISSUE), issue({body: "no footer at all", user: {login: "cansirin"}})],
				...happy().slice(1),
			],
			{env: OPERATOR_ENV},
		);
		expect(out.code).toBe(HUMAN_FILED);
		expect(calls.some((c) => CLOSE.test(c))).toBe(false);
	});

	it("drops the empty-body fail-closed notice when the operator author decided the answer", async () => {
		const {out} = await runWith(
			[
				[firstCallOnly(ISSUE), issue({body: "", user: {login: "operator-account"}})],
				[ISSUE, killed],
				...happy().slice(2),
			],
			{env: OPERATOR_ENV},
		);
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).not.toContain("fail-closed");
	});

	it("refuses an UNREADABLE body on 11, never as a human verdict", async () => {
		const {out, calls} = await runWith([[ISSUE, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("a body that was never read");
		expect(calls.some((c) => CLOSE.test(c))).toBe(false);
	});

	// --- the confirmation guard ----------------------------------------------------------------

	it("refuses an agent-filed issue without --confirm on 13, and writes nothing", async () => {
		const {out, calls} = await runWith(happy(), {confirm: false});
		expect(out.code).toBe(UNCONFIRMED);
		expect(out.stderr.at(-1)).toContain("ADR 0159");
		expect(calls.some((c) => CLOSE.test(c))).toBe(false);
	});

	it("checks provenance BEFORE confirmation — a human-filed issue refuses on 12 either way", async () => {
		const {out} = await runWith(
			[[firstCallOnly(ISSUE), issue({body: "hand-typed"})], ...happy().slice(1)],
			{confirm: false},
		);
		expect(out.code).toBe(HUMAN_FILED);
	});

	// --- preconditions -------------------------------------------------------------------------

	it("refuses an absent issue on 7", async () => {
		const {out} = await runWith([[ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("triage kill: issue #4312 not found in o/r.");
	});

	it("refuses an already-closed issue on 7", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue({state: "closed"})],
			...happy().slice(1),
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("triage kill: issue #4312 is already closed.");
	});

	it("refuses when closed-by-triage is absent from the repo — the kill would be unauditable", async () => {
		const {out, calls} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, okOut("p1\nstatus:needs-triage")],
			...happy().slice(3),
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("invisible to the audit");
		expect(calls.some((c) => CLOSE.test(c))).toBe(false);
	});

	it("refuses an unreadable label set on 11, not on 7", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, errOut("gh: Bad gateway (HTTP 502)")],
			...happy().slice(3),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a closed --duplicate-of on 7 — nobody would read the fold", async () => {
		const {out, calls} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, duplicate({state: "closed"})],
				...happy().slice(2),
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(calls.some((c) => FOLD_COMMENT.test(c))).toBe(false);
	});

	it("refuses an absent --duplicate-of on 7", async () => {
		const {out} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, errOut("gh: Not Found (HTTP 404)")],
				...happy().slice(2),
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	it("refuses an unreadable --duplicate-of on 11", async () => {
		const {out} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, errOut("gh: Bad gateway (HTTP 502)")],
				...happy().slice(2),
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	// --- the authored reason -------------------------------------------------------------------

	it("refuses an empty-but-read stdin on 3, and says how many bytes it read", async () => {
		const {out} = await runWith(happy(), {
			stdin: Effect.succeed({_tag: "Text", text: "   "} satisfies StdinRead),
		});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stderr.at(-1)).toBe(
			"triage kill: no body on stdin — refusing an unauditable kill: pipe the reason in.",
		);
		// The byte count is what tells a read-but-empty pipe (3) from an unread one (1).
		expect(out.stderr[0]).toBe("triage kill: stdin was read and held 3 byte(s).");
	});

	it("refuses a FAILED stdin read on 1, never on the empty code", async () => {
		const {out} = await runWith(happy(), {
			stdin: Effect.succeed({_tag: "Failed", reason: "EAGAIN"} satisfies StdinRead),
		});
		expect(out.code).toBe(1);
		expect(out.code).not.toBe(EMPTY_STDIN);
		expect(out.stderr.at(-1)).toBe(
			"triage kill: could not read stdin: EAGAIN — the reason is UNKNOWN, never empty.",
		);
	});

	it("refuses a bare @ reason on 6 — masking a placeholder never terminates", async () => {
		const {out} = await runWith(happy(), {
			stdin: Effect.succeed({_tag: "Text", text: "@/tmp/reason.md"} satisfies StdinRead),
		});
		expect(out.code).toBe(BARE_AT_PATH);
		expect(out.stderr.at(-1)).toBe(
			'triage kill: the reason is a bare "@" path reference — the body never arrived. Send it on stdin.',
		);
	});

	it("seats a reason that is BOTH a bare @ and a leak on 6 — the bare @ is tested first", async () => {
		const {out} = await runWith(happy(), {
			stdin: Effect.succeed({
				_tag: "Text",
				text: "@/Users/someone/notes/why.md",
			} satisfies StdinRead),
		});
		expect(out.code).toBe(BARE_AT_PATH);
		expect(out.code).not.toBe(LEAKED_PATH);
	});

	it("refuses a machine-local path in the authored reason on 5, listing every hit", async () => {
		const {out, calls} = await runWith(happy(), {
			stdin: Effect.succeed({
				_tag: "Text",
				text: "see /Users/someone/notes/why.md\nand /Users/someone/notes/how.md",
			} satisfies StdinRead),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr.at(-1)).toBe(
			"triage kill: the reason carries a machine-local path at line 1 (absolute home root) — rewrite it repo-relative.",
		);
		expect(out.stderr.slice(0, -1)).toEqual([
			"  line 1, absolute home root",
			"  line 2, absolute home root",
		]);
		expect(calls.some((c) => CLOSE.test(c))).toBe(false);
	});

	// --- the duplicate fold --------------------------------------------------------------------

	it("folds the redacted body into the survivor and names it on stdout", async () => {
		const {out, calls} = await runWith(
			[
				[firstCallOnly(ISSUE), issue({body: `repro at /Users/someone/x.md\n\n${FOOTER}`})],
				[ISSUE, killed],
				[DUPLICATE, duplicate()],
				[LABELS, labelSet],
				[FOLD_COMMENT, comment],
				[REASON_COMMENT, comment],
				[APPLY_LABEL, okOut("[]")],
				[CLOSE, okOut("{}")],
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("killed\t4312\t4290\n");
		const fold = calls.find((c) => FOLD_COMMENT.test(c)) ?? "";
		expect(fold).toContain("/Users/<redacted>");
		expect(fold).not.toContain("/Users/someone/x.md");
		expect(out.stderr.join("\n")).toContain("redacted 1 machine-local path(s)");
	});

	it("folds before it comments, and comments before it closes", async () => {
		const {calls} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, duplicate()],
				[LABELS, labelSet],
				[FOLD_COMMENT, comment],
				[REASON_COMMENT, comment],
				[APPLY_LABEL, okOut("[]")],
				[CLOSE, okOut("{}")],
			],
			{duplicateOf: 4290},
		);
		const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
		expect(at(FOLD_COMMENT)).toBeLessThan(at(REASON_COMMENT));
		expect(at(REASON_COMMENT)).toBeLessThan(at(CLOSE));
	});

	// --- the four gated writes -----------------------------------------------------------------

	it("stops at a failed fold: nothing else is attempted and nothing was lost", async () => {
		const {out, calls} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, duplicate()],
				[LABELS, labelSet],
				[FOLD_COMMENT, errOut("gh: timeout")],
				...happy().slice(3),
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("nothing was lost. Re-run.");
		expect(calls.some((c) => REASON_COMMENT.test(c) || CLOSE.test(c))).toBe(false);
	});

	it("names the landed fold when the reason comment fails — a blind re-run would double-post", async () => {
		const {out} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, duplicate()],
				[LABELS, labelSet],
				[FOLD_COMMENT, comment],
				[REASON_COMMENT, errOut("gh: timeout")],
				[APPLY_LABEL, okOut("[]")],
				[CLOSE, okOut("{}")],
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the fold on #4290 DID land");
	});

	it("stops at a failed reason comment: the issue stays open and unlabelled", async () => {
		const {out, calls} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, labelSet],
			[REASON_COMMENT, errOut("gh: timeout")],
			[APPLY_LABEL, okOut("[]")],
			[CLOSE, okOut("{}")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("is NOT closed");
		expect(calls.some((c) => APPLY_LABEL.test(c) || CLOSE.test(c))).toBe(false);
	});

	it("stops at a failed label: the issue stays OPEN rather than closed and unauditable", async () => {
		const {out, calls} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, labelSet],
			[REASON_COMMENT, comment],
			[APPLY_LABEL, errOut("gh: timeout")],
			[CLOSE, okOut("{}")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("still OPEN and invisible to the kill audit");
		expect(calls.some((c) => CLOSE.test(c))).toBe(false);
	});

	it("reports a failed close as UNKNOWN with the by-hand recovery", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, labelSet],
			[REASON_COMMENT, comment],
			[APPLY_LABEL, okOut("[]")],
			[CLOSE, errOut("gh: timeout")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("state_reason=not_planned");
	});

	// --- the read-back -------------------------------------------------------------------------

	it("refuses a close that reads back as completed — done is not killed", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[
				ISSUE,
				okOut(
					JSON.stringify({
						...JSON.parse(issue().stdout),
						state: "closed",
						state_reason: "completed",
					}),
				),
			],
			[LABELS, labelSet],
			[REASON_COMMENT, comment],
			[APPLY_LABEL, okOut("[]")],
			[CLOSE, okOut("{}")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("reads as done rather than killed");
	});

	it("refuses when the read-back itself fails — the writes landed but the close is unproven", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, errOut("gh: Bad gateway (HTTP 502)")],
			[LABELS, labelSet],
			[REASON_COMMENT, comment],
			[APPLY_LABEL, okOut("[]")],
			[CLOSE, okOut("{}")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("the close is unverified");
	});

	// --- usage ---------------------------------------------------------------------------------

	it("refuses folding an issue into itself", async () => {
		const {out} = await runWith(happy(), {duplicateOf: 4312});
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("into itself");
	});
});
