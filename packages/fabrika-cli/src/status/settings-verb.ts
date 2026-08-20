/**
 * `status settings` — every key on the config surface, its resolved value, and where that value
 * came from. The one place a skill asks what `.fabrika.jsonc` resolves to, so no skill document has
 * to restate a value (R9.1, #6293).
 *
 * **Provenance is the load-bearing column.** "the governance roots are the five shipped defaults"
 * and "the governance roots are five values this repo declared" are different facts, and an agent
 * reading a bare value cannot tell whether the repo made a choice. So each row says which.
 *
 * A key whose value could not be established prints UNKNOWN and the verb exits non-zero — never a
 * green readout over defaults, which is the collapse the whole config surface exists to prevent.
 * A non-zero exit writes nothing to the answer channel (`../verb.ts`), so on that path stderr
 * carries the refusal, the scope line, and **only** the UNKNOWN rows: the resolved rows are not an
 * answer here, and printing them beside a refusal invites a caller to read the bytes without
 * reading the status.
 *
 * **`--surfaces` expands one key rather than adding a readout.** `surfaceDispositions` resolves to
 * an id-to-word map, and a map is not what the front door relays to a human — it relays what each
 * surface *is* alongside what happens here when it is missing, and that half only exists as the
 * registry's notes. The expansion joins the two and appends `surface` rows to the same answer, so
 * the config surface still has one resolver and one path (#6301).
 *
 * It reads. It writes nothing.
 */

import {CONFIG_PATH, type ConfigSource} from "../config/document.ts";
import {
	SURFACE_DISPOSITIONS,
	type SurfaceDispositions,
	surfaceNotes,
} from "../config/keys/surface-dispositions.ts";
import {loadConfig, type Resolved, resolveAll} from "../config/load.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {type AsOf, asOfToken, detail, EMPTY_CELL, row, surfaceNote} from "./fields.ts";

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
	/**
	 * Expand `surfaceDispositions` into one row per surface instead of printing its value as a blob.
	 *
	 * The blob answers "what happens here" for a caller that already knows the ids. A human at the
	 * front door does not, and the id-to-word pairs alone tell them nothing about what the surface
	 * *is* — that half lives in the registry's notes and reached no output at all (#6301).
	 */
	readonly surfaces: boolean;
}

/**
 * The `surfaceDispositions` row's value, or `null` when it did not resolve.
 *
 * A surface readout over shipped defaults the repo may have overridden would be the exact collapse
 * the whole verb refuses, so an unresolved key has no surface rows — it has the same refusal.
 */
const resolvedDispositions = (rows: ReadonlyArray<SettingRow>): SurfaceDispositions | null => {
	const one = rows.find((each) => each.key === SURFACE_DISPOSITIONS);
	return one === undefined || one.provenance === "unknown"
		? null
		: (one.value as SurfaceDispositions);
};

const surfaceLine = (surface: {id: string; disposition: string; note: string}): string =>
	row("surface", surface.id, surface.disposition, surfaceNote(surface.note));

const line = (one: SettingRow, asOf: AsOf): string =>
	row("setting", one.key, one.provenance, valueCell(one), one.detail, asOfToken(asOf));

export const runSettings = ({source, rows, asOf, json, surfaces}: SettingsInput): VerbOutcome => {
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

	const dispositions = surfaces ? resolvedDispositions(rows) : null;
	if (surfaces && dispositions === null) {
		return refuse(
			ZERO_SCOPE,
			`${VERB}: the config surface registers no \`${SURFACE_DISPOSITIONS}\` key, so there are no surfaces to expand (ADR 0092).`,
			[scope],
		);
	}
	const expanded = dispositions === null ? [] : surfaceNotes(dispositions);

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
				...(surfaces ? {surfaces: expanded} : {}),
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
				...expanded.map(surfaceLine),
			].join("\n");

	return answer(`${body}\n`, [scope]);
};
