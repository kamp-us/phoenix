/**
 * The shape a table's project has: its fields and their options, its views, its README, and the
 * manual steps GitHub's API cannot take. Derived from the `table` settings and the `appetiteSizes`
 * dollars alone, so a repo with no config and a repo with a tuned block get the same project shape
 * with their own numbers in it.
 *
 * Field and view names are the vocabulary later table slices read back, so they are fixed here and
 * not configurable: a renamed `Stage` field would be a field no sync could find.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import type {AppetiteSizes} from "../config/keys/appetite-sizes.ts";
import {
	type Cadence,
	OUTSIDE_THE_BETS,
	type ProjectTarget,
	type TableSettings,
	WEEKDAYS,
} from "../config/keys/table.ts";
import type {FieldSpec, OptionColor, ViewLayout} from "../io/projects.ts";

export const FIELD = {
	title: "Title",
	stage: "Stage",
	section: "Section",
	size: "Size",
	spent: "Spent $",
	asks: "Asks",
	origin: "Origin",
	rec: "Rec",
	plainWords: "In plain words",
	outcome: "Outcome",
	week: "Week",
} as const;

interface Choice {
	readonly name: string;
	readonly description: string;
}

export const STAGES: ReadonlyArray<Choice> = [
	{name: "proposed", description: "On the agenda, waiting for a yes or no."},
	{name: "bet", description: "Said yes at the table. Agents pick these first."},
	{name: "not now", description: "Said no this time. Stays an issue."},
	{name: "in lane", description: "An agent is working on it."},
	{name: "shipped", description: "Merged."},
	{name: "check", description: "Back at the table to ask: did it work?"},
];

export const ORIGINS: ReadonlyArray<Choice> = [
	{name: "bet", description: "Picked at a table."},
	{name: "customer", description: "Reported by someone using the product."},
	{name: "hand-start", description: "A person started it by hand."},
	{name: "driver pick", description: "The driving agent picked it without a bet."},
	{name: "found mid-lane", description: "Found while doing other work."},
	{name: "experiment", description: "A try-it-and-see."},
];

/** A person's answer to a check. Prep and sync never write it, so the answer stands once given. */
export const OUTCOMES: ReadonlyArray<Choice> = [
	{name: "worked", description: "It did what its Success line said."},
	{name: "didn't", description: "It did not do what its Success line said."},
	{name: "can't tell", description: "The evidence does not say either way."},
];

const KNOWN_SECTIONS: Readonly<Record<string, string>> = {
	Tails:
		"Unfinished leftovers: follow-ups after an epic, rulings never built, the last items of a campaign. Finish these first.",
	Customers: "Reported by someone using the product.",
	"New bets": "New work proposed for this table.",
	[OUTSIDE_THE_BETS]:
		"Work that ran without a bet. Shown so the table sees how much unplanned work happens.",
};

const sectionDescription = (name: string): string =>
	KNOWN_SECTIONS[name] ?? "A section this repository added to the agenda.";

const OPTION_COLOR: OptionColor = "GRAY";

const options = (choices: ReadonlyArray<Choice>) =>
	choices.map((choice) => ({
		name: choice.name,
		color: OPTION_COLOR,
		description: choice.description,
	}));

export interface ViewShape {
	readonly name: string;
	readonly layout: ViewLayout;
	readonly filter: string;
	/** Field names, in display order. */
	readonly fields: ReadonlyArray<string>;
}

export interface TableShape {
	readonly title: string;
	readonly shortDescription: string;
	readonly readme: string;
	readonly fields: ReadonlyArray<FieldSpec>;
	readonly views: ReadonlyArray<ViewShape>;
	readonly manualSteps: ReadonlyArray<string>;
}

/** The filter GitHub's Auto-add workflow is set to, so every unlabeled issue lands in Inbox. */
export const INBOX_AUTO_ADD_FILTER = "is:issue is:open no:label";

export const INBOX_VIEW_FILTER = "is:open no:label";

const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

const filterKey = (field: string): string => field.toLowerCase();

const LANE_STAGES = ["bet", "in lane", "shipped", "check"];

const WIDE_FIELDS: ReadonlyArray<string> = [
	FIELD.title,
	FIELD.stage,
	FIELD.section,
	FIELD.size,
	FIELD.origin,
	FIELD.spent,
	FIELD.asks,
	FIELD.rec,
	FIELD.outcome,
	FIELD.week,
];

