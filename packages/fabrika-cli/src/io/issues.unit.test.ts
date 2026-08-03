import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import {
	addLabels,
	clearMilestone,
	closeNotPlanned,
	deleteComment,
	getIssue,
	issueTimeline,
	listComments,
	listOpenMilestones,
	parseTabRows,
	patchIssueBody,
	removeLabel,
	setMilestone,
	splitJsonArrays,
} from "./issues.ts";

const run = <A>(effect: Effect.Effect<A, never, never>) => Effect.runPromise(effect);

describe("parseTabRows — shape before interpretation", () => {
	it("reads rows of exactly the asked-for column count", () => {
		expect(parseTabRows("1\ta\n2\tb\n", 2)).toEqual([
			["1", "a"],
			["2", "b"],
		]);
	});

	it("reads no rows as an empty FACT, not a failure", () => {
		expect(parseTabRows("", 2)).toEqual([]);
	});

	it("returns null when a row has the wrong number of fields — either way", () => {
		expect(parseTabRows("1\ta\tb\n", 2)).toBeNull();
		expect(parseTabRows("1\n", 2)).toBeNull();
	});
});

describe("splitJsonArrays", () => {
	it("splits the concatenated pages `--paginate` emits, which JSON.parse rejects whole", () => {
		expect(() => JSON.parse("[1][2]")).toThrow();
		expect(splitJsonArrays("[1][2]")).toEqual(["[1]", "[2]"]);
	});

	it("does not split on a bracket inside a string — a body may contain one", () => {
		expect(splitJsonArrays('[{"body":"see [1] and ]"}]')).toEqual(['[{"body":"see [1] and ]"}]']);
	});

	it("does not split on an escaped quote inside a string", () => {
		expect(splitJsonArrays('[{"body":"a \\" ] b"}]')).toEqual(['[{"body":"a \\" ] b"}]']);
	});
});

describe("getIssue carries the two facets a read-back cannot prove from labels", () => {
	it("reads the milestone number and the state reason", async () => {
		const body = JSON.stringify({
			number: 7,
			title: "t",
			html_url: "u",
			state: "closed",
			state_reason: "not_planned",
			labels: [],
			milestone: {number: 44, title: "fabrika campaign"},
		});
		const result = await run(
			Effect.provide(getIssue("kamp-us/phoenix", 7), fakeShell([[/gh api/, okOut(body)]]).layer),
		);
		expect(result).toMatchObject({
			_tag: "Present",
			value: {milestone: 44, stateReason: "not_planned"},
		});
	});

	it("reads an unhomed, open issue as null on both — absence, not a guess", async () => {
		const body = JSON.stringify({
			number: 7,
			title: "t",
			html_url: "u",
			state: "open",
			state_reason: null,
			labels: [],
			milestone: null,
		});
		const result = await run(
			Effect.provide(getIssue("kamp-us/phoenix", 7), fakeShell([[/gh api/, okOut(body)]]).layer),
		);
		expect(result).toMatchObject({_tag: "Present", value: {milestone: null, stateReason: null}});
	});
});

