/**
 * `status open` — the composite front-door readout: six fields, each with its own state, source
 * and freshness.
 *
 * **This verb has no zero-scope seat and no failed-read seat at all.** It is the command the skill
 * injects before the session reads a token, and `../verb.ts`'s `refuse()` hardcodes empty stdout —
 * so a front door that refused would be silent on exactly the cold start it exists for. Every
 * source it cannot read becomes a *field state*. Its only refusal is a bad `--field`.
 *
 * **It composes by importing the sibling verbs' pure cores, never by spawning a verb and reading
 * its exit code.** A composite that mapped sibling exit codes would be the package's first
 * cross-group code reader, which would turn every legitimate code reuse into a defect. The mapping
 * from a core's outcome to a field state is the table below, stated rather than left to the
 * implementer, because that mapping *is* the group's purpose: keeping proven-empty apart from
 * unread.
 *
 * **No aggregate state, deliberately.** A roll-up over independently-sourced fields would need
 * a rule for "three fine, one unknown", and every such rule either hides the unknown or drowns the
 * three.
 */
import {ANSWER, answer, refuse, type VerbOutcome} from "../verb.ts";
import type {BoardRead} from "./board-verb.ts";
import {boardState} from "./board-verb.ts";
import {OFF_VOCABULARY} from "./codes.ts";
import {type AsOf, asOfToken, detail, noAsOf, row} from "./fields.ts";
import {menuState} from "./menu-verb.ts";
import {type ReadoutRead, readingOf} from "./readout-verb.ts";
import type {RosterRead} from "./roster.ts";
import {type SettingRow, settingsState} from "./settings-verb.ts";
import {SETTINGS_PATH, type WiringRead} from "./wiring-verb.ts";

const VERB = "status open";

/** The closed `--field` vocabulary. Any other value is off-vocabulary. */
export const FIELDS = ["menu", "settings", "wiring", "board", "readout", "lanes"] as const;
export type FieldName = (typeof FIELDS)[number];

export interface Field {
	readonly name: FieldName;
	readonly state: string;
	readonly detail: string;
	readonly source: string;
	readonly asOf: AsOf;
}

/** `unknown` is in every field's closed set — that is what makes this verb total. */
export const UNKNOWN = "unknown";

const rosterSource = (roster: RosterRead): string => roster.display;

export const menuField = (roster: RosterRead, asOf: AsOf): Field =>
	roster._tag === "Resolved"
		? {
				name: "menu",
				state: menuState(roster.skills.length),
				detail:
					roster.skills.length === 0
						? `no skills in ${roster.tier} roster`
						: `${roster.skills.length} skills`,
				source: rosterSource(roster),
				asOf,
			}
		: {
				name: "menu",
				state: UNKNOWN,
				detail: detail(
					roster._tag === "Failed" ? roster.reason : "the named --skills-dir is not there",
				),
				source: rosterSource(roster),
				asOf: noAsOf,
			};

/**
 * What this repo runs on, off the one config surface — the field that replaced the per-skill
 * declaration probe when the `## Required repo files` tables retired (#6301).
 *
 * A key that did not resolve makes the whole field `unknown`, carrying those keys' names. A partial
 * green here would be the collapse the config surface exists to prevent: a reader cannot act on
 * "four keys resolved" without knowing whether the fifth is a default or unread.
 */
export const settingsField = (
	rows: ReadonlyArray<SettingRow>,
	source: string,
	asOf: AsOf,
): Field => {
	const unknown = rows.filter((one) => one.provenance === "unknown");
	const declared = rows.filter((one) => one.provenance === "declared").length;
	return {
		name: "settings",
		state: rows.length === 0 ? UNKNOWN : settingsState(rows),
		detail:
			rows.length === 0
				? "the config surface registers zero keys"
				: unknown.length === 0
					? `${rows.length} keys, ${declared} declared`
					: detail(`${unknown.length} unread: ${unknown.map((one) => one.key).join(", ")}`),
		source,
		asOf: rows.length === 0 ? noAsOf : asOf,
	};
};

/**
 * Whether this repo's sessions load fabrika's skills at all — the field the CLI half cannot imply.
 *
 * Every other field answers about something the CLI reads, and all of them answered green in the
 * repo where no skill could load (#6443). A proven-off plugin is `unwired` rather than `unknown`:
 * the repo proved it, and collapsing it into `unknown` would hide the one gap this field exists to
 * name.
 */
export const wiringField = (read: WiringRead, asOf: AsOf): Field => ({
	name: "wiring",
	state: read.state === "unknown" ? UNKNOWN : read.state,
	detail: read.detail,
	source: SETTINGS_PATH,
	asOf: read.state === "unknown" ? noAsOf : asOf,
});

export const boardField = (read: BoardRead): Field => {
	if (read._tag === "Failed") {
		return {
			name: "board",
			state: UNKNOWN,
			detail: detail(`${read.reason} — a failed read, not zero issues`),
			source: read.repo,
			asOf: noAsOf,
		};
	}
	const state = boardState(read.buckets);
	const first = read.buckets.find((bucket) => bucket.name === "needs-triage");
	const second = read.buckets.find((bucket) => bucket.name === "triaged");
	if (state === "counted") {
		return {
			name: "board",
			state,
			detail: `${first?.count ?? 0} needs-triage, ${second?.count ?? 0} triaged`,
			source: read.repo,
			asOf: read.buckets[0]?.asOf ?? noAsOf,
		};
	}
	const unknown = read.buckets.filter((bucket) => bucket.count === null);
	return {
		name: "board",
		state: UNKNOWN,
		detail: detail(
			`${unknown.map((bucket) => bucket.name).join(",")}: ${unknown[0]?.detail ?? "unreadable"}`,
		),
		source: read.repo,
		asOf: noAsOf,
	};
};

