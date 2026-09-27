/**
 * The on-call board a `boards` block adds: which issues it holds, the target each waits against, and
 * the project it lives in. Pure: routing reads an issue's attributes and nothing else, so which board
 * an issue lands on is a property of this module, not of a live run.
 *
 * **Every issue lands on exactly one board.** {@link boardOf} answers `on-call` when any one routing
 * attribute matches and `product` otherwise, so no issue is on neither and none is on both.
 *
 * **An on-call item carries a response target, never a size.** Work there is not bet on; it is pulled
 * in the order it arrives, and the target says how long it may wait before the table hears of it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9914
 */

import {typeLabel} from "../config/board.ts";
import type {OnCallBoard, ResponseTarget, ResponseTargets, Route} from "../config/keys/boards.ts";
import {type BoardTarget, FIELD, type TableShape, type ViewShape} from "./shape.ts";

export type BoardName = "product" | "on-call";

export const ON_CALL_FIELD = {responseTarget: "Response target"} as const;

/** What routing reads off one issue. */
export interface RouteFacts {
	/**
	 * Every Origin the issue is known by, empty when nothing names one. Any one matching routes the
	 * issue, so a lane Origin written onto its row later never hides that a customer filed it.
	 */
	readonly origins: ReadonlyArray<string>;
	readonly labels: ReadonlyArray<string>;
}

/** The board `facts` land on under `route`: on-call when any origin, its type or any label matches. */
export const boardOf = (facts: RouteFacts, route: Route): BoardName => {
	const byOrigin = facts.origins.some((origin) => route.origins.includes(origin));
	const byType = route.types.some((type) => facts.labels.includes(typeLabel(type)));
	const byLabel = route.labels.some((label) => facts.labels.includes(label));
	return byOrigin || byType || byLabel ? "on-call" : "product";
};

/** Every target, in the order they are matched: the labeled ones, then the fallback. */
export const targetsOf = (targets: ResponseTargets): ReadonlyArray<ResponseTarget> => [
	...targets.byLabel.map(({name, hours}) => ({name, hours})),
	targets.otherwise,
];

/** The target an item carrying `labels` waits against: the first labeled match, else the fallback. */
export const responseTargetOf = (
	labels: ReadonlyArray<string>,
	targets: ResponseTargets,
): ResponseTarget => {
	const matched = targets.byLabel.find((target) =>
		target.labels.some((label) => labels.includes(label)),
	);
	return matched === undefined ? targets.otherwise : {name: matched.name, hours: matched.hours};
};

export const onCallTitle = (repo: string): string => `${repo.split("/")[1] ?? repo} on-call`;

export const onCallBoard = (repo: string, settings: OnCallBoard): BoardTarget => ({
	title: onCallTitle(repo),
	project: settings.project,
	key: "boards.onCall.project",
});

const hoursWords = (hours: number): string => `${hours} hour${hours === 1 ? "" : "s"}`;

const listed = (names: ReadonlyArray<string>): string =>
	names.length === 0 ? "none" : names.map((name) => `\`${name}\``).join(", ");

export const ON_CALL_VIEWS: ReadonlyArray<ViewShape> = [
	{
		name: "Queue",
		layout: "TABLE_LAYOUT",
		filter: "is:open",
		fields: [FIELD.title, ON_CALL_FIELD.responseTarget, FIELD.plainWords],
	},
];

export const renderOnCallReadme = (settings: OnCallBoard): string => {
	const {route} = settings;
	const lines = [
		"# How to use the on-call board",
		"",
		"Work here is continuous: nothing is bet on. It holds what cannot wait for the weekly table, such as customer reports, crashes and CI breakage.",
		"",
		"- `fabrika table prep` adds every open issue the routing rule sends here, in the order it arrives, and gives each a **Response target**.",
		"- Pull from the top of **Queue**.",
		"- An item still open past its target is flagged by `fabrika table flags` and counted on the table's weekly status update.",
		`- On-call has its own share of the week's spend: ${settings.spendShare}%. More than that is flagged at the table, never stopped.`,
		"- The table reviews on-call as one section of its status update, not row by row.",
		"",
		"## What sends an issue here",
		"An issue comes here when any one of these matches; everything else stays on the table.",
		`- Origin: ${listed(route.origins)}`,
		`- Type: ${listed(route.types)}`,
		`- Label: ${listed(route.labels)}`,
		"",
		"---",
		"",
		"# What the columns mean",
		"",
		`## ${ON_CALL_FIELD.responseTarget}: how long the item may wait`,
		...settings.responseTargets.byLabel.map(
			(target) =>
				`- **${target.name}**: within ${hoursWords(target.hours)}, for items labeled ${listed(target.labels)}.`,
		),
		`- **${settings.responseTargets.otherwise.name}**: within ${hoursWords(settings.responseTargets.otherwise.hours)}, for everything else.`,
		"The wait counts from when prep set the target, which is when the item arrived here.",
		"",
		`## ${FIELD.plainWords}`,
		"One line saying what the item is, written for a person.",
	];
	return lines.join("\n");
};

/** The on-call project's shape. It has a Response target where the table has a Size, and no Week. */
export const onCallShape = (settings: OnCallBoard, repo: string, title: string): TableShape => ({
	title,
	shortDescription: `The on-call board for ${repo}: continuous work, each item with a response target.`,
	readme: renderOnCallReadme(settings),
	fields: [
		{
			_tag: "SingleSelect",
			name: ON_CALL_FIELD.responseTarget,
			options: targetsOf(settings.responseTargets).map((target) => ({
				name: target.name,
				color: "GRAY" as const,
				description: `Answer within ${hoursWords(target.hours)}.`,
			})),
		},
		{_tag: "Text", name: FIELD.plainWords},
	],
	views: ON_CALL_VIEWS,
	manualSteps: [],
});
