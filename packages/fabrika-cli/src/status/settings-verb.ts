/**
 * `status settings` — every key on the config surface, its resolved value, and where that value
 * came from. The one place a skill asks what the config resolves to, so no skill document has to
 * restate a value.
 *
 * Both layers are read: the tracked `.fabrika.jsonc` and, over it, the gitignored
 * `.fabrika.local.jsonc` a machine may declare an allow-listed key in.
 *
 * **Provenance is the load-bearing column.** "the governance roots are the four shipped defaults"
 * and "the governance roots are four values this repo declared" are different facts, and an agent
 * reading a bare value cannot tell whether the repo made a choice. So each row says which — and a
 * declared row's detail cell names which of the two files declared it, because a machine-local
 * value is invisible in `git status` and would otherwise be a number an operator debugs blind.
 *
 * See `status settings --help` for results and exit codes. On refusal, omit resolved rows so they
 * cannot be mistaken for a complete answer.
 *
 * It reads. It writes nothing.
 */

import {CONFIG_PATH, type ConfigLayer, layerPath} from "../config/document.ts";
import {type ConfigLayers, loadLayeredConfig, type Resolved, resolveAll} from "../config/load.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {type AsOf, asOfToken, detail, row} from "./fields.ts";

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
			readonly provenance: "declared";
			/** Which file the value was declared in — the detail cell prints it. */
			readonly layer: ConfigLayer;
			readonly value: unknown;
			readonly detail: string;
	  }
	| {
			readonly key: string;
			readonly provenance: "default";
			readonly value: unknown;
			readonly detail: string;
	  }
	| {readonly key: string; readonly provenance: "unknown"; readonly detail: string};

export type SettingsState = "resolved" | "unknown";

const rowOf = ({key, resolution}: Resolved): SettingRow => {
	switch (resolution._tag) {
		case "Declared":
			return {
				key,
				provenance: "declared",
				layer: resolution.layer,
				value: resolution.value,
				detail: detail(`declared in ${layerPath(resolution.layer)}`),
			};
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

/** Every registered key, resolved against both config layers as their caller found them. */
export const settingRows = (layers: ConfigLayers): ReadonlyArray<SettingRow> =>
	resolveAll(loadLayeredConfig(layers)).map(rowOf);

export const settingsState = (rows: ReadonlyArray<SettingRow>): SettingsState =>
	rows.some((one) => one.provenance === "unknown") ? "unknown" : "resolved";

/**
 * A row's value cell. `JSON.stringify` is the renderer rather than a formatter because it escapes
 * every tab and newline a declared string could hold, and the line grammar's cells must be tab-free.
 */
const valueCell = (one: SettingRow): string =>
	one.provenance === "unknown" ? UNKNOWN_VALUE : JSON.stringify(one.value);

/** How one file was found, for the scope line — the fact the rows are derived from. */
const layerNote = (source: ConfigLayers[keyof ConfigLayers], path: string): string => {
	switch (source._tag) {
		case "Absent":
			return `no ${path}`;
		case "Text":
			return `read ${path}`;
		case "Unreadable":
			return `could not read ${path}: ${source.reason}`;
	}
};

/** How both files were found. Both are named every run, because a value can come from either. */
const sourceNote = (layers: ConfigLayers): string => {
	const tracked = layerNote(layers.tracked, CONFIG_PATH);
	const local = layerNote(layers.local, layerPath("local"));
	return layers.tracked._tag === "Absent" && layers.local._tag === "Absent"
		? `${tracked} and ${local} — every key falls to its shipped default`
		: `${local}, ${tracked}`;
};

const unknownRefusal = (unknown: ReadonlyArray<SettingRow>): string =>
	`${VERB}: ${unknown.length} key(s) resolve UNKNOWN (${unknown.map((one) => one.key).join(", ")}) — what this repo runs on is unread, never the shipped default.`;

export interface SettingsInput {
	readonly layers: ConfigLayers;
	readonly rows: ReadonlyArray<SettingRow>;
	/** This invocation's own read of the file — every row is derived from it, so all share it. */
	readonly asOf: AsOf;
	readonly json: boolean;
}

const line = (one: SettingRow, asOf: AsOf): string =>
	row("setting", one.key, one.provenance, valueCell(one), one.detail, asOfToken(asOf));

export const runSettings = ({layers, rows, asOf, json}: SettingsInput): VerbOutcome => {
	if (rows.length === 0) {
		return refuse(
			ZERO_SCOPE,
			`${VERB}: the config surface registers zero keys — there is nothing to resolve, and a readout over an empty surface is not an answer.`,
		);
	}
	const state = settingsState(rows);
	const unknown = rows.filter((one) => one.provenance === "unknown");
	const declared = rows.filter((one) => one.provenance === "declared").length;
	const scope = `${VERB}: ${sourceNote(layers)}; ${rows.length} key(s), ${declared} declared, ${unknown.length} unknown.`;

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
				localPath: layerPath("local"),
				keys: rows.length,
				declared,
				unknown: unknown.length,
				settings: rows.map((one) => ({
					key: one.key,
					provenance: one.provenance,
					layer: one.provenance === "declared" ? one.layer : null,
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
