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
import {absent, type ListedIssue, present} from "../io/issues.ts";
import type {
	BoardIteration,
	FieldValue,
	ItemFieldValue,
	ProjectItem,
	ProjectSnapshot,
	ProjectsAnswer,
	StatusUpdate,
	StatusUpdateInput,
} from "../io/projects.ts";
import {emit, type Instant, type LaneRecord} from "../wire/lane-record.ts";
import {NO_ITERATION} from "./codes.ts";
import {type PrepBoard, runPrep} from "./prep-verb.ts";
import {ORIGINS, STAGES} from "./shape.ts";
import type {SyncNode} from "./sync.ts";

const REPO = "acme/widgets";
const OWNER = "octo-owner";
/** A Sunday; the shipped table day is Monday, so prep readies the Sep 28 iteration. */
const NOW = new Date("2026-09-27T12:00:00.000Z");

const PREVIOUS: BoardIteration = {
	id: "it_21",
	title: "Sep 21",
	startDate: "2026-09-21",
	duration: 7,
};
const NEXT: BoardIteration = {id: "it_28", title: "Sep 28", startDate: "2026-09-28", duration: 7};

const selectField = (id: string, name: string, names: ReadonlyArray<string>) => ({
	_tag: "SingleSelect" as const,
	id,
	name,
	options: names.map((n) => ({id: `${id}:${n}`, name: n, color: "GRAY" as const, description: ""})),
});

const PROJECT: ProjectSnapshot = {
	id: "PVT_1",
	number: 3,
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
		{_tag: "Plain", id: "F_spent", name: "Spent $", dataType: "NUMBER"},
		{_tag: "Plain", id: "F_asks", name: "Asks", dataType: "NUMBER"},
		selectField(
			"F_origin",
			"Origin",
			ORIGINS.map((origin) => origin.name),
		),
		{_tag: "Plain", id: "F_rec", name: "Rec", dataType: "TEXT"},
		{_tag: "Plain", id: "F_plain", name: "In plain words", dataType: "TEXT"},
		{_tag: "Iteration", id: "F_week", name: "Week", duration: 7, startDay: 1},
	],
	views: [],
};

const fieldById = new Map(PROJECT.fields.map((field) => [field.id, field] as const));

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
}

type Cells = Readonly<Record<string, string | number>>;

const cellValue = (fieldName: string, raw: string | number): ItemFieldValue => {
	const field = PROJECT.fields.find((one) => one.name === fieldName);
	if (field === undefined) throw new Error(`no field ${fieldName}`);
	const at = {fieldId: field.id, fieldName, creator: OWNER, updatedAt: "2026-09-26T00:00:00.000Z"};
	if (field._tag === "SingleSelect") {
		return {...at, value: {_tag: "Option", optionId: `${field.id}:${raw}`, name: String(raw)}};
	}
	if (field._tag === "Iteration") {
		const iteration = [PREVIOUS, NEXT].find((one) => one.id === raw);
		return {
			...at,
			value: {_tag: "Iteration", iterationId: String(raw), title: iteration?.title ?? "?"},
		};
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
		Week: PREVIOUS.id,
		Rec: "yes.",
	},
	71: {Stage: "bet", Section: "New bets", Size: "M", Week: PREVIOUS.id, Rec: "yes."},
	80: {Stage: "proposed", Section: "Customers", Week: PREVIOUS.id, Rec: "yes."},
	90: {Stage: "in lane", Section: "Outside the bets", Origin: "driver pick", "Spent $": 12},
};

const world = (
	issues: Readonly<Record<number, IssueSpec>> = ISSUES,
	rows: Readonly<Record<number, Cells>> = ROWS,
	iterations: ReadonlyArray<BoardIteration> = [PREVIOUS, NEXT],
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
	const itemByid = (itemId: string) => [...items.values()].find((item) => item.itemId === itemId);
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
		locate: () => Effect.succeed(ok({_tag: "Located", project: PROJECT})),
		items: () =>
			Effect.sync(() =>
				ok([
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
			Effect.succeed({_tag: "Ok" as const, value: (issues[number]?.records ?? []).map(emit)}),
		week: () => Effect.succeed(ok({running: iterations, completed: []})),
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
		add: (_projectId, _repo, issue) => {
			if (!items.has(issue)) items.set(issue, {itemId: `PVTI_${issue}`, values: []});
			return Effect.succeed(ok(`PVTI_${issue}`));
		},
		set: (target, value: FieldValue) => {
			const item = itemByid(target.itemId);
			const field = fieldById.get(target.fieldId);
			if (item === undefined || field === undefined) return Effect.succeed(ok(target.itemId));
			const shown =
				value._tag === "Option"
					? value.optionId.slice(value.optionId.indexOf(":") + 1)
					: value._tag === "Iteration"
						? value.iterationId
						: value._tag === "Text"
							? value.text
							: value._tag === "Number"
								? value.number
								: value.date;
			item.values = [
				...item.values.filter((one) => one.fieldId !== target.fieldId),
				cellValue(field.name, shown),
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
	return {board, items, posts, cell};
};

const prep = (board: PrepBoard<never>, config = unconfigured) =>
	Effect.runPromise(
		Effect.provide(
			runPrep({repo: REPO, cwd: "/repo", env: {}, now: NOW, board}),
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
		expect(answer.iteration).toEqual({id: NEXT.id, title: NEXT.title, startDate: NEXT.startDate});
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
			expect(cell(row.issue, "Week")).toBe(NEXT.id);
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
		expect(cell(71, "Week")).toBe(NEXT.id);
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

	it("adds no row and posts no second update on a second run in the same iteration", async () => {
		const {board, posts} = world();
		await prep(board);
		const again = await prep(board);

		expect(again.code).toBe(0);
		const answer = JSON.parse(again.stdout);
		expect(answer).toMatchObject({answer: "unchanged", changes: []});
		expect(answer.health).toMatchObject({posted: false, alreadyPosted: true});
		expect(posts).toHaveLength(1);
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

	it("refuses and writes nothing when no Week iteration covers the next table day", async () => {
		const {board, posts, items} = world(ISSUES, ROWS, [PREVIOUS]);
		const out = await prep(board);

		expect(out.code).toBe(NO_ITERATION);
		expect(out.stderr.join("\n")).toContain("add the coming weeks");
		expect(posts).toHaveLength(0);
		expect(items.get(71)?.values.find((one) => one.fieldName === "Week")?.value).toMatchObject({
			iterationId: PREVIOUS.id,
		});
	});
});
