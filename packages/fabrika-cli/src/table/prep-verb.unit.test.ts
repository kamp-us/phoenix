/**
 * `table prep` against an in-memory table, issue board and status-update list, with no
 * `.fabrika.jsonc`: the agenda in section order under the cap, a chain row counted once with its
 * members in the members view, a flagged bet back on the agenda and an unflagged one carried
 * quietly, a closed `proposed` row taken off, untriaged customers held for triage, a ruling row
 * read as a pick, one health update, and a second run that writes nothing.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeShell, unconfigured} from "../fakes.test-support.ts";
import type {ChildOutcome, ChildRequest} from "../io/exec.ts";
import {absent, type ListedIssue, present, type TimelineFacts, unknown} from "../io/issues.ts";
import type {
	FieldValue,
	ItemFieldValue,
	ProjectItem,
	ProjectSnapshot,
	ProjectsAnswer,
	StatusUpdate,
	StatusUpdateInput,
} from "../io/projects.ts";
import {emit, type Instant, type LaneRecord} from "../wire/lane-record.ts";
import {checkMarker} from "./check.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {type PrepBoard, runPrep} from "./prep-verb.ts";
import {ORIGINS, OUTCOMES, STAGES} from "./shape.ts";
import type {SyncNode} from "./sync.ts";

const REPO = "acme/widgets";
const OWNER = "octo-owner";
/** A Sunday; the shipped table day is Monday, so prep readies the Sep 28 table. */
const NOW = new Date("2026-09-27T12:00:00.000Z");

const PREVIOUS = "2026-09-21";
const NEXT = "2026-09-28";

const selectField = (id: string, name: string, names: ReadonlyArray<string>) => ({
	_tag: "SingleSelect" as const,
	id,
	databaseId: 0,
	name,
	options: names.map((n) => ({id: `${id}:${n}`, name: n, color: "GRAY" as const, description: ""})),
});

const PROJECT: ProjectSnapshot = {
	id: "PVT_1",
	number: 3,
	owner: {kind: "Organization", login: "acme"},
	url: "https://github.com/orgs/acme/projects/3",
	title: "widgets table",
	shortDescription: null,
	readme: null,
	fields: [
		selectField(
			"F_stage",
			"Stage",
			STAGES.map((stage) => stage.name),
		),
		selectField("F_section", "Section", ["Tails", "Customers", "New bets", "Outside the bets"]),
		selectField("F_size", "Size", ["S", "M", "L"]),
		{_tag: "Plain", databaseId: 0, id: "F_spent", name: "Spent $", dataType: "NUMBER"},
		{_tag: "Plain", databaseId: 0, id: "F_asks", name: "Asks", dataType: "NUMBER"},
		selectField(
			"F_origin",
			"Origin",
			ORIGINS.map((origin) => origin.name),
		),
		{_tag: "Plain", databaseId: 0, id: "F_rec", name: "Rec", dataType: "TEXT"},
		{_tag: "Plain", databaseId: 0, id: "F_plain", name: "In plain words", dataType: "TEXT"},
		selectField(
			"F_outcome",
			"Outcome",
			OUTCOMES.map((outcome) => outcome.name),
		),
		{_tag: "Plain", databaseId: 0, id: "F_day", name: "Table day", dataType: "DATE"},
	],
	views: [],
};

const ON_CALL: ProjectSnapshot = {
	id: "PVT_2",
	number: 4,
	owner: {kind: "Organization", login: "acme"},
	url: "https://github.com/orgs/acme/projects/4",
	title: "widgets on-call",
	shortDescription: null,
	readme: null,
	fields: [
		selectField("F_target", "Response target", ["same day", "this week"]),
		{_tag: "Plain", databaseId: 0, id: "F_oc_plain", name: "In plain words", dataType: "TEXT"},
	],
	views: [],
};

const fieldById = new Map(
	[...PROJECT.fields, ...ON_CALL.fields].map((field) => [field.id, field] as const),
);

interface IssueSpec {
	readonly open?: boolean;
	readonly title?: string;
	readonly body?: string;
	readonly labels?: ReadonlyArray<string>;
	readonly association?: string;
	readonly author?: string;
	readonly subIssues?: ReadonlyArray<number>;
	readonly blockedBy?: ReadonlyArray<number>;
	readonly records?: ReadonlyArray<LaneRecord>;
	readonly timeline?: TimelineFacts;
}

type Cells = Readonly<Record<string, string | number>>;

const cellValue = (
	fieldName: string,
	raw: string | number,
	project: ProjectSnapshot = PROJECT,
): ItemFieldValue => {
	const field = project.fields.find((one) => one.name === fieldName);
	if (field === undefined) throw new Error(`no field ${fieldName}`);
	const at = {fieldId: field.id, fieldName, creator: OWNER, updatedAt: "2026-09-26T00:00:00.000Z"};
	if (field._tag === "SingleSelect") {
		return {...at, value: {_tag: "Option", optionId: `${field.id}:${raw}`, name: String(raw)}};
	}
	if (field._tag === "Plain" && field.dataType === "DATE") {
		return {...at, value: {_tag: "Date", date: String(raw)}};
	}
	return typeof raw === "number"
		? {...at, value: {_tag: "Number", number: raw}}
		: {...at, value: {_tag: "Text", text: raw}};
};

