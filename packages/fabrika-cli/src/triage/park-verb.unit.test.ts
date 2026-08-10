import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {runPark} from "./park-verb.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4290$/;
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;
const COMMENT = /^gh api --method POST repos\/o\/r\/issues\/4290\/comments /;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/4290 -F milestone=/;
const REMOVE = /^gh api --method DELETE repos\/o\/r\/issues\/4290\/labels\//;
const ADD = /^gh api --method POST repos\/o\/r\/issues\/4290\/labels /;

const QUESTIONS = "Which of the two sozluk surfaces does this cover?";

const issue = (labels: ReadonlyArray<string>, milestone: number | null): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4290,
			title: "t",
			body: "b",
			state: "open",
			labels: labels.map((name) => ({name})),
			html_url: "https://example.test/issues/4290",
			milestone: milestone === null ? null : {number: milestone},
		}),
	);

const VOCABULARY = okOut(
	["type:bug", "p1", "status:needs-triage", "status:needs-info", "ready-for:agent"].join("\n"),
);

const POSTED = okOut(
	JSON.stringify({
		id: 5170421888,
		html_url: "https://example.test/issues/4290#issuecomment-5170421888",
	}),
);

const options = {
	issue: 4290,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: QUESTIONS}),
};

/** Observed: a fully priced issue. Read back: nothing but the parked status. */
const happy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[once(ISSUE), issue(["type:bug", "p1", "status:triaged", "ready-for:agent"], 47)],
	[ISSUE, issue(["status:needs-info"], null)],
	[LABELS, VOCABULARY],
	[COMMENT, POSTED],
	[PATCH, okOut("{}")],
	[REMOVE, okOut("[]")],
	[ADD, okOut("[]")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runPark({...options, ...overrides}), fakeShell(script).layer));