export const VIEWS: ReadonlyArray<ViewShape> = [
	{
		name: "Agenda",
		layout: "TABLE_LAYOUT",
		filter: `${filterKey(FIELD.week)}:@current has:${filterKey(FIELD.section)} -${filterKey(FIELD.section)}:${quote(OUTSIDE_THE_BETS)} has:${filterKey(FIELD.rec)}`,
		fields: [
			FIELD.title,
			FIELD.stage,
			FIELD.size,
			FIELD.spent,
			FIELD.asks,
			FIELD.rec,
			FIELD.plainWords,
			FIELD.outcome,
		],
	},
	{
		name: OUTSIDE_THE_BETS,
		layout: "TABLE_LAYOUT",
		filter: `${filterKey(FIELD.section)}:${quote(OUTSIDE_THE_BETS)}`,
		fields: WIDE_FIELDS,
	},
	{
		name: "Lanes",
		layout: "BOARD_LAYOUT",
		filter: `has:${filterKey(FIELD.section)} ${filterKey(FIELD.stage)}:${LANE_STAGES.map(quote).join(",")}`,
		fields: WIDE_FIELDS,
	},
	{
		name: "Group members",
		layout: "TABLE_LAYOUT",
		filter: `no:${filterKey(FIELD.section)} has:label`,
		fields: [FIELD.title, FIELD.stage, FIELD.spent, FIELD.asks],
	},
	{
		name: "Inbox",
		layout: "TABLE_LAYOUT",
		filter: INBOX_VIEW_FILTER,
		fields: [FIELD.title],
	},
];

/** The two steps GitHub's API cannot take, worded once for the verb's answer and the README. */
export const manualSteps = (repo: string): ReadonlyArray<string> => [
	`Grouping: in the Agenda view, set Group by: ${FIELD.section} and save the view; in the Lanes view, set Column by: ${FIELD.stage} and save it. GitHub's GraphQL API cannot set a view's grouping.`,
	`Inbox auto-add: in the project's Workflows, turn on "Auto-add to project" for ${repo} with the filter \`${INBOX_AUTO_ADD_FILTER}\`, and save it. Every issue nobody labeled then lands in Inbox. GitHub's API cannot create a workflow.`,
];

const ITERATION_DAYS: Readonly<Record<Cadence, number>> = {
	weekly: 7,
	biweekly: 14,
	"on-demand": 7,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** The most recent table day on or before `today`, in UTC — where the first iteration starts. */
export const iterationStart = (settings: TableSettings, today: Date): Date => {
	const target = WEEKDAYS.indexOf(settings.day);
	const back = (today.getUTCDay() - target + 7) % 7;
	return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
};

const cadenceWords: Readonly<Record<Cadence, string>> = {
	weekly: "every week",
	biweekly: "every two weeks",
	"on-demand": "when someone calls it",
};

const capitalized = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

const dollars = (amount: number): string => `$${amount}`;

export const renderReadme = (
	settings: TableSettings,
	sizes: AppetiteSizes,
	repo: string,
): string => {
	const day = capitalized(settings.day);
	const steps = manualSteps(repo);
	const agendaOrder = settings.sections.filter((name) => name !== OUTSIDE_THE_BETS).join(", then ");
	const lines = [
		"# How to use this table",
		"",
		`One row is one piece of work. The table meets ${cadenceWords[settings.cadence]}${settings.cadence === "on-demand" ? "" : ` on ${day}`} and decides what gets bet on; everything else stays in the issue backlog. Anything can still start anytime; it just shows up under "${OUTSIDE_THE_BETS}".`,
		"",
		"## Before the table (fabrika does this)",
		`- Adds up to ${settings.agendaCap} **proposed** rows, each with a size, a rec and a line in plain words.`,
		"- Carries every running bet into the new week. Only a flagged one comes back on the agenda; the rest keep going quietly, with no rec.",
		`- Brings back every bet **shipped** ${settings.checkDelayDays} days ago or more as a **check**, with its evidence posted on the issue. A bet is a row whose **${FIELD.origin}** reads \`bet\`; a row that ran without a bet stays where it is.`,
		"- Posts the health numbers as the project's **status update**.",
		`- Needs the week to exist: keep the coming weeks added under **${FIELD.week}** in the project's settings.`,
		"",
		"## At the table",
		"1. Read the latest status update: click the status badge at the top of the project.",
		`2. Open **Agenda** and go top to bottom: ${agendaOrder}.`,
		`3. Per row: read **${FIELD.plainWords}** and the **${FIELD.rec}**, then set **${FIELD.stage}** to \`bet\` or \`not now\`. Open the issue only if that isn't enough.`,
		`4. Per **check** row: read the check comment on its issue, then set **${FIELD.outcome}** to ${OUTCOMES.map((outcome) => `\`${outcome.name}\``).join(", ")}.`,
		`5. Open **${OUTSIDE_THE_BETS}**: for each thing that ran without a bet, say keep, finish, or drop.`,
		"",
		"## During the week",
		"- **Lanes** is the board: what's bet, in a lane, shipped, or due for its check.",
		`- **Inbox** holds every open issue nobody labeled, so nothing sits where triage can't see it.`,
		`- Anything over its size, at ${settings.asksFlag} asks, or quiet for ${settings.stuckDays} days comes back on the next agenda.`,
		"",
		"## One-time setup",
		"GitHub's API can't do these two, so set them by hand once:",
		...steps.map((step, index) => `${index + 1}. ${step}`),
		"",
		"---",
		"",
		"# What the columns mean",
		"",
		`## ${FIELD.week}`,
		`Which table the row belongs to. One iteration is one table. \`@current\` is this one.`,
		"",
		`## ${FIELD.section}: why the row is on the agenda`,
		...settings.sections.map((name) => `- **${name}**: ${sectionDescription(name)}`),
		"",
		`## ${FIELD.stage}: where the row is right now`,
		...STAGES.map((stage) => `- **${stage.name}**: ${stage.description}`),
		"",
		`## ${FIELD.size}: how much the bet may spend`,
		`- **S**: about ${dollars(sizes.S)}.`,
		`- **M**: about ${dollars(sizes.M)}.`,
		`- **L**: an epic, about ${dollars(sizes.L)} per child.`,
		`Passing the size brings the row back to the table; the lane stops at ${settings.stopMultiple}x its size.`,
		"",
		`## ${FIELD.spent}`,
		"What the bet has spent so far. Empty until work starts. The limit is the size, not this column.",
		"",
		`## ${FIELD.asks}`,
		`How many times the work needed a person (an approval, an unblock, a ruling). Tracked, not limited: a bet that reaches ${settings.asksFlag} asks is flagged at the next table.`,
		"",
		`## ${FIELD.origin}: where the work came from`,
		...ORIGINS.map((origin) => `- **${origin.name}**: ${origin.description}`),
		"",
		`## ${FIELD.rec}`,
		"The agent's recommendation for this row, in a few words. Take it or overturn it.",
		"",
		`## ${FIELD.plainWords}`,
		"One line saying what the row is, written for a person deciding it.",
		"",
		`## ${FIELD.outcome}: did it work?`,
		`A shipped bet comes back as \`check\` ${settings.checkDelayDays} days after it ships, with its Success line, what happened on GitHub since, and any evidence this repository collects. Answer it here; fabrika never changes the answer.`,
		...OUTCOMES.map((outcome) => `- **${outcome.name}**: ${outcome.description}`),
	];
	return lines.join("\n");
};

