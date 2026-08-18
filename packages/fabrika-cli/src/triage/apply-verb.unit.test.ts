import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runApply} from "./apply-verb.ts";
import {
	CRITERIA_REQUIRED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;
const MILESTONES = /^gh api --paginate repos\/o\/r\/milestones/;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/4312 -F milestone=/;
const REMOVE = /^gh api --method DELETE repos\/o\/r\/issues\/4312\/labels\//;
const ADD = /^gh api --method POST repos\/o\/r\/issues\/4312\/labels /;

/** A body carrying the conforming block — what `--ready-for agent` requires (#6025). */
const CRITERIA_BODY = "## Summary\n\ns\n\n### Acceptance criteria\n\n- [ ] the one criterion\n";
/** A report-shaped body: prose only, no block anywhere. kamp-us/demlik#4's shape. */
const NO_CRITERIA_BODY = "## Summary\n\nsomething is off.\n\n## Pointers\n\n- a file\n";

const issue = (
	labels: ReadonlyArray<string>,
	milestone: number | null,
	body = CRITERIA_BODY,
): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4312,
			title: "t",
			body,
			state: "open",
			labels: labels.map((name) => ({name})),
			html_url: "https://example.test/issues/4312",
			milestone: milestone === null ? null : {number: milestone},
		}),
	);

const VOCABULARY = okOut(
	[
		"type:bug",
		"type:chore",
		"p1",
		"p2",
		"status:needs-triage",
		"status:triaged",
		"ready-for:agent",
		"ready-for:human",
		"wayfinder:backlog",
		"axis:pipeline-hardening",
	].join("\n"),
);

const OPEN_MILESTONES = okOut("47\tfabrika campaign\n44\twayfinder");

const options = {
	issue: 4312,
	type: "bug",
	priority: "p2",
	readyFor: "agent",
	home: 47 as number | null,
	lane: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

/** Observed: needs-triage on `p1` and unhomed. Read back: the whole triaged shape. */
const happy = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[once(ISSUE), issue(["status:needs-triage", "p1"], null)],
	[ISSUE, issue(["type:bug", "p2", "status:triaged", "ready-for:agent"], 47)],
	[LABELS, VOCABULARY],
	[MILESTONES, OPEN_MILESTONES],
	[PATCH, okOut("{}")],
	[REMOVE, okOut("[]")],
	[ADD, okOut("[]")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runApply({...options, ...overrides}), fakeShell(script).layer));