const PITCH = (appetite: string) =>
	[
		"## Pitch",
		"",
		"**Problem:** exports are slow",
		"**Arc:** speed",
		`**Appetite:** ${appetite}`,
		"**Rabbit-holes:** none",
		"**No-gos:** none",
	].join("\n");

const record = (issue: number, usd: number, outcome: string, asks = 0): LaneRecord => {
	const terminalAt = "2026-09-25T06:00:00.000Z" as Instant;
	return {
		issue,
		outcome,
		startedAt: `2026-09-24T0${issue % 10}:00:00.000Z` as Instant,
		terminalAt,
		builds: 1,
		reviews: 1,
		parks: Array.from({length: asks}, () => ({
			task: "issue",
			leaf: "blocked",
			cause: null,
			route: "founder" as const,
			at: terminalAt,
		})),
		spent: {_tag: "Measured", usd},
		origin: "bet",
		waiting: {_tag: "None"},
		prs: [],
		log: [],
	};
};

const TRIAGED = ["status:triaged", "ready-for:agent"];

/** The board the whole suite reads; each test takes its own copy. */
const ISSUES: Readonly<Record<number, IssueSpec>> = {
	1: {open: false, labels: ["type:epic"], subIssues: [11, 12]},
	11: {
		labels: [...TRIAGED, "p1"],
		title: "Export: persist draft before upload",
		body: "## In plain words\n\nThe export button can lose your work.\nWe would save a draft first.\n\n## Detail\n\nagent text",
	},
	12: {open: false, labels: TRIAGED},
	20: {
		labels: ["type:epic", "status:triaged"],
		title: "Faster exports",
		body: PITCH("M"),
		subIssues: [21, 22],
	},
	21: {labels: TRIAGED},
	22: {labels: TRIAGED},
	30: {
		labels: [...TRIAGED, "p0"],
		title: "Login fails on Safari",
		association: "NONE",
		author: "a-user",
		blockedBy: [31],
	},
	31: {labels: TRIAGED, blockedBy: [32]},
	32: {labels: TRIAGED},
	40: {labels: [], association: "NONE", author: "another-user"},
	41: {labels: ["status:needs-info"], association: "CONTRIBUTOR", author: "third-user"},
	60: {
		labels: ["type:epic", "status:triaged", "ready-for:human"],
		title: "Pick the flag's future",
		body: `${PITCH("S")}\n\n### Options\n\n- **Keep the old flag.** It works today.\n- Drop it`,
	},
	70: {labels: TRIAGED, records: [record(70, 20, "complete")]},
	71: {labels: TRIAGED},
	80: {open: false, labels: TRIAGED},
	90: {labels: TRIAGED, records: [record(90, 12, "tripped", 1)]},
	95: {labels: [], association: "OWNER", author: OWNER},
};

const ROWS: Readonly<Record<number, Cells>> = {
	70: {
		Stage: "bet",
		setAt: "2026-09-24T00:00:00.000Z",
		Section: "New bets",
		Size: "S",
		"Table day": PREVIOUS,
		Rec: "yes.",
	},
	71: {Stage: "bet", Section: "New bets", Size: "M", "Table day": PREVIOUS, Rec: "yes."},
	80: {Stage: "proposed", Section: "Customers", "Table day": PREVIOUS, Rec: "yes."},
	90: {Stage: "in lane", Section: "Outside the bets", Origin: "driver pick", "Spent $": 12},
};

const ran = (stdout: string, exitCode: number | null = 0, stderr = ""): ChildOutcome => ({
	_tag: "Ran",
	exitCode,
	timedOut: exitCode === null,
	stdout: new TextEncoder().encode(stdout),
	stderr: new TextEncoder().encode(stderr),
	truncated: false,
});