describe("runPark", () => {
	it("parks the issue and prints the tab-separated parked line", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			"parked\t4290\thttps://example.test/issues/4290#issuecomment-5170421888\n",
		);
	});

	it("emits the record on STDOUT with --json", async () => {
		const out = await run(happy(), {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "parked",
			number: 4290,
			commentUrl: "https://example.test/issues/4290#issuecomment-5170421888",
			removed: ["type:bug", "p1", "status:triaged", "ready-for:agent"],
		});
	});

	it("reports what it scanned on stderr", async () => {
		const out = await run(happy());
		expect(out.stderr[0]).toBe("triage park: scanned 5 labels in o/r.");
	});

	it("posts the questions BEFORE it touches a label", async () => {
		const shell = fakeShell(happy());
		await Effect.runPromise(Effect.provide(runPark(options), shell.layer));
		const writes = shell.calls.filter(
			(c) => COMMENT.test(c) || PATCH.test(c) || REMOVE.test(c) || ADD.test(c),
		);
		expect(writes[0]).toContain("/comments");
		expect(writes[0]).toContain(`body=${QUESTIONS}`);
	});

	it("clears every priced facet, milestone included", async () => {
		const shell = fakeShell(happy());
		await Effect.runPromise(Effect.provide(runPark(options), shell.layer));
		expect(shell.calls).toContain("gh api --method PATCH repos/o/r/issues/4290 -F milestone=null");
		expect(shell.calls.filter((c) => REMOVE.test(c))).toEqual([
			"gh api --method DELETE repos/o/r/issues/4290/labels/type%3Abug",
			"gh api --method DELETE repos/o/r/issues/4290/labels/p1",
			"gh api --method DELETE repos/o/r/issues/4290/labels/status%3Atriaged",
			"gh api --method DELETE repos/o/r/issues/4290/labels/ready-for%3Aagent",
		]);
		expect(shell.calls.find((c) => ADD.test(c))).toContain("labels[]=status:needs-info");
	});

	it("leaves a label no facet owns alone across a park", async () => {
		const shell = fakeShell([
			[once(ISSUE), issue(["area:pipeline", "status:needs-triage"], null)],
			[ISSUE, issue(["area:pipeline", "status:needs-info"], null)],
			[LABELS, VOCABULARY],
			[COMMENT, POSTED],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPark(options), shell.layer));
		expect(out.code).toBe(0);
		expect(shell.calls.some((c) => c.includes("area%3Apipeline"))).toBe(false);
	});

	it("refuses a FAILED stdin read on 1, never on the empty code", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed({_tag: "Failed", reason: "EAGAIN"} satisfies StdinRead),
		});
		expect(out.code).toBe(1);
		expect(out.code).not.toBe(EMPTY_STDIN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"triage park: could not read stdin: EAGAIN — the questions text is UNKNOWN, never empty.",
		);
	});

	it("refuses empty-but-READ questions on 3, and says how many bytes it read", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed({_tag: "Text", text: "   \n"} satisfies StdinRead),
		});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stderr.at(-1)).toBe(
			"triage park: no body on stdin — a parked issue must say what would unblock it: pipe the questions in.",
		);
		// The byte count is what tells a read-but-empty pipe (3) from an unread one (1).
		expect(out.stderr[0]).toBe("triage park: stdin was read and held 4 byte(s).");
	});

	it("refuses a bare @ path — the questions never arrived", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed({_tag: "Text", text: "@notes/questions.md"} satisfies StdinRead),
		});
		expect(out.code).toBe(BARE_AT_PATH);
		expect(out.stderr.at(-1)).toBe(
			'triage park: the questions text is a bare "@" path reference — the body never arrived. Send it on stdin.',
		);
	});

	it("seats questions that are BOTH a bare @ and a leak on 6 — the bare @ is tested first", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed({
				_tag: "Text",
				text: "@/Users/someone/scratch/case.md",
			} satisfies StdinRead),
		});
		expect(out.code).toBe(BARE_AT_PATH);
		expect(out.code).not.toBe(LEAKED_PATH);
	});

	it("refuses a machine-local path in the authored questions on 5", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed({
				_tag: "Text",
				text: "which of /Users/someone/scratch/case.md did you mean?",
			} satisfies StdinRead),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr.at(-1)).toBe(
			"triage park: the questions text carries a machine-local path at line 1 (absolute home root) — rewrite it repo-relative.",
		);
	});

	it("lists EVERY leak, not just the one the message names — one refusal, one round", async () => {
		const out = await run(happy(), {
			stdin: Effect.succeed({
				_tag: "Text",
				text: "/Users/someone/a.md\nthen /Users/someone/b.md\nand /Users/someone/c.md",
			} satisfies StdinRead),
		});
		expect(out.code).toBe(LEAKED_PATH);
		expect(out.stderr.slice(0, -1)).toEqual([
			"  line 1, absolute home root",
			"  line 2, absolute home root",
			"  line 3, absolute home root",
		]);
	});

	it("writes nothing at all on any stdin refusal", async () => {
		const shell = fakeShell(happy());
		await Effect.runPromise(
			Effect.provide(
				runPark({
					...options,
					stdin: Effect.succeed({_tag: "Text", text: ""} satisfies StdinRead),
				}),
				shell.layer,
			),
		);
		expect(shell.calls).toEqual([]);
	});

	it("refuses an issue proven absent on 7", async () => {
		const out = await run([[ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("triage park: issue #4290 not found in o/r.");
	});

	it("separates an UNREADABLE issue from an absent one, and posts nothing", async () => {
		const shell = fakeShell([[ISSUE, errOut("gh: Bad gateway (HTTP 502)")]]);
		const out = await Effect.runPromise(Effect.provide(runPark(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(shell.calls.some((c) => COMMENT.test(c))).toBe(false);
	});

	it("refuses to write status:needs-info when the repo does not define it (#4285)", async () => {
		const shell = fakeShell([
			[ISSUE, issue(["status:needs-triage"], null)],
			[LABELS, okOut(["type:bug", "status:needs-triage"].join("\n"))],
			[COMMENT, POSTED],
		]);
		const out = await Effect.runPromise(Effect.provide(runPark(options), shell.layer));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("label status:needs-info does not exist");
		expect(shell.calls.some((c) => COMMENT.test(c))).toBe(false);
	});

	it("refuses an unreadable label set as UNKNOWN, never as an empty vocabulary", async () => {
		const out = await run([
			[ISSUE, issue(["status:needs-triage"], null)],
			[LABELS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read the label set");
	});

	it("reports a failed comment as UNKNOWN, and says nothing was labelled", async () => {
		const shell = fakeShell([
			[ISSUE, issue(["status:needs-triage"], null)],
			[LABELS, VOCABULARY],
			[COMMENT, errOut("gh: timeout")],
		]);
		const out = await Effect.runPromise(Effect.provide(runPark(options), shell.layer));
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("nothing was labelled");
		expect(shell.calls.some((c) => REMOVE.test(c) || ADD.test(c))).toBe(false);
	});

	it("distinguishes a failed label swap — the questions landed, the labels may be partial", async () => {
		const out = await run([
			[once(ISSUE), issue(["type:bug", "status:triaged"], null)],
			[ISSUE, issue([], null)],
			[LABELS, VOCABULARY],
			[COMMENT, POSTED],
			[REMOVE, errOut("gh: timeout")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the questions landed but the label swap failed");
	});

	it("refuses a read-back that still carries a priced facet (#4285's other half)", async () => {
		const out = await run([
			[once(ISSUE), issue(["type:bug", "p1", "status:triaged"], null)],
			[ISSUE, issue(["status:needs-info", "p1"], null)],
			[LABELS, VOCABULARY],
			[COMMENT, POSTED],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("priority=[p1]");
	});

	it("refuses a read-back showing both status labels at once", async () => {
		const out = await run([
			[once(ISSUE), issue(["status:triaged"], null)],
			[ISSUE, issue(["status:needs-info", "status:triaged"], null)],
			[LABELS, VOCABULARY],
			[COMMENT, POSTED],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
	});

	it("refuses a read-back that still shows a milestone", async () => {
		const out = await run([
			[once(ISSUE), issue(["status:triaged"], 47)],
			[ISSUE, issue(["status:needs-info"], 47)],
			[LABELS, VOCABULARY],
			[COMMENT, POSTED],
			[PATCH, okOut("{}")],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("milestone=47");
	});

	it("refuses when the read-back itself fails", async () => {
		const out = await run([
			[once(ISSUE), issue(["status:triaged"], null)],
			[ISSUE, errOut("gh: Bad gateway (HTTP 502)")],
			[LABELS, VOCABULARY],
			[COMMENT, POSTED],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("read-back shows nothing");
	});

	it("refuses a non-issue number", async () => {
		const out = await run(happy(), {issue: -1});
		expect(out.code).toBe(1);
	});

	it("refuses an unresolvable repo rather than guessing one", async () => {
		const out = await Effect.runPromise(
			Effect.provide(runPark({...options, env: {}}), fakeShell([]).layer),
		);
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("cannot resolve a target repo");
	});
});