/**
 * **A proven-absent artifact is `absent` inside the composite, never `unknown`** — an absence the
 * repository proves is a fact. Only a failed *read* is `unknown`, which is why an unregistered
 * decoder lands there: an unbuilt decoder proves nothing about whether a digest exists.
 */
export const readoutField = (read: ReadoutRead): Field => {
	const reading = readingOf(read);
	if (reading !== null) {
		return {
			name: "readout",
			state: reading.state,
			detail: reading.detail,
			source: reading.source,
			asOf: reading.asOf,
		};
	}
	return {
		name: "readout",
		state: UNKNOWN,
		detail: detail(
			read._tag === "NoFormat"
				? "the governance-digest format is not registered — a failed read, not an absent digest"
				: read._tag === "Unfetchable"
					? `${read.reason} — a failed read, not an absent digest`
					: "the digest could not be read",
		),
		source:
			read._tag === "Unfetchable" && read.issue !== null
				? `${read.repo}#${read.issue}`
				: read._tag === "NoFormat"
					? "unknown"
					: read.repo,
		asOf: noAsOf,
	};
};

/** What `lanes` reads out of `fabrika lane stale`'s documented answer object. */
interface StaleSweep {
	readonly olderThanMinutes: number;
	readonly lanes: ReadonlyArray<{
		readonly key: string;
		readonly verdict: string;
		readonly ageMinutes: number | null;
		readonly reason?: string;
	}>;
}

const parseSweep = (stdout: string): StaleSweep | null => {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!Array.isArray((parsed as StaleSweep).lanes)
		) {
			return null;
		}
		return parsed as StaleSweep;
	} catch {
		return null;
	}
};

/**
 * The stale-lane sweep as a field, composed from `lane stale`'s in-process outcome — the one field
 * sourced outside this group, because lanes are machine-local and no scheduled job can see them
 * (#5908). The sweep's refusal (an unreadable root) and a lane whose record does not read are both
 * `unknown` with the reason, never flattened to clean; zero stale lanes — including zero lanes on
 * disk at all — is the proven negative `empty`.
 */
export const lanesField = (
	outcome: VerbOutcome,
	roots: ReadonlyArray<string>,
	asOf: AsOf,
): Field => {
	const source = roots.join(",");
	if (outcome.code !== ANSWER) {
		return {
			name: "lanes",
			state: UNKNOWN,
			detail: detail(outcome.stderr.at(-1) ?? "the sweep refused without naming a reason"),
			source,
			asOf: noAsOf,
		};
	}
	const sweep = parseSweep(outcome.stdout);
	if (sweep === null) {
		return {
			name: "lanes",
			state: UNKNOWN,
			detail: detail(
				"the sweep's answer is not the documented object — a failed read, not zero lanes",
			),
			source,
			asOf: noAsOf,
		};
	}
	const stale = sweep.lanes.filter((lane) => lane.verdict === "stale");
	const unreadable = sweep.lanes.filter((lane) => lane.verdict === "unreadable");
	if (stale.length > 0) {
		const tail = unreadable.length > 0 ? ` — ${unreadable.length} unreadable` : "";
		return {
			name: "lanes",
			state: "stale",
			detail: detail(
				`${stale.length} stale: ${stale.map((lane) => `${lane.key} (${String(lane.ageMinutes)}m)`).join(", ")}${tail}`,
			),
			source,
			asOf,
		};
	}
	if (unreadable.length > 0) {
		const first = unreadable[0];
		return {
			name: "lanes",
			state: UNKNOWN,
			detail: detail(
				`${unreadable.length} lane(s) unreadable: ${first?.key ?? "?"} — ${first?.reason ?? "no reason recorded"}`,
			),
			source,
			asOf: noAsOf,
		};
	}
	return {
		name: "lanes",
		state: "empty",
		detail:
			sweep.lanes.length === 0
				? "no lanes on disk"
				: `${sweep.lanes.length} lane(s), none silent past ${sweep.olderThanMinutes}m`,
		source,
		asOf,
	};
};

export const isFieldName = (value: string): value is FieldName =>
	(FIELDS as ReadonlyArray<string>).includes(value);

/** The one refusal seat this verb has. */
export const badFieldRefusal = (value: string): VerbOutcome =>
	refuse(OFF_VOCABULARY, `${VERB}: --field "${value}" is not one of ${FIELDS.join(", ")}.`);

export interface OpenInput {
	readonly fields: ReadonlyArray<Field>;
	readonly json: boolean;
	/** The notice line's scope half — the roster, its tier and the repo the reads resolved to. */
	readonly scope: string;
}

export const runOpen = ({fields, json, scope}: OpenInput): VerbOutcome => {
	const unknown = fields.filter((field) => field.state === UNKNOWN).length;
	const notice = `${VERB}: ${scope}; ${fields.length} field(s) rendered, ${unknown} unknown.`;
	if (json) {
		return answer(
			`${JSON.stringify({
				outcome: "open",
				fields: fields.map((field) => ({
					name: field.name,
					state: field.state,
					detail: field.detail,
					source: field.source,
					asOf: field.asOf.at,
					asOfKind: field.asOf.kind,
				})),
			})}\n`,
			[notice],
		);
	}
	const lines = [
		row("open", String(fields.length)),
		...fields.map((field) =>
			row("field", field.name, field.state, field.detail, field.source, asOfToken(field.asOf)),
		),
	];
	return answer(`${lines.join("\n")}\n`, [notice]);
};