const world = (
	issues: Readonly<Record<number, IssueSpec>> = ISSUES,
	rows: Readonly<Record<number, Cells>> = ROWS,
	source: (request: ChildRequest) => ChildOutcome = () => ran(""),
) => {
	const ok = <A>(value: A): ProjectsAnswer<A> => ({_tag: "Ok", value});
	const items = new Map<number, {itemId: string; values: ItemFieldValue[]}>();
	for (const [number, cells] of Object.entries(rows)) {
		items.set(Number(number), {
			itemId: `PVTI_${number}`,
			values: Object.entries(cells)
				.filter(([field]) => field !== "setAt")
				.map(([field, raw]) =>
					field === "Stage" && typeof cells.setAt === "string"
						? {...cellValue(field, raw), updatedAt: cells.setAt}
						: cellValue(field, raw),
				),
		});
	}
	const updates: StatusUpdate[] = [];
	const posts: StatusUpdateInput[] = [];
	const comments = new Map<number, string[]>();
	const spawned: ChildRequest[] = [];
	const onCallItems = new Map<number, {itemId: string; values: ItemFieldValue[]}>();
	const storeOf = (projectId: string) => (projectId === ON_CALL.id ? onCallItems : items);
	const itemByid = (itemId: string) =>
		[...items.values(), ...onCallItems.values()].find((item) => item.itemId === itemId);
	const nodeOf = (number: number): SyncNode | null => {
		const spec = issues[number];
		if (spec === undefined) return null;
		return {
			number,
			open: spec.open ?? true,
			parent: Object.entries(issues).find(([, other]) => other.subIssues?.includes(number))
				? Number(Object.entries(issues).find(([, other]) => other.subIssues?.includes(number))?.[0])
				: null,
			subIssues: spec.subIssues ?? [],
			blockedBy: spec.blockedBy ?? [],
			blocking: Object.entries(issues)
				.filter(([, other]) => other.blockedBy?.includes(number))
				.map(([n]) => Number(n)),
		};
	};
	const listed = (): ReadonlyArray<ListedIssue> =>
		Object.entries(issues)
			.filter(([, spec]) => spec.open ?? true)
			.map(([number, spec]) => ({
				number: Number(number),
				title: spec.title ?? `Issue ${number}`,
				body: spec.body ?? "",
				labels: spec.labels ?? [],
				author: spec.author ?? OWNER,
				association: spec.association ?? "MEMBER",
			}));
	const board: PrepBoard<never> = {
		locate: (_repo, target) =>
			Effect.succeed(
				ok({_tag: "Located", project: target.key.startsWith("boards.") ? ON_CALL : PROJECT}),
			),
		items: (projectId) =>
			Effect.sync(() =>
				projectId === ON_CALL.id
					? ok(
							[...onCallItems].map(
								([number, item]): ProjectItem => ({
									itemId: item.itemId,
									contentNumber: number,
									contentType: "Issue",
									repository: REPO,
									values: item.values,
								}),
							),
						)
					: ok([
							...[...items].map(
								([number, item]): ProjectItem => ({
									itemId: item.itemId,
									contentNumber: number,
									contentType: "Issue",
									repository: REPO,
									values: item.values,
								}),
							),
							{
								itemId: "PVTI_draft",
								contentNumber: null,
								contentType: "DraftIssue",
								repository: null,
								values: [cellValue("Stage", "proposed")],
							},
						]),
			),
		node: (_repo, number) => {
			const found = nodeOf(number);
			return Effect.succeed(found === null ? absent<SyncNode>() : present(found));
		},
		comments: (_repo, number) =>
			Effect.sync(() => ({
				_tag: "Ok" as const,
				value: [...(issues[number]?.records ?? []).map(emit), ...(comments.get(number) ?? [])],
			})),
		comment: (_repo, number, body) =>
			Effect.sync(() => {
				comments.set(number, [...(comments.get(number) ?? []), body]);
				return {_tag: "Ok" as const, value: undefined};
			}),
		issue: (_repo, number) => {
			const spec = issues[number];
			if (spec === undefined) return Effect.succeed(absent());
			return Effect.succeed(
				present({
					number,
					title: spec.title ?? `Issue ${number}`,
					body: spec.body ?? "",
					state: (spec.open ?? true) ? "open" : "closed",
					labels: spec.labels ?? [],
					url: `https://github.com/${REPO}/issues/${number}`,
					author: spec.author ?? OWNER,
					milestone: null,
					stateReason: null,
					comments: 0,
					isPullRequest: false,
					parent: {_tag: "None" as const},
				}),
			);
		},
		timeline: (_repo, number) =>
			Effect.succeed({
				_tag: "Ok" as const,
				value: issues[number]?.timeline ?? {references: [], reopenedAt: []},
			}),
		source: (request) =>
			Effect.sync(() => {
				spawned.push(request);
				return source(request);
			}),
		deciders: () => Effect.succeed({_tag: "Roster" as const, logins: new Set([OWNER])}),
		statusUpdates: () => Effect.sync(() => ok([...updates])),
		openIssues: () => Effect.succeed({_tag: "Ok" as const, value: listed()}),
		followUps: () =>
			Effect.succeed({
				_tag: "Ok" as const,
				value: Object.entries(issues)
					.filter(([, spec]) => spec.open === false && spec.labels?.includes("type:epic"))
					.flatMap(([epic, spec]) =>
						(spec.subIssues ?? []).map((issue) => ({issue, epic: Number(epic)})),
					),
			}),
		add: (projectId, _repo, issue) => {
			const store = storeOf(projectId);
			const itemId = projectId === ON_CALL.id ? `PVTI_oc_${issue}` : `PVTI_${issue}`;
			if (!store.has(issue)) store.set(issue, {itemId, values: []});
			return Effect.succeed(ok(itemId));
		},
		set: (target, value: FieldValue) => {
			const item = itemByid(target.itemId);
			const field = fieldById.get(target.fieldId);
			const project = target.projectId === ON_CALL.id ? ON_CALL : PROJECT;
			if (item === undefined || field === undefined) return Effect.succeed(ok(target.itemId));
			const shown =
				value._tag === "Option"
					? value.optionId.slice(value.optionId.indexOf(":") + 1)
					: value._tag === "Date"
						? value.date
						: value._tag === "Text"
							? value.text
							: value._tag === "Number"
								? value.number
								: value.iterationId;
			item.values = [
				...item.values.filter((one) => one.fieldId !== target.fieldId),
				cellValue(field.name, shown, project),
			];
			return Effect.succeed(ok(target.itemId));
		},
		clear: (target) => {
			const item = itemByid(target.itemId);
			if (item !== undefined) {
				item.values = item.values.filter((one) => one.fieldId !== target.fieldId);
			}
			return Effect.succeed(ok(target.itemId));
		},
		remove: (_projectId, itemId) => {
			for (const [number, item] of items) if (item.itemId === itemId) items.delete(number);
			return Effect.succeed(ok(itemId));
		},
		post: (_projectId, update) => {
			posts.push(update);
			updates.push({
				id: `SU_${updates.length}`,
				body: update.body,
				startDate: update.startDate ?? null,
			});
			return Effect.succeed(ok(`SU_${updates.length}`));
		},
	};
	const cell = (issue: number, field: string): string | number | null => {
		const value = items.get(issue)?.values.find((one) => one.fieldName === field)?.value;
		if (value === undefined) return null;
		switch (value._tag) {
			case "Option":
				return value.name;
			case "Iteration":
				return value.iterationId;
			case "Text":
				return value.text;
			case "Number":
				return value.number;
			case "Date":
				return value.date;
		}
	};
	return {board, items, onCallItems, posts, cell, comments, spawned};
};

