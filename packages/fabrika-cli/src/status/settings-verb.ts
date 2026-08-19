/**
 * `status settings` — every key on the config surface, its resolved value, and where that value
 * came from. The one place a skill asks what `.fabrika.jsonc` resolves to, so no skill document has
 * to restate a value (R9.1, #6293).
 *
 * **Provenance is the load-bearing column.** "the governance roots are the four shipped defaults"
 * and "the governance roots are four values this repo declared" are different facts, and an agent
 * reading a bare value cannot tell whether the repo made a choice. So each row says which.
 *
 * A key whose value could not be established prints UNKNOWN and the verb exits non-zero — never a
 * green readout over defaults, which is the collapse the whole config surface exists to prevent.
 * A non-zero exit writes nothing to the answer channel (`../verb.ts`), so on that path stderr
 * carries the refusal, the scope line, and **only** the UNKNOWN rows: the resolved rows are not an
 * answer here, and printing them beside a refusal invites a caller to read the bytes without
 * reading the status.
 *
 * It reads. It writes nothing.
 */

import {CONFIG_PATH, type ConfigSource} from "../config/document.ts";
import {loadConfig, type Resolved, resolveAll} from "../config/load.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {type AsOf, asOfToken, detail, EMPTY_CELL, row} from "./fields.ts";

const VERB = "status settings";

/** What a row prints where a value would go when there is none to print. */
export const UNKNOWN_VALUE = "UNKNOWN";

/**
 * Where a resolved value came from.
 *
 * Three, not the loader's four: `Malformed` is a declared value the surface refuses whole, so the
 * value this repo runs on is exactly as unestablished as an unreadable file's — both are `unknown`,
 * both carry their reason, and neither ever renders as the default it did not resolve to.
 */
export type Provenance = "declared" | "default" | "unknown";

/**
 * One key's row. A row that carries no value cannot be typed as carrying one: `unknown` has no
 * `value` field at all, so nothing downstream can print a default over a key that did not resolve.
 */
export type SettingRow =
	| {
			readonly key: string;
			readonly provenance: "declared" | "default";
			readonly value: unknown;
			readonly detail: string;
	  }
	| {readonly key: string; readonly provenance: "unknown"; readonly detail: string};

export type SettingsState = "resolved" | "unknown";

const rowOf = ({key, resolution}: Resolved): SettingRow => {
	switch (resolution._tag) {
		case "Declared":
			return {key, provenance: "declared", value: resolution.value, detail: EMPTY_CELL};
		case "Default":
			return {
				key,
				provenance: "default",
				value: resolution.value,
				detail: detail(resolution.reason),
			};
		case "Malformed":
		case "Unknown":
			return {key, provenance: "unknown", detail: detail(resolution.reason)};
	}
};

/** Every registered key, resolved against the config file as its caller found it. */
export const settingRows = (source: ConfigSource): ReadonlyArray<SettingRow> =>
	resolveAll(loadConfig(source)).map(rowOf);

export const settingsState = (rows: ReadonlyArray<SettingRow>): SettingsState =>
	rows.some((one) => one.provenance === "unknown") ? "unknown" : "resolved";

/**
 * A row's value cell. `JSON.stringify` is the renderer rather than a formatter because it escapes
 * every tab and newline a declared string could hold, and the line grammar's cells must be tab-free.
 */
const valueCell = (one: SettingRow): string =>
	one.provenance === "unknown" ? UNKNOWN_VALUE : JSON.stringify(one.value);

/** How the file itself was found, for the scope line — the fact the rows are derived from. */
const sourceNote = (source: ConfigSource): string => {
	switch (source._tag) {
		case "Absent":
			return `no ${CONFIG_PATH} — every key falls to its shipped default`;
		case "Text":
			return `read ${CONFIG_PATH}`;
		case "Unreadable":
			return `could not read ${CONFIG_PATH}: ${source.reason}`;
	}
};

const unknownRefusal = (unknown: ReadonlyArray<SettingRow>): string =>
	`${VERB}: ${unknown.length} key(s) resolve UNKNOWN (${unknown.map((one) => one.key).join(", ")}) — what this repo runs on is unread, never the shipped default.`;

export interface SettingsInput {
	readonly source: ConfigSource;
	readonly rows: ReadonlyArray<SettingRow>;
	/** This invocation's own read of the file — every row is derived from it, so all share it. */
	readonly asOf: AsOf;
	readonly json: boolean;
}

const line = (one: SettingRow, asOf: AsOf): string =>
	row("setting", one.key, one.provenance, valueCell(one), one.detail, asOfToken(asOf));

export const runSettings = ({source, rows, asOf, json}: SettingsInput): VerbOutcome => {
	if (rows.length === 0) {
		return refuse(
			ZERO_SCOPE,
			`${VERB}: the config surface registers zero keys — there is nothing to resolve, and a readout over an empty surface is not an answer (ADR 0092).`,
		);
	}
	const state = settingsState(rows);
	const unknown = rows.filter((one) => one.provenance === "unknown");
	const declared = rows.filter((one) => one.provenance === "declared").length;
	const scope = `${VERB}: ${sourceNote(source)}; ${rows.length} key(s), ${declared} declared, ${unknown.length} unknown.`;

	if (state === "unknown") {
		return refuse(PRECONDITION_UNKNOWN, unknownRefusal(unknown), [
			scope,
			...unknown.map((one) => line(one, asOf)),
		]);
	}

	const body = json
		? JSON.stringify({
				outcome: state,
				path: CONFIG_PATH,
				keys: rows.length,
				declared,
				unknown: unknown.length,
				settings: rows.map((one) => ({
					key: one.key,
					provenance: one.provenance,
					value: one.provenance === "unknown" ? null : one.value,
					detail: one.detail,
					asOf: asOf.at,
					asOfKind: asOf.kind,
				})),
			})
		: [
				row(
					"settings",
					state,
					String(rows.length),
					String(declared),
					String(unknown.length),
					asOfToken(asOf),
				),
				...rows.map((one) => line(one, asOf)),
			].join("\n");

	return answer(`${body}\n`, [scope]);
};