describe("listOpenMilestones", () => {
	it("pages, and asks only for open milestones", async () => {
		const shell = fakeShell([[/gh api/, okOut("24\tGeçit\n44\tfabrika campaign\n")]]);
		const result = await run(Effect.provide(listOpenMilestones("kamp-us/phoenix"), shell.layer));
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 24, title: "Geçit"},
				{number: 44, title: "fabrika campaign"},
			],
		});
		expect(shell.calls[0]).toContain("--paginate");
		expect(shell.calls[0]).toContain("per_page=100");
		expect(shell.calls[0]).toContain("state=open");
	});

	it("refuses rather than returning a short list when the read fails", async () => {
		const result = await run(
			Effect.provide(
				listOpenMilestones("kamp-us/phoenix"),
				fakeShell([[/gh api/, errOut("gh: Bad gateway (HTTP 502)")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses on a 0 exit whose bytes are not milestone rows", async () => {
		const result = await run(
			Effect.provide(
				listOpenMilestones("kamp-us/phoenix"),
				fakeShell([[/gh api/, okOut("not-a-number\ttitle\n")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("listComments", () => {
	const comment = (id: number, login: string, body: string) =>
		JSON.stringify({id, user: {login}, created_at: "2026-08-03T09:28:41Z", body});

	it("reads every page, in order", async () => {
		const shell = fakeShell([
			[/gh api/, okOut(`[${comment(1, "usirin", "first")}][${comment(2, "cansirin", "second")}]`)],
		]);
		const result = await run(Effect.provide(listComments("kamp-us/phoenix", 4831), shell.layer));
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{id: 1, author: "usirin", createdAt: "2026-08-03T09:28:41Z", body: "first"},
				{id: 2, author: "cansirin", createdAt: "2026-08-03T09:28:41Z", body: "second"},
			],
		});
		expect(shell.calls[0]).toContain("--paginate");
	});

	it("carries a body holding a control character, which `--jq -r` cannot", async () => {
		const shell = fakeShell([[/gh api/, okOut(`[${comment(1, "usirin", "a\nb")}]`)]]);
		const result = await run(Effect.provide(listComments("kamp-us/phoenix", 1), shell.layer));
		expect(result).toMatchObject({_tag: "Ok", value: [{body: "a\nb"}]});
		expect(shell.calls[0]).not.toContain("--jq");
	});

	it("refuses on an entry that is not a comment", async () => {
		const result = await run(
			Effect.provide(
				listComments("kamp-us/phoenix", 1),
				fakeShell([[/gh api/, okOut('[{"message":"Not Found"}]')]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("removeLabel splits `it is gone` from `I could not remove it`", () => {
	it("reports false — not a failure — when the label was already absent", async () => {
		const result = await run(
			Effect.provide(
				removeLabel("kamp-us/phoenix", 1, "status:needs-triage"),
				fakeShell([[/gh api/, errOut("gh: Label does not exist (HTTP 404)")]]).layer,
			),
		);
		expect(result).toEqual({_tag: "Ok", value: false});
	});

	it("fails on any other error — an unreachable GitHub is not a removal", async () => {
		const result = await run(
			Effect.provide(
				removeLabel("kamp-us/phoenix", 1, "status:needs-triage"),
				fakeShell([[/gh api/, errOut("gh: Bad gateway (HTTP 502)")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});

	it("escapes the label name into the path", async () => {
		const shell = fakeShell([[/gh api/, okOut("")]]);
		await run(Effect.provide(removeLabel("kamp-us/phoenix", 1, "type:bug"), shell.layer));
		expect(shell.calls[0]).toContain("labels/type%3Abug");
	});
});

describe("the writes send the fields the API needs, in the form it accepts", () => {
	it("addLabels adds rather than replaces, and spawns nothing for an empty list", async () => {
		const shell = fakeShell([[/gh api/, okOut("")]]);
		await run(Effect.provide(addLabels("kamp-us/phoenix", 1, ["type:bug", "p1"]), shell.layer));
		expect(shell.calls[0]).toContain("--method POST");
		expect(shell.calls[0]).toContain("labels[]=type:bug");
		expect(shell.calls[0]).toContain("labels[]=p1");

		const empty = fakeShell([[/gh api/, okOut("")]]);
		const result = await run(Effect.provide(addLabels("kamp-us/phoenix", 1, []), empty.layer));
		expect(result._tag).toBe("Ok");
		expect(empty.calls).toEqual([]);
	});

	it("setMilestone sends the number as a typed field", async () => {
		const shell = fakeShell([[/gh api/, okOut("")]]);
		await run(Effect.provide(setMilestone("kamp-us/phoenix", 1, 44), shell.layer));
		expect(shell.calls[0]).toContain("--method PATCH");
		expect(shell.calls[0]).toContain("-F milestone=44");
	});

	it('clearMilestone sends a JSON null, not the string "null"', async () => {
		const shell = fakeShell([[/gh api/, okOut("")]]);
		await run(Effect.provide(clearMilestone("kamp-us/phoenix", 1), shell.layer));
		expect(shell.calls[0]).toContain("-F milestone=null");
		expect(shell.calls[0]).not.toContain("-f milestone=null");
	});

	it("closeNotPlanned states the reason — a bare close reads as completed", async () => {
		const shell = fakeShell([[/gh api/, okOut("")]]);
		await run(Effect.provide(closeNotPlanned("kamp-us/phoenix", 1), shell.layer));
		expect(shell.calls[0]).toContain("state=closed");
		expect(shell.calls[0]).toContain("state_reason=not_planned");
	});

	it("patchIssueBody writes the body field — a `title=` here would overwrite the title", async () => {
		const shell = fakeShell([[/gh api/, okOut("")]]);
		await run(
			Effect.provide(patchIssueBody("kamp-us/phoenix", 7, "enriched-body-text"), shell.layer),
		);
		expect(shell.calls[0]).toContain("--method PATCH");
		expect(shell.calls[0]).toContain("repos/kamp-us/phoenix/issues/7");
		expect(shell.calls[0]).toContain("-f body=enriched-body-text");
		expect(shell.calls[0]).not.toContain("title=");
	});

	it("deleteComment targets the id it was given — an off-by-one deletes someone else's", async () => {
		const shell = fakeShell([[/gh api/, okOut("")]]);
		await run(Effect.provide(deleteComment("kamp-us/phoenix", 5170139674), shell.layer));
		expect(shell.calls[0]).toContain("--method DELETE");
		expect(shell.calls[0]).toContain("repos/kamp-us/phoenix/issues/comments/5170139674");
	});

	it("patchIssueBody and deleteComment surface the failure rather than swallowing it", async () => {
		const failing = fakeShell([[/gh api/, errOut("gh: Bad gateway (HTTP 502)")]]).layer;
		expect((await run(Effect.provide(patchIssueBody("r/r", 1, "b"), failing)))._tag).toBe(
			"Failure",
		);
		expect((await run(Effect.provide(deleteComment("r/r", 9), failing)))._tag).toBe("Failure");
	});
});

describe("issueTimeline", () => {
	it("pages, and tells a referencing PR from a referencing issue", async () => {
		const shell = fakeShell([[/gh api/, okOut("4832\ttrue\n4706\tfalse\n")]]);
		const result = await run(Effect.provide(issueTimeline("kamp-us/phoenix", 4831), shell.layer));
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 4832, isPullRequest: true},
				{number: 4706, isPullRequest: false},
			],
		});
		expect(shell.calls[0]).toContain("--paginate");
		expect(shell.calls[0]).toContain("cross-referenced");
	});

	it("refuses on a read that failed — an empty timeline would read as `no twin exists`", async () => {
		const result = await run(
			Effect.provide(
				issueTimeline("kamp-us/phoenix", 1),
				fakeShell([[/gh api/, errOut("gh: Bad gateway (HTTP 502)")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});
});