const prep = (
	board: PrepBoard<never>,
	config = unconfigured,
	env: Readonly<Record<string, string>> = {},
	now: Date = NOW,
) =>
	Effect.runPromise(
		Effect.provide(
			runPrep({repo: REPO, cwd: "/repo", env, now, board}),
			Layer.mergeAll(config, fakeShell([]).layer),
		),
	);

interface AgendaOut {
	readonly issue: number;
	readonly section: string;
	readonly kind: string | null;
	readonly members: ReadonlyArray<number>;
	readonly size: string;
	readonly rec: string;
	readonly plainWords: string;
}

describe("table prep with no .fabrika.jsonc", () => {
	it("proposes open issues in section order, each row with a Size, a Rec and plain words", async () => {
		const {board, cell} = world();
		const out = await prep(board);

		expect(out.code, out.stderr.join("\n")).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect(answer.answer).toBe("prepped");
		expect(answer.tableDay).toBe(NEXT);
		expect(answer).not.toHaveProperty("iteration");
		const agenda = answer.agenda as ReadonlyArray<AgendaOut>;
		expect(agenda.map((row) => `${row.section} #${row.issue}`)).toEqual([
			"Tails #70",
			"Tails #11",
			"Customers #30",
			"New bets #20",
			"New bets #60",
		]);
		for (const row of agenda) {
			expect(row.size).toMatch(/^[SML]$/);
			expect(row.rec).not.toBe("");
			expect(row.plainWords).not.toBe("");
			expect(cell(row.issue, "Section")).toBe(row.section);
			expect(cell(row.issue, "Table day")).toBe(NEXT);
			expect(cell(row.issue, "Rec")).toBe(row.rec);
			expect(cell(row.issue, "In plain words")).toBe(row.plainWords);
		}
		expect(cell(11, "Stage")).toBe("proposed");
		expect(cell(11, "Size")).toBe("S");
		expect(cell(20, "Size")).toBe("L");
	});

	it("takes the plain words from the issue's summary, and from its title when it has none", async () => {
		const {board} = world();
		const agenda = JSON.parse((await prep(board)).stdout).agenda as ReadonlyArray<AgendaOut>;
		const byIssue = new Map(agenda.map((row) => [row.issue, row]));

		expect(byIssue.get(11)?.plainWords).toBe(
			"The export button can lose your work. We would save a draft first.",
		);
		expect(byIssue.get(20)?.plainWords).toBe("Faster exports");
	});

	it("proposes a row with open blockers as one chain row, its members only in the members view", async () => {
		const {board, cell} = world();
		const agenda = JSON.parse((await prep(board)).stdout).agenda as ReadonlyArray<AgendaOut>;
		const chain = agenda.find((row) => row.issue === 30);

		expect(chain).toMatchObject({kind: "chain", members: [31, 32], size: "L"});
		expect(chain?.plainWords).toBe("Login fails on Safari. It needs #31 and #32 done first.");
		expect(chain?.rec).toContain("bets on #31 and #32 too, about $45 in all");
		for (const member of [31, 32]) {
			expect(cell(member, "Section")).toBeNull();
			expect(agenda.some((row) => row.issue === member)).toBe(false);
		}
		expect(cell(21, "Section")).toBeNull();
		expect(agenda.find((row) => row.issue === 20)).toMatchObject({kind: "epic", members: [21, 22]});
	});

	it("counts a chain once toward the cap and leaves what does not fit for a later table", async () => {
		const {board} = world();
		const capped = fakeFs({
			files: {"/repo/.fabrika.jsonc": JSON.stringify({table: {agendaCap: 3}})},
		}).layer;
		const answer = JSON.parse((await prep(board, capped)).stdout);

		expect((answer.agenda as ReadonlyArray<AgendaOut>).map((row) => row.issue)).toEqual([
			70, 11, 30,
		]);
		expect(answer.overflow).toEqual([20, 60]);
	});

	it("brings a flagged bet back to Tails and carries an unflagged one over with no agenda row", async () => {
		const {board, cell} = world();
		const answer = JSON.parse((await prep(board)).stdout);

		expect(answer.rollover).toEqual({continuing: [71], flagged: [70]});
		expect(cell(70, "Stage")).toBe("bet");
		expect(cell(70, "Size")).toBe("S");
		expect(cell(70, "Section")).toBe("Tails");
		expect(String(cell(70, "Rec"))).toContain("Over its S size ($20 of $15)");
		expect(cell(71, "Stage")).toBe("bet");
		expect(cell(71, "Table day")).toBe(NEXT);
		expect(cell(71, "Rec")).toBeNull();
		expect(cell(71, "Section")).toBe("New bets");
	});

	it("adds only open issues, never a draft, and takes a closed proposed row off the table", async () => {
		const {board, items} = world();
		const answer = JSON.parse((await prep(board)).stdout);

		expect(answer.removed).toEqual([80]);
		expect(items.has(80)).toBe(false);
		expect(items.has(12)).toBe(false);
		const added = (answer.changes as ReadonlyArray<string>)
			.map((change) => /^added #(\d+)/.exec(change)?.[1])
			.filter((n): n is string => n !== undefined)
			.map(Number);
		expect(added.sort((a, b) => a - b)).toEqual([11, 20, 21, 22, 30, 31, 32, 60]);
	});

	it("holds untriaged customer reports for triage and marks the one waiting on its filer", async () => {
		const {board, items} = world();
		const out = await prep(board);
		const answer = JSON.parse(out.stdout);

		expect(answer.triageFirst).toEqual([
			{issue: 40, waitingOnFiler: false},
			{issue: 41, waitingOnFiler: true},
		]);
		expect(items.has(40)).toBe(false);
		expect(items.has(41)).toBe(false);
		expect(out.stderr.join("\n")).toContain(
			"#41 is a Customers report to triage first — waiting on filer",
		);
	});

	it("asks a ruling row as a pick with its options, never a plain yes", async () => {
		const {board} = world();
		const agenda = JSON.parse((await prep(board)).stdout).agenda as ReadonlyArray<AgendaOut>;
		const ruling = agenda.find((row) => row.issue === 60);

		expect(ruling?.rec).toBe("needs your pick: Keep the old flag, or Drop it.");
		expect(ruling?.rec).not.toMatch(/^yes/);
	});

	it("tallies the running un-bet lanes and posts one health update with the Inbox count", async () => {
		const {board, posts} = world();
		const answer = JSON.parse((await prep(board)).stdout);

		expect(answer.outside).toEqual({
			count: 1,
			kinds: {"driver pick": 1},
			spentUsd: 12,
			unmeasured: 0,
		});
		expect(posts).toHaveLength(1);
		const body = posts[0]?.body ?? "";
		expect(body).toContain("**Table notes, week of Sep 28**");
		expect(body).toContain("- Land rate: 50% (1 of 2 lanes landed)");
		expect(body).toContain("- Stale lanes: 0");
		expect(body).toContain("- Spend: $32");
		expect(body).toContain("- Needed a founder: 50% of lanes (1 of 2)");
		expect(body).toContain("- Outside the bets: 1 lane (1 driver pick), $12");
		expect(body).toContain("- Bets continuing: 1 (and 1 flagged onto the agenda)");
		expect(body).toContain("- Inbox: 2 open issues with no labels");
		expect(posts[0]).toMatchObject({
			status: "AT_RISK",
			startDate: "2026-09-28",
			targetDate: "2026-10-05",
		});
		expect(answer.health).toMatchObject({posted: true, alreadyPosted: false, inbox: 2});
	});

	it("finds every row already dated on a second run for the same table, and writes nothing", async () => {
		const {board, posts, items} = world();
		await prep(board);
		const dated = [...items.values()].filter((item) =>
			item.values.some((one) => one.fieldName === "Table day" && one.value._tag === "Date"),
		);
		const again = await prep(board);

		expect(again.code).toBe(0);
		const answer = JSON.parse(again.stdout);
		expect(answer).toMatchObject({answer: "unchanged", changes: [], tableDay: NEXT});
		expect(answer.health).toMatchObject({posted: false, alreadyPosted: true});
		expect(posts).toHaveLength(1);
		expect(dated.length).toBeGreaterThan(0);
		for (const item of dated) {
			expect(item.values.find((one) => one.fieldName === "Table day")?.value).toEqual({
				_tag: "Date",
				date: NEXT,
			});
		}
		expect(again.stderr.join("\n")).toContain("nothing was written");
	});

	it("marks its health update with the table day, and finds it by that date on the next run", async () => {
		const {board, posts} = world();
		await prep(board);

		expect(posts[0]?.body).toContain(`<!-- fabrika:table-health table-day=${NEXT} -->`);
		const again = JSON.parse((await prep(board)).stdout);
		expect(again.health).toMatchObject({alreadyPosted: true});
	});

	it("prepares the Saturday table on a Saturday evening in California, already Sunday in UTC", async () => {
		const {board, posts, cell} = world();
		const saturdays = fakeFs({
			files: {
				"/repo/.fabrika.jsonc": JSON.stringify({
					table: {day: "saturday", timeZone: "America/Los_Angeles"},
				}),
			},
		}).layer;
		const out = await prep(board, saturdays, {}, new Date("2026-10-04T01:30:00Z"));

		expect(out.code, out.stderr.join("\n")).toBe(0);
		expect(JSON.parse(out.stdout).tableDay).toBe("2026-10-03");
		expect(cell(71, "Table day")).toBe("2026-10-03");
		expect(posts[0]?.body).toContain("<!-- fabrika:table-health table-day=2026-10-03 -->");
		expect(posts[0]).toMatchObject({startDate: "2026-10-03", targetDate: "2026-10-10"});
	});

	it("closes the agenda once its update stands, even when a new candidate appears", async () => {
		const {board: first, posts} = world();
		await prep(first);
		const grown = world({
			...ISSUES,
			99: {labels: ["type:epic", "status:triaged"], body: PITCH("S")},
		});
		const {board} = grown;
		const seeded = {...board, statusUpdates: first.statusUpdates, items: first.items};
		const answer = JSON.parse((await prep(seeded)).stdout);

		expect(answer.changes.some((change: string) => change.includes("#99"))).toBe(false);
		expect(answer.agenda.some((row: AgendaOut) => row.issue === 99)).toBe(false);
		expect(posts).toHaveLength(1);
		expect(grown.posts).toHaveLength(0);
	});

	it("needs no week set up ahead: a table months past every earlier date prepares", async () => {
		const {board, cell} = world();
		const out = await prep(board, unconfigured, {}, new Date("2027-03-10T12:00:00Z"));

		expect(out.code, out.stderr.join("\n")).toBe(0);
		expect(JSON.parse(out.stdout).tableDay).toBe("2027-03-15");
		expect(cell(71, "Table day")).toBe("2027-03-15");
	});

	it("names the date field it lacks and writes nothing on a project set up before Table day", async () => {
		const {board, posts} = world();
		const legacy: ProjectSnapshot = {
			...PROJECT,
			fields: [
				...PROJECT.fields.filter((field) => field.name !== "Table day"),
				{_tag: "Iteration", databaseId: 0, id: "F_week", name: "Week", duration: 7, startDay: 1},
			],
		};
		const out = await prep({
			...board,
			locate: () => Effect.succeed({_tag: "Ok", value: {_tag: "Located", project: legacy}}),
		});

		expect(out.code).toBe(23);
		expect(out.stderr.join("\n")).toContain("the date field Table day");
		expect(posts).toHaveLength(0);
	});

	it("refuses and writes nothing when a candidate's group member cannot be read", async () => {
		const {board, posts, items} = world();
		const reads: number[] = [];
		const out = await prep({
			...board,
			node: (repo, number) => {
				reads.push(number);
				return number === 31
					? Effect.succeed(unknown<SyncNode>("gh timed out"))
					: board.node(repo, number);
			},
		});

		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.join("\n")).toContain("cannot read #31: gh timed out");
		expect(reads.filter((number) => number === 31)).toHaveLength(2);
		expect(posts).toHaveLength(0);
		expect([...items.keys()].sort((a, b) => a - b)).toEqual([70, 71, 80, 90]);
	});
});

