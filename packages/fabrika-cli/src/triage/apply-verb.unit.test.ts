import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import {runApply} from "./apply-verb.ts";
import {
	COMMENTS,
	CWD,
	claimPage,
	EXPIRED,
	guardedShell,
	LIVE,
	triageContext,
} from "./claim-fixtures.test-support.ts";
import {
	CLAIMED_ELSEWHERE,
	CONFIG_REFUSED,
	CRITERIA_REQUIRED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;
const LABELS = /GET .*\/repos\/o\/r\/labels\?/;
const MILESTONES = /GET .*\/repos\/o\/r\/milestones\?/;
const PATCH = /PATCH .*\/repos\/o\/r\/issues\/4312$/;
const REMOVE = /DELETE .*\/repos\/o\/r\/issues\/4312\/labels\//;
const ADD = /POST .*\/repos\/o\/r\/issues\/4312\/labels$/;

const ACCEPTED: HttpReply = {status: 200, body: "{}"};
const LABELLED: HttpReply = {status: 200, body: "[]"};
const UNREADABLE: HttpReply = {status: 502, body: "{}"};
const NOT_FOUND: HttpReply = {status: 404, body: '{"message":"Not Found"}'};
const WRITE_FAILED: HttpReply = {status: 500, body: "{}"};

const labelSet = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

/** A body carrying the conforming block — what `--ready-for agent` requires (#6025). */
const CRITERIA_BODY = "## Summary\n\ns\n\n### Acceptance criteria\n\n- [ ] the one criterion\n";
/** A report-shaped body: prose only, no block anywhere. kamp-us/demlik#4's shape. */
const NO_CRITERIA_BODY = "## Summary\n\nsomething is off.\n\n## Pointers\n\n- a file\n";

const issue = (
	labels: ReadonlyArray<string>,
	milestone: number | null,
	body = CRITERIA_BODY,
): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4312,
		title: "t",
		body,
		state: "open",
		labels: labels.map((name) => ({name})),
		html_url: "https://example.test/issues/4312",
		milestone: milestone === null ? null : {number: milestone},
	}),
});

const VOCABULARY = labelSet(
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
);

const OPEN_MILESTONES: HttpReply = {
	status: 200,
	body: JSON.stringify([
		{number: 47, title: "fabrika campaign"},
		{number: 44, title: "wayfinder"},
	]),
};

const options = {
	issue: 4312,
	type: "bug",
	priority: "p2",
	readyFor: "agent",
	home: 47 as number | null,
	lane: null as string | null,
	blockedBy: [] as ReadonlyArray<number>,
	token: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	cwd: CWD,
};

/** Observed: needs-triage on `p1` and unhomed. Read back: the whole triaged shape. */
const happy = (): ReadonlyArray<Scripted> => [
	[once(ISSUE), issue(["status:needs-triage", "p1"], null)],
	[ISSUE, issue(["type:bug", "p2", "status:triaged", "ready-for:agent"], 47)],
	[LABELS, VOCABULARY],
	[MILESTONES, OPEN_MILESTONES],
	[PATCH, ACCEPTED],
	[REMOVE, LABELLED],
	[ADD, LABELLED],
];

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(runApply({...options, ...overrides}), triageContext(guardedShell(script))),
	);

/** A config whose priority facet declares a value `/^p\d+$/` cannot own — #4285's shape, as data. */
const VIOLATING_CONFIG = JSON.stringify({
	triageFacets: [{name: "priority", owns: "^p\\d+$", values: ["p0", "p1", "urgent"]}],
});

describe("runApply under a refused config", () => {
	it("refuses on CONFIG_REFUSED, naming the facet and both sets", async () => {
		const out = await Effect.runPromise(
			Effect.provide(runApply(options), triageContext(guardedShell(happy()), VIOLATING_CONFIG)),
		);
		expect(out.code).toBe(CONFIG_REFUSED);
		expect(out.stderr.join(" ")).toContain("facet `priority`");
		expect(out.stderr.join(" ")).toContain("values=[p0, p1, urgent]");
	});

	it("writes no label, and does not even read the issue", async () => {
		const shell = guardedShell(happy());
		await Effect.runPromise(
			Effect.provide(runApply(options), triageContext(shell, VIOLATING_CONFIG)),
		);
		expect(shell.requests).toEqual([]);
	});

	it("still runs on a config that declares nothing about the facets", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runApply(options),
				triageContext(guardedShell(happy()), '{"docLeakExempt": []}'),
			),
		);
		expect(out.code).toBe(0);
	});

	/**
	 * A config that never decoded is a config with no containment answer, and the first round of
	 * this guard let all three arms through to the write because it keyed on the load's refusal
	 * alone. Each asserts the refusal AND the empty call list, since "nothing was written" is the
	 * claim, not "the exit code was 18".
	 */
	it.each([
		["a file that is there and denied", {unreadable: true} as const, "could not be read"],
		["a document that is not a JSON object", "[1, 2]", "not a JSON object"],
		["a key no decoder accepted", '{"triageFacets": "garbage"}', "`triageFacets` is not an array"],
	])("refuses %s, and reads nothing", async (_case, config, expected) => {
		const shell = guardedShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(runApply(options), triageContext(shell, config)),
		);
		expect(out.code).toBe(CONFIG_REFUSED);
		expect(out.stderr.join(" ")).toContain(expected);
		expect(shell.requests).toEqual([]);
	});
});