describe("runApply", () => {
	it("stamps the whole transition and prints the tab-separated triaged line", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("triaged\t4312\tbug\tp2\tagent\t47\n");
	});

	it("emits the record on STDOUT with --json, carrying what it read BACK", async () => {
		const out = await run(happy(), {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "triaged",
			number: 4312,
			type: "bug",
			priority: "p2",
			readyFor: "agent",
			home: 47,
			removed: ["status:needs-triage", "p1"],
			readBack: {labels: ["type:bug", "p2", "status:triaged", "ready-for:agent"], milestone: 47},
		});
	});

	it("reports what it scanned on stderr", async () => {
		const out = await run(happy());
		expect(out.stderr[0]).toBe("triage apply: scanned 10 labels in o/r.");
		expect(out.stderr[1]).toBe("triage apply: scanned 2 open milestones in o/r.");
	});

	it("homes BEFORE it labels, so the homing guard never sees a triaged un-homed issue", async () => {
		const shell = fakeShell(happy());
		await Effect.runPromise(Effect.provide(runApply(options), shell.layer));
		const writes = shell.calls.filter((c) => PATCH.test(c) || REMOVE.test(c) || ADD.test(c));
		expect(writes[0]).toBe("gh api --method PATCH repos/o/r/issues/4312 -F milestone=47");
		expect(writes.at(-1)).toContain("--method POST");
	});

	it("removes the superseded priority and never the applied one (#4285)", async () => {
		const shell = fakeShell(happy());
		await Effect.runPromise(Effect.provide(runApply(options), shell.layer));
		const removes = shell.calls.filter((c) => REMOVE.test(c));
		expect(removes).toEqual([
			"gh api --method DELETE repos/o/r/issues/4312/labels/status%3Aneeds-triage",
			"gh api --method DELETE repos/o/r/issues/4312/labels/p1",
		]);
		expect(shell.calls.find((c) => ADD.test(c))).toContain("labels[]=p2");
	});

	it("leaves a label no facet owns entirely alone", async () => {
		const shell = fakeShell([
			[once(ISSUE), issue(["area:pipeline", "p1"], 47)],
			[ISSUE, issue(["area:pipeline", "type:bug", "p2", "status:triaged", "ready-for:agent"], 47)],
			[LABELS, VOCABULARY],
			[MILESTONES, OPEN_MILESTONES],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		const out = await Effect.runPromise(Effect.provide(runApply(options), shell.layer));
		expect(out.code).toBe(0);
		expect(shell.calls.some((c) => c.includes("area%3Apipeline"))).toBe(false);
	});

	it("clears the milestone under --lane, because a lane-exempt issue is not homed (ADR 0208)", async () => {
		const shell = fakeShell([
			[once(ISSUE), issue(["status:needs-triage"], 47)],
			[
				ISSUE,
				issue(["type:bug", "p2", "status:triaged", "ready-for:agent", "wayfinder:backlog"], null),
			],
			[LABELS, VOCABULARY],
			[PATCH, okOut("{}")],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runApply({...options, home: null, lane: "wayfinder:backlog"}), shell.layer),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("triaged\t4312\tbug\tp2\tagent\twayfinder:backlog\n");
		expect(shell.calls).toContain("gh api --method PATCH repos/o/r/issues/4312 -F milestone=null");
		expect(shell.calls.some((c) => MILESTONES.test(c))).toBe(false);
	});

	it("refuses both --home and --lane", async () => {
		const out = await run(happy(), {lane: "wayfinder:backlog"});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("exactly one of --home or --lane");
	});

	it("refuses neither --home nor --lane", async () => {
		const out = await run(happy(), {home: null});
		expect(out.code).toBe(1);
	});

	it("refuses a non-issue number", async () => {
		const out = await run(happy(), {issue: 0});
		expect(out.code).toBe(1);
	});

	it.each([
		["type", {type: "task"}],
		["priority", {priority: "1"}],
		["ready-for", {readyFor: "robot"}],
		["lane", {home: null, lane: "axis:whatever"}],
	])("refuses an off-vocabulary --%s on 10, before any read", async (_flag, override) => {
		const shell = fakeShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(runApply({...options, ...override}), shell.layer),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(shell.calls).toEqual([]);
	});

	it("refuses a milestone that is not open, on the same code", async () => {
		const out = await run(happy(), {home: 99});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("not an open milestone");
	});

	it("refuses to write a label the repo does not define — the API would mint it (#4285)", async () => {
		const shell = fakeShell([
			[once(ISSUE), issue(["status:needs-triage"], null)],
			[ISSUE, issue([], null)],
			[LABELS, okOut(["type:bug", "p2", "status:triaged"].join("\n"))],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, okOut("{}")],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		const out = await Effect.runPromise(Effect.provide(runApply(options), shell.layer));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("label ready-for:agent does not exist");
		expect(shell.calls.some((c) => ADD.test(c) || PATCH.test(c))).toBe(false);
	});

	it("checks only the labels THIS run writes, not the whole vocabulary", async () => {
		// A repo missing `type:investigation` must not refuse a good `--type bug`.
		const out = await run([
			[once(ISSUE), issue(["status:needs-triage", "p1"], null)],
			[ISSUE, issue(["type:bug", "p2", "status:triaged", "ready-for:agent"], 47)],
			[LABELS, okOut(["type:bug", "p1", "p2", "status:triaged", "ready-for:agent"].join("\n"))],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, okOut("{}")],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses an issue proven absent on 7", async () => {
		const out = await run([[ISSUE, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("triage apply: issue #4312 not found in o/r.");
	});

	it("separates an UNREADABLE issue from an absent one, and writes nothing", async () => {
		const shell = fakeShell([[ISSUE, errOut("gh: Bad gateway (HTTP 502)")]]);
		const out = await Effect.runPromise(Effect.provide(runApply(options), shell.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("nothing was written");
		expect(shell.calls.some((c) => PATCH.test(c) || ADD.test(c))).toBe(false);
	});

	it("refuses an unreadable label set as UNKNOWN, never as an empty vocabulary", async () => {
		const out = await run([
			[ISSUE, issue(["status:needs-triage"], null)],
			[LABELS, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read the label set");
	});

	it("refuses an unreadable milestone set as UNKNOWN, never as a closed home", async () => {
		const out = await run([
			[ISSUE, issue(["status:needs-triage"], null)],
			[LABELS, VOCABULARY],
			[MILESTONES, errOut("gh: Bad gateway (HTTP 502)")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read the milestone set");
	});

	it("reports a failed write as UNKNOWN, counting how many changes had landed", async () => {
		const out = await run([
			[once(ISSUE), issue(["status:needs-triage", "p1"], null)],
			[ISSUE, issue([], null)],
			[LABELS, VOCABULARY],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, okOut("{}")],
			[REMOVE, okOut("[]")],
			[ADD, errOut("gh: timeout")],
		]);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("write failed after 3 of 4 changes");
		expect(out.stderr.at(-1)).toContain("which is idempotent");
	});

	it("refuses when the read-back does not show the shape, reporting what it SAW", async () => {
		const out = await run([
			[once(ISSUE), issue(["status:needs-triage", "p1"], null)],
			[ISSUE, issue(["type:bug", "p2", "ready-for:agent"], 47)],
			[LABELS, VOCABULARY],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, okOut("{}")],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("status=[]");
		expect(out.stderr.at(-1)).toContain("expected exactly one type");
	});

	it("refuses a read-back that lost the home, even with every label right", async () => {
		const out = await run([
			[once(ISSUE), issue(["status:needs-triage"], null)],
			[ISSUE, issue(["type:bug", "p2", "status:triaged", "ready-for:agent"], null)],
			[LABELS, VOCABULARY],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, okOut("{}")],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("milestone=none");
	});

	it("refuses when the read-back itself fails — a write that is not verified is not finished", async () => {
		const out = await run([
			[once(ISSUE), issue(["status:needs-triage"], null)],
			[ISSUE, errOut("gh: Bad gateway (HTTP 502)")],
			[LABELS, VOCABULARY],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, okOut("{}")],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("read-back shows nothing");
	});

	/**
	 * The stamp is the cheap door: one read, zero shells. Without it the first read of the contract
	 * is `review criteria`, after a whole build has been spent on an issue that never had one (#6025).
	 */
	describe("the acceptance-criteria precondition on --ready-for agent", () => {
		const criteriaShell = (body: string) =>
			fakeShell([
				[ISSUE, issue(["status:needs-triage"], null, body)],
				[LABELS, VOCABULARY],
				[MILESTONES, OPEN_MILESTONES],
				[PATCH, okOut("{}")],
				[REMOVE, okOut("[]")],
				[ADD, okOut("[]")],
			]);

		it("refuses an absent block, points at enrich, and writes NO label", async () => {
			const shell = criteriaShell(NO_CRITERIA_BODY);
			const out = await Effect.runPromise(Effect.provide(runApply(options), shell.layer));
			expect(out.code).toBe(CRITERIA_REQUIRED);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toContain("carries no acceptance-criteria block");
			expect(out.stderr.at(-1)).toContain("triage enrich");
			expect(shell.calls.some((c) => ADD.test(c) || REMOVE.test(c) || PATCH.test(c))).toBe(false);
		});

		it("refuses a malformed block on the same code, naming the drift and repair-criteria", async () => {
			const shell = criteriaShell(CRITERIA_BODY.replace("### Acceptance", "## Acceptance"));
			const out = await Effect.runPromise(Effect.provide(runApply(options), shell.layer));
			expect(out.code).toBe(CRITERIA_REQUIRED);
			expect(out.stderr.at(-1)).toContain("is malformed");
			expect(out.stderr.at(-1)).toContain("heading level 2, expected 3");
			expect(out.stderr.at(-1)).toContain("triage repair-criteria 4312");
			expect(shell.calls.some((c) => ADD.test(c))).toBe(false);
		});

		/** An epic's criteria arrive per child from the plan ledger, never in its own body. */
		it("stamps --type epic over an absent block — the exemption the carve-out exists for", async () => {
			const out = await run(
				[
					[once(ISSUE), issue(["status:needs-triage"], null, NO_CRITERIA_BODY)],
					[ISSUE, issue(["type:epic", "p2", "status:triaged", "ready-for:agent"], 47)],
					[LABELS, okOut(["type:epic", "p2", "status:triaged", "ready-for:agent"].join("\n"))],
					[MILESTONES, OPEN_MILESTONES],
					[PATCH, okOut("{}")],
					[REMOVE, okOut("[]")],
					[ADD, okOut("[]")],
				],
				{type: "epic"},
			);
			expect(out.code).toBe(0);
			expect(out.stdout).toBe("triaged\t4312\tepic\tp2\tagent\t47\n");
		});

		it("stamps --ready-for human over an absent block — the promise is made to an agent", async () => {
			const out = await run(
				[
					[once(ISSUE), issue(["status:needs-triage"], null, NO_CRITERIA_BODY)],
					[ISSUE, issue(["type:bug", "p2", "status:triaged", "ready-for:human"], 47)],
					[LABELS, VOCABULARY],
					[MILESTONES, OPEN_MILESTONES],
					[PATCH, okOut("{}")],
					[REMOVE, okOut("[]")],
					[ADD, okOut("[]")],
				],
				{readyFor: "human"},
			);
			expect(out.code).toBe(0);
			expect(out.stdout).toBe("triaged\t4312\tbug\tp2\thuman\t47\n");
		});
	});

	it("refuses an unresolvable repo rather than guessing one", async () => {
		const out = await Effect.runPromise(
			Effect.provide(runApply({...options, env: {}}), fakeShell([]).layer),
		);
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("cannot resolve a target repo");
	});
});