const daysBefore = (days: number): string =>
	new Date(NOW.getTime() - days * 86_400_000).toISOString();

const SHIPPED_AT = daysBefore(15);

const withPr = (issue: number, pr: number): LaneRecord => ({
	...record(issue, 30, "complete"),
	prs: [pr],
});

/** A shipped, fabrika-labelled bet with a Success line, and what GitHub saw after it shipped. */
const SHIPPED_ISSUES: Readonly<Record<number, IssueSpec>> = {
	...ISSUES,
	50: {
		open: false,
		title: "Faster exports",
		labels: ["type:feature", "fabrika"],
		body: `${PITCH("M")}\n**Success:** exports finish under 2s`,
		records: [withPr(50, 500)],
		timeline: {references: [], reopenedAt: ["2026-09-20T00:00:00Z"]},
	},
	500: {
		open: false,
		timeline: {
			reopenedAt: [],
			references: [
				{
					number: 501,
					title: 'Revert "Faster exports"',
					isPullRequest: true,
					open: false,
					merged: true,
					labels: [],
					createdAt: "2026-09-13T00:00:00Z",
				},
				{
					number: 502,
					title: "Exports crash on Safari",
					isPullRequest: false,
					open: true,
					merged: false,
					labels: ["type:bug"],
					createdAt: "2026-09-20T00:00:00Z",
				},
				{
					number: 503,
					title: "Exports are slow",
					isPullRequest: false,
					open: false,
					merged: false,
					labels: [],
					createdAt: "2026-09-01T00:00:00Z",
				},
			],
		},
	},
};