describe("runApply", () => {
	it("stamps the whole transition and prints the tab-separated triaged line", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("triaged\t4312\tbug\tp2\tagent\t47\t\n");
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
		const shell = guardedShell(happy());
		await Effect.runPromise(Effect.provide(runApply(options), triageContext(shell)));
		const writes = shell.requests
			.map((line, at) => ({line, body: shell.bodies[at] ?? ""}))
			.filter(({line}) => PATCH.test(line) || REMOVE.test(line) || ADD.test(line));
		expect(writes[0]?.line).toBe("PATCH https://api.github.com/repos/o/r/issues/4312");
		expect(writes[0]?.body).toBe('{"milestone":47}');
		expect(writes.at(-1)?.line).toContain("POST");
	});

	it("removes the superseded priority and never the applied one (#4285)", async () => {
		const shell = guardedShell(happy());
		await Effect.runPromise(Effect.provide(runApply(options), triageContext(shell)));
		const removes = shell.requests.filter((c) => REMOVE.test(c));
		expect(removes).toEqual([
			"DELETE https://api.github.com/repos/o/r/issues/4312/labels/status%3Aneeds-triage",
			"DELETE https://api.github.com/repos/o/r/issues/4312/labels/p1",
		]);
		const added: unknown = JSON.parse(
			shell.bodies[shell.requests.findIndex((c) => ADD.test(c))] ?? "{}",
		);
		expect((added as {readonly labels: ReadonlyArray<string>}).labels).toContain("p2");
	});

	it("leaves a label no facet owns entirely alone", async () => {
		const shell = guardedShell([
			[once(ISSUE), issue(["area:pipeline", "p1"], 47)],
			[ISSUE, issue(["area:pipeline", "type:bug", "p2", "status:triaged", "ready-for:agent"], 47)],
			[LABELS, VOCABULARY],
			[MILESTONES, OPEN_MILESTONES],
			[REMOVE, LABELLED],
			[ADD, LABELLED],
		]);
		const out = await Effect.runPromise(Effect.provide(runApply(options), triageContext(shell)));
		expect(out.code).toBe(0);
		expect(shell.requests.some((c) => c.includes("area%3Apipeline"))).toBe(false);
	});

	it("clears the milestone under --lane, because a lane-exempt issue is not homed (ADR 0208)", async () => {
		const shell = guardedShell([
			[once(ISSUE), issue(["status:needs-triage"], 47)],
			[
				ISSUE,
				issue(["type:bug", "p2", "status:triaged", "ready-for:agent", "wayfinder:backlog"], null),
			],
			[LABELS, VOCABULARY],
			[PATCH, ACCEPTED],
			[REMOVE, LABELLED],
			[ADD, LABELLED],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runApply({...options, home: null, lane: "wayfinder:backlog"}),
				triageContext(shell),
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("triaged\t4312\tbug\tp2\tagent\twayfinder:backlog\t\n");
		expect(shell.bodies[shell.requests.findIndex((c) => PATCH.test(c))]).toBe('{"milestone":null}');
		expect(shell.requests.some((c) => MILESTONES.test(c))).toBe(false);
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
		const shell = guardedShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(runApply({...options, ...override}), triageContext(shell)),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(shell.requests).toEqual([]);
	});

	/**
	 * A repo declaring `standingLanes: []` runs none, so the enumerating message would render
	 * `--lane must be  — got "x"` and send the caller hunting for a value that does not exist
	 * (#6440).
	 */
	it("refuses --lane over a repo that declares no lane, naming the empty key", async () => {
		const shell = guardedShell(happy());
		const out = await Effect.runPromise(
			Effect.provide(
				runApply({...options, home: null, lane: "wayfinder:backlog"}),
				triageContext(shell, JSON.stringify({boardVocabulary: {standingLanes: []}})),
			),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("this repo declares no standing lane");
		expect(shell.requests).toEqual([]);
	});

	it("refuses a milestone that is not open, on the same code", async () => {
		const out = await run(happy(), {home: 99});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("not an open milestone");
	});

	it("refuses to write a label the repo does not define — the API would mint it (#4285)", async () => {
		const shell = guardedShell([
			[once(ISSUE), issue(["status:needs-triage"], null)],
			[ISSUE, issue([], null)],
			[LABELS, labelSet("type:bug", "p2", "status:triaged")],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, ACCEPTED],
			[REMOVE, LABELLED],
			[ADD, LABELLED],
		]);
		const out = await Effect.runPromise(Effect.provide(runApply(options), triageContext(shell)));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("label ready-for:agent does not exist");
		expect(shell.requests.some((c) => ADD.test(c) || PATCH.test(c))).toBe(false);
	});

	it("checks only the labels THIS run writes, not the whole vocabulary", async () => {
		// A repo missing `type:investigation` must not refuse a good `--type bug`.
		const out = await run([
			[once(ISSUE), issue(["status:needs-triage", "p1"], null)],
			[ISSUE, issue(["type:bug", "p2", "status:triaged", "ready-for:agent"], 47)],
			[LABELS, labelSet("type:bug", "p1", "p2", "status:triaged", "ready-for:agent")],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, ACCEPTED],
			[REMOVE, LABELLED],
			[ADD, LABELLED],
		]);
		expect(out.code).toBe(0);
	});

	it("refuses an issue proven absent on 7", async () => {
		const out = await run([[ISSUE, NOT_FOUND]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("triage apply: issue #4312 not found in o/r.");
	});

	it("separates an UNREADABLE issue from an absent one, and writes nothing", async () => {
		const shell = guardedShell([[ISSUE, UNREADABLE]]);
		const out = await Effect.runPromise(Effect.provide(runApply(options), triageContext(shell)));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("nothing was written");
		expect(shell.requests.some((c) => PATCH.test(c) || ADD.test(c))).toBe(false);
	});

	it("refuses an unreadable label set as UNKNOWN, never as an empty vocabulary", async () => {
		const out = await run([
			[ISSUE, issue(["status:needs-triage"], null)],
			[LABELS, UNREADABLE],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read the label set");
	});

	it("refuses an unreadable milestone set as UNKNOWN, never as a closed home", async () => {
		const out = await run([
			[ISSUE, issue(["status:needs-triage"], null)],
			[LABELS, VOCABULARY],
			[MILESTONES, UNREADABLE],
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
			[PATCH, ACCEPTED],
			[REMOVE, LABELLED],
			[ADD, WRITE_FAILED],
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
			[PATCH, ACCEPTED],
			[REMOVE, LABELLED],
			[ADD, LABELLED],
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
			[PATCH, ACCEPTED],
			[REMOVE, LABELLED],
			[ADD, LABELLED],
		]);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("milestone=none");
	});

	it("refuses when the read-back itself fails — a write that is not verified is not finished", async () => {
		const out = await run([
			[once(ISSUE), issue(["status:needs-triage"], null)],
			[ISSUE, UNREADABLE],
			[LABELS, VOCABULARY],
			[MILESTONES, OPEN_MILESTONES],
			[PATCH, ACCEPTED],
			[REMOVE, LABELLED],
			[ADD, LABELLED],
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
			guardedShell([
				[ISSUE, issue(["status:needs-triage"], null, body)],
				[LABELS, VOCABULARY],
				[MILESTONES, OPEN_MILESTONES],
				[PATCH, ACCEPTED],
				[REMOVE, LABELLED],
				[ADD, LABELLED],
			]);

		it("refuses an absent block, points at enrich, and writes NO label", async () => {
			const shell = criteriaShell(NO_CRITERIA_BODY);
			const out = await Effect.runPromise(Effect.provide(runApply(options), triageContext(shell)));
			expect(out.code).toBe(CRITERIA_REQUIRED);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toContain("carries no acceptance-criteria block");
			expect(out.stderr.at(-1)).toContain("triage enrich");
			expect(shell.requests.some((c) => ADD.test(c) || REMOVE.test(c) || PATCH.test(c))).toBe(
				false,
			);
		});

		it("refuses a malformed block on the same code, naming the drift and repair-criteria", async () => {
			const shell = criteriaShell(CRITERIA_BODY.replace("### Acceptance", "## Acceptance"));
			const out = await Effect.runPromise(Effect.provide(runApply(options), triageContext(shell)));
			expect(out.code).toBe(CRITERIA_REQUIRED);
			expect(out.stderr.at(-1)).toContain("is malformed");
			expect(out.stderr.at(-1)).toContain("heading level 2, expected 3");
			expect(out.stderr.at(-1)).toContain("triage repair-criteria 4312");
			expect(shell.requests.some((c) => ADD.test(c))).toBe(false);
		});

		/** An epic's criteria arrive per child from the plan ledger, never in its own body. */
		it("stamps --type epic over an absent block — the exemption the carve-out exists for", async () => {
			const out = await run(
				[
					[once(ISSUE), issue(["status:needs-triage"], null, NO_CRITERIA_BODY)],
					[ISSUE, issue(["type:epic", "p2", "status:triaged", "ready-for:agent"], 47)],
					[LABELS, labelSet("type:epic", "p2", "status:triaged", "ready-for:agent")],
					[MILESTONES, OPEN_MILESTONES],
					[PATCH, ACCEPTED],
					[REMOVE, LABELLED],
					[ADD, LABELLED],
				],
				{type: "epic"},
			);
			expect(out.code).toBe(0);
			expect(out.stdout).toBe("triaged\t4312\tepic\tp2\tagent\t47\t\n");
		});

		it("stamps --ready-for human over an absent block — the promise is made to an agent", async () => {
			const out = await run(
				[
					[once(ISSUE), issue(["status:needs-triage"], null, NO_CRITERIA_BODY)],
					[ISSUE, issue(["type:bug", "p2", "status:triaged", "ready-for:human"], 47)],
					[LABELS, VOCABULARY],
					[MILESTONES, OPEN_MILESTONES],
					[PATCH, ACCEPTED],
					[REMOVE, LABELLED],
					[ADD, LABELLED],
				],
				{readyFor: "human"},
			);
			expect(out.code).toBe(0);
			expect(out.stdout).toBe("triaged\t4312\tbug\tp2\thuman\t47\t\n");
		});
	});

	/**
	 * ADR 0301 makes the graph the one carrier of "do not start this yet", and this flag is the only
	 * triage route to it — #6663's ordering shipped as prose because there was none (#6728).
	 */
	describe("--blocked-by", () => {
		const EDGES = /GET .*\/repos\/o\/r\/issues\/4312\/dependencies\/blocked_by/;
		const EDGE_WRITE = /POST .*\/repos\/o\/r\/issues\/4312\/dependencies\/blocked_by$/;
		const TARGET = /GET .*\/repos\/o\/r\/issues\/4311$/;

		const edgeList = (...numbers: ReadonlyArray<number>): HttpReply => ({
			status: 200,
			body: JSON.stringify(numbers.map((number) => ({number}))),
		});
		const target = (id: number): HttpReply => ({status: 200, body: JSON.stringify({id})});

		const withEdges = (...rows: ReadonlyArray<Scripted>): ReadonlyArray<Scripted> => [
			...rows,
			...happy(),
		];

		it("resolves the internal id and POSTs it — never the issue number", async () => {
			const shell = guardedShell(
				withEdges(
					[once(EDGES), edgeList()],
					[EDGES, edgeList(4311)],
					[TARGET, target(9911)],
					[EDGE_WRITE, ACCEPTED],
				),
			);
			const out = await Effect.runPromise(
				Effect.provide(runApply({...options, blockedBy: [4311]}), triageContext(shell)),
			);
			expect(out.code).toBe(0);
			const at = shell.requests.findIndex((line) => EDGE_WRITE.test(line));
			expect(at).toBeGreaterThanOrEqual(0);
			expect(shell.bodies[at]).toBe('{"issue_id":9911}');
		});

		it("reports the read-back edge set as the machine line's last column", async () => {
			const out = await run(
				withEdges(
					[once(EDGES), edgeList()],
					[EDGES, edgeList(4311)],
					[TARGET, target(9911)],
					[EDGE_WRITE, ACCEPTED],
				),
				{blockedBy: [4311]},
			);
			expect(out.stdout).toBe("triaged\t4312\tbug\tp2\tagent\t47\t#4311\n");
			expect(out.stderr.at(-1)).toBe("triage apply: read back #4312 blocked_by #4311.");
		});

		it("leaves one edge and exits 0 when the edge is already live — the flag is idempotent", async () => {
			const shell = guardedShell(withEdges([EDGES, edgeList(4311)], [EDGE_WRITE, ACCEPTED]));
			const out = await Effect.runPromise(
				Effect.provide(runApply({...options, blockedBy: [4311, 4311]}), triageContext(shell)),
			);
			expect(out.code).toBe(0);
			expect(shell.requests.filter((line) => EDGE_WRITE.test(line))).toEqual([]);
			expect(out.stdout).toBe("triaged\t4312\tbug\tp2\tagent\t47\t#4311\n");
		});

		it("refuses a target proven absent on ZERO_SCOPE, before any write of any kind", async () => {
			const shell = guardedShell(
				withEdges([EDGES, edgeList()], [TARGET, NOT_FOUND], [EDGE_WRITE, ACCEPTED]),
			);
			const out = await Effect.runPromise(
				Effect.provide(runApply({...options, blockedBy: [4311]}), triageContext(shell)),
			);
			expect(out.code).toBe(ZERO_SCOPE);
			expect(out.stderr.at(-1)).toContain("--blocked-by 4311 names no issue");
			expect(
				shell.requests.some(
					(c) => EDGE_WRITE.test(c) || ADD.test(c) || REMOVE.test(c) || PATCH.test(c),
				),
			).toBe(false);
		});

		it("is PRECONDITION_UNKNOWN when the live edge set could not be read", async () => {
			const out = await run(withEdges([EDGES, UNREADABLE]), {blockedBy: [4311]});
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stderr.at(-1)).toContain("no edge was written");
		});

		it("is WRITE_UNKNOWN when the edge POST fails", async () => {
			const out = await run(
				withEdges([EDGES, edgeList()], [TARGET, target(9911)], [EDGE_WRITE, WRITE_FAILED]),
				{blockedBy: [4311]},
			);
			expect(out.code).toBe(WRITE_UNKNOWN);
			expect(out.stderr.at(-1)).toContain("did NOT land");
		});

		/** The POST's own 2xx and a graph that carries the edge are different facts. */
		it("is READBACK_MISMATCH when the written edge is absent from the read-back", async () => {
			const out = await run(
				withEdges([EDGES, edgeList()], [TARGET, target(9911)], [EDGE_WRITE, ACCEPTED]),
				{blockedBy: [4311]},
			);
			expect(out.code).toBe(READBACK_MISMATCH);
			expect(out.stderr.at(-1)).toContain("#4311");
			expect(out.stderr.at(-1)).toContain("are not in it");
		});

		it("refuses a self-edge, which would make the issue permanently unbuildable", async () => {
			const shell = guardedShell(happy());
			const out = await Effect.runPromise(
				Effect.provide(runApply({...options, blockedBy: [4312]}), triageContext(shell)),
			);
			expect(out.code).toBe(ZERO_SCOPE);
			expect(out.stderr.at(-1)).toContain("names the issue itself");
		});

		it("reads no dependency endpoint at all when the flag is absent", async () => {
			const shell = guardedShell(happy());
			await Effect.runPromise(Effect.provide(runApply(options), triageContext(shell)));
			expect(shell.requests.some((line) => /dependencies/.test(line))).toBe(false);
		});
	});

	it("refuses an unresolvable repo rather than guessing one", async () => {
		const out = await Effect.runPromise(
			Effect.provide(runApply({...options, env: {}}), triageContext(guardedShell([]))),
		);
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("cannot resolve a target repo");
	});
});

/** #5644: the claim protocol only holds if the mutating verbs re-read it. */
describe("runApply — the target guard", () => {
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
			body: CRITERIA_BODY,
			state: "closed",
			labels: [],
			html_url: "https://example.test/issues/4312",
			milestone: null,
		}),
	};

	const guard = async (script: ReadonlyArray<Scripted>) => {
		const shell = guardedShell(script);
		const out = await Effect.runPromise(
			Effect.provide(runApply({...options, env: mine}), triageContext(shell)),
		);
		return {out, wrote: shell.requests.some((line) => ADD.test(line) || PATCH.test(line))};
	};

	it("refuses a closed issue on 7 and writes nothing", async () => {
		const {out, wrote} = await guard([[ISSUE, closed]]);
		expect(out.code).toBe(ZERO_SCOPE);
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

	it("applies when the live claim is this session's own", async () => {
		const {out} = await guard([
			...happy(),
			[COMMENTS, claimPage({session: MINE, createdAt: LIVE})],
		]);
		expect(out.code).toBe(0);
	});

	it("applies over an issue nobody has claimed", async () => {
		const {out} = await guard(happy());
		expect(out.code).toBe(0);
	});

	it("applies when the only foreign claim has aged out", async () => {
		const {out} = await guard([
			...happy(),
			[COMMENTS, claimPage({session: THEIRS, createdAt: EXPIRED})],
		]);
		expect(out.code).toBe(0);
	});
});
