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
	openQueueIssues,
	pagedJson,
	parseIssueDetails,
	parseTabRows,
	patchIssueBody,
	removeLabel,
	scanJsonPages,
	setMilestone,
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

describe("pagedJson", () => {
	it("splits the concatenated pages `--paginate` emits, which JSON.parse rejects whole", () => {
		expect(() => JSON.parse("[1][2]")).toThrow();
		expect(pagedJson("[1][2]")).toEqual({_tag: "Ok", value: ["[1]", "[2]"]});
	});

	it("does not split on a bracket inside a string — a body may contain one", () => {
		expect(pagedJson('[{"body":"see [1] and ]"}]')).toEqual({
			_tag: "Ok",
			value: ['[{"body":"see [1] and ]"}]'],
		});
	});

	it("does not split on an escaped quote inside a string", () => {
		expect(pagedJson('[{"body":"a \\" ] b"}]')).toEqual({
			_tag: "Ok",
			value: ['[{"body":"a \\" ] b"}]'],
		});
	});

	it("fails on a read that stopped mid-page rather than handing back the pages that closed", () => {
		const result = pagedJson('[{"id":1}][{"id');
		expect(result._tag).toBe("Failure");
		expect(result).toMatchObject({reason: expect.stringContaining("page boundary")});
	});
});