const shippedRows = (setAt: string): Readonly<Record<number, Cells>> => ({
	...ROWS,
	50: {
		Stage: "shipped",
		setAt,
		Section: "New bets",
		Origin: "bet",
		Size: "M",
		"Table day": PREVIOUS,
	},
});

const configured = (table: unknown) =>
	fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify({table})}}).layer;

const FABRIKA_LABELLED = configured({fabrikaShare: {labels: ["fabrika"]}});

describe("table prep with a boards block", () => {
	const SPLIT = fakeFs({
		files: {"/repo/.fabrika.jsonc": JSON.stringify({boards: {onCall: {}}})},
	}).layer;
	const issues: Readonly<Record<number, IssueSpec>> = {
		...ISSUES,
		50: {
			labels: [...TRIAGED, "type:bug", "p0"],
			title: "Checkout crashes",
			records: [record(50, 18, "complete")],
		},
	};
	const rows: Readonly<Record<number, Cells>> = {
		...ROWS,
		50: {Stage: "in lane", Section: "Outside the bets", Origin: "found mid-lane", "Spent $": 18},
	};
	const targetOf = (fake: ReturnType<typeof world>, issue: number): string | null => {
		const value = fake.onCallItems
			.get(issue)
			?.values.find((one) => one.fieldName === "Response target")?.value;
		return value?._tag === "Option" ? value.name : null;
	};

	it("puts routed issues on the on-call board in arrival order, each with a response target", async () => {
		const split = world(issues, rows);
		const out = await prep(split.board, SPLIT);

		expect(out.code, out.stderr.join("\n")).toBe(0);
		const answer = JSON.parse(out.stdout);
		expect([...split.onCallItems.keys()]).toEqual([30, 40, 41, 50]);
		expect([30, 40, 41, 50].map((issue) => targetOf(split, issue))).toEqual([
			"same day",
			"this week",
			"this week",
			"same day",
		]);
		expect(answer.onCall.items).toEqual([
			{issue: 30, target: "same day"},
			{issue: 40, target: "this week"},
			{issue: 41, target: "this week"},
			{issue: 50, target: "same day"},
		]);
	});

	it("never proposes on-call work at the table", async () => {
		const answer = JSON.parse((await prep(world(issues, rows).board, SPLIT)).stdout);

		expect((answer.agenda as ReadonlyArray<AgendaOut>).map((row) => row.issue)).toEqual([
			70, 11, 20, 60,
		]);
		expect(answer.triageFirst).toEqual([]);
	});

	it("covers both boards in one status update, on-call as one section, and flags its spend over its share", async () => {
		const split = world(issues, rows);
		const answer = JSON.parse((await prep(split.board, SPLIT)).stdout);

		const body = split.posts[0]?.body ?? "";
		expect(body).toContain("- Outside the bets: 1 lane (1 driver pick), $12");
		expect(body).toContain("**On-call** (one section; the table does not review it row by row)");
		expect(body).toContain("- Open items: 4");
		expect(body).toContain(
			"- Spend: 36% of the week's spend ($18 of $50), against a 20% share — over it",
		);
		expect(split.posts[0]?.status).toBe("AT_RISK");
		expect(answer.onCall).toMatchObject({
			spend: {_tag: "Measured", percent: 36, onCallUsd: 18, totalUsd: 50},
			share: 20,
			pastTarget: [],
		});
	});

	it("writes nothing to the on-call board on a second run", async () => {
		const split = world(issues, rows);
		await prep(split.board, SPLIT);
		const again = JSON.parse((await prep(split.board, SPLIT)).stdout);

		expect(again.onCall.changes).toEqual([]);
		expect(again.answer).toBe("unchanged");
	});

	it("proposes a Customers row and reads no on-call board with no boards block", async () => {
		const split = world(issues, rows);
		const answer = JSON.parse((await prep(split.board)).stdout);

		expect(answer.agenda.map((row: AgendaOut) => row.section)).toContain("Customers");
		expect(answer.onCall).toBeUndefined();
		expect(split.onCallItems.size).toBe(0);
		expect(split.posts[0]?.body).not.toContain("On-call");
	});
});