export const defaultTitle = (repo: string): string => `${repo.split("/")[1] ?? repo} table`;

/** Where one board lives: the title setup gives it and finds it by, and the config that pins it. */
export interface BoardTarget {
	readonly title: string;
	readonly project: ProjectTarget;
	/** The `.fabrika.jsonc` path `project` is read from, as a refusal names it. */
	readonly key: string;
}

/** The weekly table — the product board when `boards` splits the work. */
export const productBoard = (repo: string, settings: TableSettings): BoardTarget => ({
	title: defaultTitle(repo),
	project: settings.project,
	key: "table.project",
});

export const tableShape = (
	settings: TableSettings,
	sizes: AppetiteSizes,
	repo: string,
	title: string,
	today: Date,
): TableShape => {
	const start = iterationStart(settings, today);
	return {
		title,
		shortDescription: `The betting table for ${repo}: what gets bet on, and whether it worked.`,
		readme: renderReadme(settings, sizes, repo),
		fields: [
			{_tag: "SingleSelect", name: FIELD.stage, options: options(STAGES)},
			{
				_tag: "SingleSelect",
				name: FIELD.section,
				options: options(
					settings.sections.map((name) => ({name, description: sectionDescription(name)})),
				),
			},
			{
				_tag: "SingleSelect",
				name: FIELD.size,
				options: options([
					{name: "S", description: `About ${dollars(sizes.S)}.`},
					{name: "M", description: `About ${dollars(sizes.M)}.`},
					{name: "L", description: `About ${dollars(sizes.L)} per epic child.`},
				]),
			},
			{_tag: "Number", name: FIELD.spent},
			{_tag: "Number", name: FIELD.asks},
			{_tag: "SingleSelect", name: FIELD.origin, options: options(ORIGINS)},
			{_tag: "Text", name: FIELD.rec},
			{_tag: "Text", name: FIELD.plainWords},
			{_tag: "SingleSelect", name: FIELD.outcome, options: options(OUTCOMES)},
			{
				_tag: "Iteration",
				name: FIELD.week,
				startDate: isoDate(start),
				duration: ITERATION_DAYS[settings.cadence],
				firstTitle: `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}`,
			},
		],
		views: VIEWS,
		manualSteps: manualSteps(repo),
	};
};