describe("scanJsonPages — a read that stopped mid-flight says so", () => {
	it("accounts for every byte of a whole read, whitespace between pages included", () => {
		expect(scanJsonPages("[1]\n[2]\n")).toEqual({pages: ["[1]", "[2]"], truncated: null});
	});

	it("reports an unclosed page — the shape a killed `gh` leaves behind", () => {
		const scanned = scanJsonPages('[{"number":1},{"num');
		expect(scanned.pages).toEqual([]);
		expect(scanned.truncated).toContain("does not end on a page boundary");
	});

	it("keeps the complete pages AND reports the cut-short one after them", () => {
		const scanned = scanJsonPages('[{"number":1}][{"num');
		expect(scanned.pages).toEqual(['[{"number":1}]']);
		expect(scanned.truncated).not.toBeNull();
	});

	it("reports a stray closing bracket rather than swallowing it", () => {
		expect(scanJsonPages("[1]]").truncated).not.toBeNull();
	});

	it("reports an unterminated string, where the cut fell inside a body", () => {
		expect(scanJsonPages('[{"body":"half a sen').truncated).not.toBeNull();
	});

	it("reads empty output as zero pages, not as truncation", () => {
		expect(scanJsonPages("")).toEqual({pages: [], truncated: null});
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

	it("reads the filing account's login — the provenance predicate's second signal", async () => {
		const body = JSON.stringify({
			number: 7,
			title: "t",
			html_url: "u",
			state: "open",
			labels: [],
			user: {login: "some-account"},
		});
		const result = await run(
			Effect.provide(getIssue("kamp-us/phoenix", 7), fakeShell([[/gh api/, okOut(body)]]).layer),
		);
		expect(result).toMatchObject({_tag: "Present", value: {author: "some-account"}});
	});

	it("reads a missing author as the empty login, which is never an operator account", async () => {
		const body = JSON.stringify({number: 7, title: "t", html_url: "u", state: "open", labels: []});
		const result = await run(
			Effect.provide(getIssue("kamp-us/phoenix", 7), fakeShell([[/gh api/, okOut(body)]]).layer),
		);
		expect(result).toMatchObject({_tag: "Present", value: {author: ""}});
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
		JSON.stringify({
			id,
			user: {login},
			created_at: "2026-08-03T09:28:41Z",
			updated_at: "2026-08-03T10:00:00Z",
			body,
		});

	it("reads every page, in order", async () => {
		const shell = fakeShell([
			[/gh api/, okOut(`[${comment(1, "usirin", "first")}][${comment(2, "cansirin", "second")}]`)],
		]);
		const result = await run(Effect.provide(listComments("kamp-us/phoenix", 4831), shell.layer));
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{
					id: 1,
					author: "usirin",
					createdAt: "2026-08-03T09:28:41Z",
					updatedAt: "2026-08-03T10:00:00Z",
					body: "first",
				},
				{
					id: 2,
					author: "cansirin",
					createdAt: "2026-08-03T09:28:41Z",
					updatedAt: "2026-08-03T10:00:00Z",
					body: "second",
				},
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

	it("refuses a read that stopped mid-page — never the comments that arrived before the cut", async () => {
		const whole = `[${comment(1, "usirin", "first")}][${comment(2, "cansirin", "second")}]`;
		const cut = whole.slice(0, whole.lastIndexOf("second") + 3);
		const result = await run(
			Effect.provide(listComments("kamp-us/phoenix", 1), fakeShell([[/gh api/, okOut(cut)]]).layer),
		);
		expect(result._tag).toBe("Failure");
		expect(result).toMatchObject({reason: expect.stringContaining("page boundary")});
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

describe("openQueueIssues", () => {
	it("pages, filters pull requests out, and carries the filing time the age is computed from", async () => {
		const shell = fakeShell([
			[
				/gh api/,
				okOut(
					"4312\t2026-08-01T00:00:00Z\tAbort reason lost\n4088\t2026-07-01T00:00:00Z\tCancellation\n",
				),
			],
		]);
		const result = await run(
			Effect.provide(openQueueIssues("kamp-us/phoenix", "status:needs-triage"), shell.layer),
		);
		expect(result).toEqual({
			_tag: "Ok",
			value: [
				{number: 4312, createdAt: "2026-08-01T00:00:00Z", title: "Abort reason lost"},
				{number: 4088, createdAt: "2026-07-01T00:00:00Z", title: "Cancellation"},
			],
		});
		expect(shell.calls[0]).toContain("--paginate");
		expect(shell.calls[0]).toContain("per_page=100");
		expect(shell.calls[0]).toContain("pull_request | not");
	});

	it("cuts at the FIRST TWO tabs, so a title containing a tab does not fail the whole queue", async () => {
		const result = await run(
			Effect.provide(
				openQueueIssues("o/r", "l"),
				fakeShell([[/gh api/, okOut("7\t2026-08-01T00:00:00Z\ta\tb\tc\n")]]).layer,
			),
		);
		expect(result).toEqual({
			_tag: "Ok",
			value: [{number: 7, createdAt: "2026-08-01T00:00:00Z", title: "a\tb\tc"}],
		});
	});

	it("escapes the label into the query string", async () => {
		const shell = fakeShell([[/gh api/, okOut("")]]);
		await run(Effect.provide(openQueueIssues("o/r", "status:needs-triage"), shell.layer));
		expect(shell.calls[0]).toContain("labels=status%3Aneeds-triage");
	});

	it("reads no rows as an empty FACT — the caller turns that into the `empty` state word", async () => {
		const result = await run(
			Effect.provide(openQueueIssues("o/r", "l"), fakeShell([[/gh api/, okOut("")]]).layer),
		);
		expect(result).toEqual({_tag: "Ok", value: []});
	});

	it("refuses a 0 exit whose bytes are not queue rows, rather than reading them positionally", async () => {
		const tooFewFields = await run(
			Effect.provide(
				openQueueIssues("o/r", "l"),
				fakeShell([[/gh api/, okOut("7\ttitle\n")]]).layer,
			),
		);
		expect(tooFewFields._tag).toBe("Failure");

		const notANumber = await run(
			Effect.provide(
				openQueueIssues("o/r", "l"),
				fakeShell([[/gh api/, okOut("jq: error\t2026-08-01T00:00:00Z\tt\n")]]).layer,
			),
		);
		expect(notANumber._tag).toBe("Failure");
	});

	it("refuses a row whose second field is not a filing time — an unparseable age is not 0", async () => {
		const result = await run(
			Effect.provide(
				openQueueIssues("o/r", "l"),
				fakeShell([[/gh api/, okOut("7\tnot-a-date\tt\n")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses rather than returning a short list when the read fails", async () => {
		const result = await run(
			Effect.provide(
				openQueueIssues("o/r", "l"),
				fakeShell([[/gh api/, errOut("gh: Bad gateway (HTTP 502)")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
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

describe("parseIssueDetails refuses a line it cannot read rather than dropping it", () => {
	const line = (row: unknown): string => JSON.stringify(row);

	it("reads one compact-JSON object per line, blank lines skipped", () => {
		const stdout = `${line({number: 9412, title: "a topic", body: "## Came from\n\n#5652\n"})}\n\n${line({number: 9431, title: "another", body: ""})}\n`;
		expect(parseIssueDetails(stdout)).toEqual([
			{number: 9412, title: "a topic", body: "## Came from\n\n#5652\n"},
			{number: 9431, title: "another", body: ""},
		]);
	});

	it("reads a missing or non-string body as empty, which is what the API sends for one", () => {
		expect(parseIssueDetails(line({number: 9412, title: "a topic"}))).toEqual([
			{number: 9412, title: "a topic", body: ""},
		]);
		expect(parseIssueDetails(line({number: 9412, title: "a topic", body: null}))).toEqual([
			{number: 9412, title: "a topic", body: ""},
		]);
	});

	it("answers null on a line that is not an issue object, never a shorter list", () => {
		expect(parseIssueDetails("not json at all")).toBeNull();
		expect(parseIssueDetails(line([9412, "a topic"]))).toBeNull();
		expect(parseIssueDetails(line({number: "9412", title: "a topic"}))).toBeNull();
		expect(parseIssueDetails(line({number: 94.5, title: "a topic"}))).toBeNull();
		expect(parseIssueDetails(line({number: 9412, title: 5652}))).toBeNull();
	});

	it("reads no output as no issues — the ordinary empty search", () => {
		expect(parseIssueDetails("")).toEqual([]);
	});
});