describe("table prep's outcome check", () => {
	it("brings a bet shipped 14 days ago back as a check with its Success line, GitHub signals and fabrika's numbers", async () => {
		const {board, cell, comments} = world(SHIPPED_ISSUES, shippedRows(SHIPPED_AT));
		const out = await prep(board, FABRIKA_LABELLED);

		expect(out.code, out.stderr.join("\n")).toBe(0);
		expect(cell(50, "Stage")).toBe("check");
		expect(cell(50, "Section")).toBe("Tails");
		expect(cell(50, "Table day")).toBe(NEXT);
		expect(cell(50, "Size")).toBe("M");
		const rec = String(cell(50, "Rec"));
		expect(rec).toContain("Success: exports finish under 2s");
		expect(rec).toContain("1 new issue (1 bug), 1 revert, 1 reopened, 0 open follow-ups");
		expect(cell(50, "In plain words")).toBe("Faster exports");

		const posted = comments.get(50) ?? [];
		expect(posted).toHaveLength(1);
		const body = posted[0] ?? "";
		expect(body).toContain("**Success:** exports finish under 2s");
		expect(body).toContain("- Pull requests: #500.");
		expect(body).toContain("- New issues mentioning them: #502 Exports crash on Safari (bug).");
		expect(body).not.toContain("#503");
		expect(body).toContain('- Reverts: #501 Revert "Faster exports" (merged).');
		expect(body).toContain("- Reopened: #50.");
		expect(body).toContain("### fabrika's numbers");
		expect(body).toContain("- Land rate: no lane ended in the 14 days before it shipped");
		expect(body).toContain(checkMarker(50));

		const answer = JSON.parse(out.stdout);
		expect(answer.checks).toMatchObject([{issue: 50, shippedAt: SHIPPED_AT, comment: "posted"}]);
		expect(answer.agenda.some((row: AgendaOut) => row.issue === 50)).toBe(false);
	});

	it("still carries the Success line and GitHub signals with no evidence source and no fabrika label", async () => {
		const {board, comments, spawned} = world(SHIPPED_ISSUES, shippedRows(SHIPPED_AT));
		await prep(board);

		const body = comments.get(50)?.[0] ?? "";
		expect(body).toContain("**Success:** exports finish under 2s");
		expect(body).toContain("- New issues mentioning them: #502");
		expect(body).not.toContain("fabrika's numbers");
		expect(body).not.toContain("Evidence sources");
		expect(spawned).toHaveLength(0);
	});

	it("says so when the pitch names no Success line", async () => {
		const {board, cell, comments} = world(
			{...SHIPPED_ISSUES, 50: {...SHIPPED_ISSUES[50], body: PITCH("M")}},
			shippedRows(SHIPPED_AT),
		);
		await prep(board);

		expect(comments.get(50)?.[0]).toContain("**Success:** none.");
		expect(String(cell(50, "Rec"))).toContain("No Success line.");
	});

	it("attaches each evidence source's output, and reports a failing or timed-out one without failing prep", async () => {
		const scripts: Readonly<Record<string, ChildOutcome>> = {
			"./latency.sh": ran("p95 1.8s\n"),
			"./errors.sh": ran("", 2, "no credentials\n"),
			"./slow.sh": ran("", null),
			"./gone.sh": {_tag: "Unstartable", reason: "ENOENT"},
		};
		const {board, cell, comments, spawned} = world(
			SHIPPED_ISSUES,
			shippedRows(SHIPPED_AT),
			(request) => scripts[request.file] ?? ran(""),
		);
		const out = await prep(
			board,
			configured({
				evidenceSources: [
					{name: "latency", command: ["./latency.sh", "--days", "14"]},
					{name: "errors", command: ["./errors.sh"]},
					{name: "slow", command: ["./slow.sh"], timeoutSeconds: 2},
					{name: "gone", command: ["./gone.sh"]},
				],
			}),
			{PATH: "/usr/bin", GITHUB_TOKEN: "ghp_secret"},
		);

		expect(out.code, out.stderr.join("\n")).toBe(0);
		expect(cell(50, "Stage")).toBe("check");
		const body = comments.get(50)?.[0] ?? "";
		expect(body).toContain("### Evidence sources");
		expect(body).toContain("**latency**:\n\n```\np95 1.8s\n```");
		expect(body).toContain("**errors**: failed, exited 2: no credentials.");
		expect(body).toContain("**slow**: failed, timed out after 2s.");
		expect(body).toContain("**gone**: failed, could not start: ENOENT.");
		expect(out.stderr.join("\n")).toContain(
			'evidence source "errors" on #50 failed: exited 2: no credentials.',
		);

		const latency = spawned.find((request) => request.file === "./latency.sh");
		expect(latency).toMatchObject({args: ["--days", "14"], cwd: "/repo", timeoutSeconds: 60});
		expect(latency?.env).toEqual({
			PATH: "/usr/bin",
			FABRIKA_CHECK_REPO: REPO,
			FABRIKA_CHECK_ISSUE: "50",
			FABRIKA_CHECK_PRS: "500",
			FABRIKA_CHECK_SHIPPED_AT: SHIPPED_AT,
		});
	});

	it("reads the check delay from .fabrika.jsonc, 14 days by default", async () => {
		const recent = shippedRows(daysBefore(10));
		const byDefault = world(SHIPPED_ISSUES, recent);
		await prep(byDefault.board);
		expect(byDefault.cell(50, "Stage")).toBe("shipped");
		expect(byDefault.comments.get(50)).toBeUndefined();

		const tuned = world(SHIPPED_ISSUES, recent);
		await prep(tuned.board, configured({checkDelayDays: 7}));
		expect(tuned.cell(50, "Stage")).toBe("check");
	});

	it("keeps a person's Outcome answer and never re-asks a check", async () => {
		const answered = {
			...ROWS,
			50: {
				Stage: "check",
				Section: "Tails",
				"Table day": PREVIOUS,
				Rec: "did it work?",
				Outcome: "worked",
			},
		};
		const {board, cell, comments} = world(SHIPPED_ISSUES, answered);
		const out = await prep(board);

		expect(out.code).toBe(0);
		expect(cell(50, "Stage")).toBe("check");
		expect(cell(50, "Outcome")).toBe("worked");
		expect(cell(50, "Table day")).toBe(PREVIOUS);
		expect(comments.get(50)).toBeUndefined();
		expect(JSON.parse(out.stdout).checks).toEqual([]);
	});

	it("brings back only bets: a shipped row that ran without a bet stays where it is", async () => {
		const {board, cell, comments} = world(
			{
				...SHIPPED_ISSUES,
				60: {
					open: false,
					title: "Tidy the logs",
					labels: ["type:chore"],
					body: `${PITCH("S")}\n**Success:** fewer log lines`,
					records: [{...withPr(60, 600), origin: "driver-pick"}],
				},
			},
			{
				...shippedRows(SHIPPED_AT),
				60: {
					Stage: "shipped",
					setAt: SHIPPED_AT,
					Section: "Outside the bets",
					Origin: "driver pick",
				},
			},
		);
		const out = await prep(board);

		expect(out.code, out.stderr.join("\n")).toBe(0);
		expect(cell(60, "Stage")).toBe("shipped");
		expect(cell(60, "Section")).toBe("Outside the bets");
		expect(cell(60, "Rec")).toBeNull();
		expect(comments.get(60)).toBeUndefined();
		expect(cell(50, "Stage")).toBe("check");
		expect(JSON.parse(out.stdout).checks.map((check: {issue: number}) => check.issue)).toEqual([
			50,
		]);
	});

	it("posts no second check comment when one already stands", async () => {
		const {board, cell, comments} = world(SHIPPED_ISSUES, shippedRows(SHIPPED_AT));
		comments.set(50, [`an earlier run\n${checkMarker(50)}`]);
		const out = await prep(board);

		expect(cell(50, "Stage")).toBe("check");
		expect(comments.get(50)).toHaveLength(1);
		expect(JSON.parse(out.stdout).checks).toMatchObject([{issue: 50, comment: "standing"}]);
	});
});
