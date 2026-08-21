import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import type {HttpReply, Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {COMMENTS, claimPage, EXPIRED, guardedShell, LIVE} from "./claim-fixtures.test-support.ts";
import {
	BARE_AT_PATH,
	CLAIMED_ELSEWHERE,
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

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;
const DUPLICATE = /GET .*\/repos\/o\/r\/issues\/4290$/;
const LABELS = /GET .*\/repos\/o\/r\/labels\?/;
const REASON_COMMENT = /POST .*\/repos\/o\/r\/issues\/4312\/comments$/;
const FOLD_COMMENT = /POST .*\/repos\/o\/r\/issues\/4290\/comments$/;
const APPLY_LABEL = /POST .*\/repos\/o\/r\/issues\/4312\/labels$/;
const CLOSE = /PATCH .*\/repos\/o\/r\/issues\/4312$/;

const ACCEPTED: HttpReply = {status: 200, body: "{}"};
const LABELLED: HttpReply = {status: 200, body: "[]"};
const UNREADABLE: HttpReply = {status: 502, body: "{}"};
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const WRITE_FAILED: HttpReply = {status: 500, body: "{}"};

const labels = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

/** What the first request matching `pattern` carried as its JSON body. */
const bodyOf = (
	requests: ReadonlyArray<string>,
	bodies: ReadonlyArray<string>,
	pattern: RegExp,
): string => {
	const at = requests.findIndex((line) => pattern.test(line));
	return at < 0 ? "" : (bodies[at] ?? "");
};

/**
 * A pattern that matches once and then never again.
 *
 * A kill reads the *same* `GET .../issues/<n>` endpoint twice — the precondition read and the
 * read-back — and the fake resolves a line against the first pattern that matches, so scripting the
 * two to different answers needs a pattern that retires itself. It is a real `RegExp` subclass
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

const issue = (over: Record<string, unknown> = {}): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4312,
		title: "t",
		body: `## Summary\n\nsomething\n\n${FOOTER}`,
		state: "open",
		labels: [],
		html_url: "https://example.test/issues/4312",
		...over,
	}),
});

const duplicate = (over: Record<string, unknown> = {}): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4290,
		title: "survivor",
		body: "the surviving issue",
		state: "open",
		labels: [],
		html_url: "https://example.test/issues/4290",
		...over,
	}),
});

const killed: HttpReply = {
	status: 200,
	body: JSON.stringify({
		number: 4312,
		title: "t",
		body: `## Summary\n\nsomething\n\n${FOOTER}`,
		state: "closed",
		state_reason: "not_planned",
		labels: [{name: KILL_LABEL}],
		html_url: "https://example.test/issues/4312",
	}),
};

const comment: HttpReply = {
	status: 201,
	body: JSON.stringify({id: 99, html_url: "https://example.test/issues/4312#issuecomment-99"}),
};

const labelSet = labels(KILL_LABEL, "status:needs-triage", "p1");

const REASON = "Superseded by the merged contract; nothing here moves forward.";

const options = {
	issue: 4312,
	confirm: true,
	duplicateOf: null as number | null,
	token: null as string | null,
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
const happy = (): ReadonlyArray<Scripted> => [
	[firstCallOnly(ISSUE), issue()],
	[ISSUE, killed],
	[LABELS, labelSet],
	[REASON_COMMENT, comment],
	[APPLY_LABEL, LABELLED],
	[CLOSE, ACCEPTED],
];

const runWith = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const shell = guardedShell(script);
	return Effect.runPromise(Effect.provide(runKill({...options, ...overrides}), shell.layer)).then(
		(out) => ({out, requests: shell.requests, bodies: shell.bodies}),
	);
};

describe("runKill", () => {
	it("closes not-planned and prints the outcome line", async () => {
		const {out, requests} = await runWith(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("killed\t4312\tnone\n");
		expect(requests.filter((c) => CLOSE.test(c))).toHaveLength(1);
	});

	it("writes in the order that keeps a failure recoverable: reason, label, close", async () => {
		const {requests} = await runWith(happy());
		const at = (re: RegExp) => requests.findIndex((c) => re.test(c));
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
		const {out, requests} = await runWith([
			[firstCallOnly(ISSUE), issue({body: "I typed this myself."})],
			...happy().slice(1),
		]);
		expect(out.code).toBe(HUMAN_FILED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("Park it with questions instead.");
		expect(requests.some((c) => CLOSE.test(c) || REASON_COMMENT.test(c))).toBe(false);
	});

	it("refuses a body that merely QUOTES the footer — an unanchored match would close it", async () => {
		const {out, requests} = await runWith([
			[
				firstCallOnly(ISSUE),
				issue({body: 'The footer text "Filed by an agent" renders wrong on mobile.'}),
			],
			...happy().slice(1),
		]);
		expect(out.code).toBe(HUMAN_FILED);
		expect(requests.some((c) => CLOSE.test(c))).toBe(false);
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
		const {out, requests} = await runWith(
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
		expect(requests.filter((c) => CLOSE.test(c))).toHaveLength(1);
	});

	it("still refuses a footerless filing by any OTHER author, operator set configured", async () => {
		const {out, requests} = await runWith(
			[
				[firstCallOnly(ISSUE), issue({body: "no footer at all", user: {login: "cansirin"}})],
				...happy().slice(1),
			],
			{env: OPERATOR_ENV},
		);
		expect(out.code).toBe(HUMAN_FILED);
		expect(requests.some((c) => CLOSE.test(c))).toBe(false);
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
		const {out, requests} = await runWith([[ISSUE, UNREADABLE]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("a body that was never read");
		expect(requests.some((c) => CLOSE.test(c))).toBe(false);
	});

	// --- the confirmation guard ----------------------------------------------------------------

	it("refuses an agent-filed issue without --confirm on 13, and writes nothing", async () => {
		const {out, requests} = await runWith(happy(), {confirm: false});
		expect(out.code).toBe(UNCONFIRMED);
		expect(out.stderr.at(-1)).toContain("ADR 0159");
		expect(requests.some((c) => CLOSE.test(c))).toBe(false);
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
		const {out} = await runWith([[ISSUE, NOT_FOUND]]);
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
		const {out, requests} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, labels("p1", "status:needs-triage")],
			...happy().slice(3),
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("invisible to the audit");
		expect(requests.some((c) => CLOSE.test(c))).toBe(false);
	});

	it("refuses an unreadable label set on 11, not on 7", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, UNREADABLE],
			...happy().slice(3),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a closed --duplicate-of on 7 — nobody would read the fold", async () => {
		const {out, requests} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, duplicate({state: "closed"})],
				...happy().slice(2),
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(requests.some((c) => FOLD_COMMENT.test(c))).toBe(false);
	});

	it("refuses an absent --duplicate-of on 7", async () => {
		const {out} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, NOT_FOUND],
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
				[DUPLICATE, UNREADABLE],
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
		const {out, requests} = await runWith(happy(), {
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
		expect(requests.some((c) => CLOSE.test(c))).toBe(false);
	});

	// --- the duplicate fold --------------------------------------------------------------------

	it("folds the redacted body into the survivor and names it on stdout", async () => {
		const {out, requests, bodies} = await runWith(
			[
				[firstCallOnly(ISSUE), issue({body: `repro at /Users/someone/x.md\n\n${FOOTER}`})],
				[ISSUE, killed],
				[DUPLICATE, duplicate()],
				[LABELS, labelSet],
				[FOLD_COMMENT, comment],
				[REASON_COMMENT, comment],
				[APPLY_LABEL, LABELLED],
				[CLOSE, ACCEPTED],
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("killed\t4312\t4290\n");
		const fold = bodyOf(requests, bodies, FOLD_COMMENT);
		expect(fold).toContain("/Users/<redacted>");
		expect(fold).not.toContain("/Users/someone/x.md");
		expect(out.stderr.join("\n")).toContain("redacted 1 machine-local path(s)");
	});

	it("folds before it comments, and comments before it closes", async () => {
		const {requests} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, duplicate()],
				[LABELS, labelSet],
				[FOLD_COMMENT, comment],
				[REASON_COMMENT, comment],
				[APPLY_LABEL, LABELLED],
				[CLOSE, ACCEPTED],
			],
			{duplicateOf: 4290},
		);
		const at = (re: RegExp) => requests.findIndex((c) => re.test(c));
		expect(at(FOLD_COMMENT)).toBeLessThan(at(REASON_COMMENT));
		expect(at(REASON_COMMENT)).toBeLessThan(at(CLOSE));
	});

	// --- the four gated writes -----------------------------------------------------------------

	it("stops at a failed fold: nothing else is attempted and nothing was lost", async () => {
		const {out, requests} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, duplicate()],
				[LABELS, labelSet],
				[FOLD_COMMENT, WRITE_FAILED],
				...happy().slice(3),
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("nothing was lost. Re-run.");
		expect(requests.some((c) => REASON_COMMENT.test(c) || CLOSE.test(c))).toBe(false);
	});

	it("names the landed fold when the reason comment fails — a blind re-run would double-post", async () => {
		const {out} = await runWith(
			[
				[firstCallOnly(ISSUE), issue()],
				[ISSUE, killed],
				[DUPLICATE, duplicate()],
				[LABELS, labelSet],
				[FOLD_COMMENT, comment],
				[REASON_COMMENT, WRITE_FAILED],
				[APPLY_LABEL, LABELLED],
				[CLOSE, ACCEPTED],
			],
			{duplicateOf: 4290},
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the fold on #4290 DID land");
	});

	it("stops at a failed reason comment: the issue stays open and unlabelled", async () => {
		const {out, requests} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, labelSet],
			[REASON_COMMENT, WRITE_FAILED],
			[APPLY_LABEL, LABELLED],
			[CLOSE, ACCEPTED],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("is NOT closed");
		expect(requests.some((c) => APPLY_LABEL.test(c) || CLOSE.test(c))).toBe(false);
	});

	it("stops at a failed label: the issue stays OPEN rather than closed and unauditable", async () => {
		const {out, requests} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, labelSet],
			[REASON_COMMENT, comment],
			[APPLY_LABEL, WRITE_FAILED],
			[CLOSE, ACCEPTED],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("still OPEN and invisible to the kill audit");
		expect(requests.some((c) => CLOSE.test(c))).toBe(false);
	});

	it("reports a failed close as UNKNOWN with the by-hand recovery", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, killed],
			[LABELS, labelSet],
			[REASON_COMMENT, comment],
			[APPLY_LABEL, LABELLED],
			[CLOSE, WRITE_FAILED],
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
				{
					status: 200,
					body: JSON.stringify({
						...JSON.parse(issue().body),
						state: "closed",
						state_reason: "completed",
					}),
				},
			],
			[LABELS, labelSet],
			[REASON_COMMENT, comment],
			[APPLY_LABEL, LABELLED],
			[CLOSE, ACCEPTED],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("reads as done rather than killed");
	});

	it("refuses when the read-back itself fails — the writes landed but the close is unproven", async () => {
		const {out} = await runWith([
			[firstCallOnly(ISSUE), issue()],
			[ISSUE, UNREADABLE],
			[LABELS, labelSet],
			[REASON_COMMENT, comment],
			[APPLY_LABEL, LABELLED],
			[CLOSE, ACCEPTED],
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

/** #5644: kill already refused a closed target; the claim half is what it was missing. */
describe("runKill — the target guard", () => {
	const MINE = "session-mine";
	const THEIRS = "session-theirs";
	const mine = {
		CLAUDE_PIPELINE_REPO: "o/r",
		CLAUDE_CODE_SESSION_ID: MINE,
	} as Record<string, string | undefined>;

	const guard = async (script: ReadonlyArray<Scripted>) => {
		const {out, requests} = await runWith(script, {env: mine});
		return {out, wrote: requests.some((line) => CLOSE.test(line) || REASON_COMMENT.test(line))};
	};

	it("refuses a closed issue on 7 and writes nothing", async () => {
		const {out, wrote} = await guard([
			[ISSUE, issue({state: "closed"})],
			[LABELS, labelSet],
		]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("issue #4312 is already closed.");
		expect(wrote).toBe(false);
	});

	it("refuses a live claim held by another session on 17 and writes nothing", async () => {
		const {out, wrote} = await guard([
			...happy(),
			[COMMENTS, claimPage({session: THEIRS, createdAt: LIVE})],
		]);
		expect(out.code).toBe(CLAIMED_ELSEWHERE);
		expect(wrote).toBe(false);
	});

	it("kills when the live claim is this session's own", async () => {
		const {out} = await guard([
			...happy(),
			[COMMENTS, claimPage({session: MINE, createdAt: LIVE})],
		]);
		expect(out.code).toBe(0);
	});

	it("kills an issue nobody has claimed", async () => {
		const {out} = await guard(happy());
		expect(out.code).toBe(0);
	});

	it("kills when the only foreign claim has aged out", async () => {
		const {out} = await guard([
			...happy(),
			[COMMENTS, claimPage({session: THEIRS, createdAt: EXPIRED})],
		]);
		expect(out.code).toBe(0);
	});
});
