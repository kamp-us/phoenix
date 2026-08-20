/**
 * `status wiring` — is the fabrika plugin actually enabled in this repo?
 *
 * Every other verb in this group answers about something the CLI reads. This one answers about the
 * *other half*: the plugin that carries the skills. A repo can have the CLI installed and answering
 * while no fabrika skill can load in a session there, and until this verb existed nothing said so —
 * demlik ran that way for two days (kamp-us/demlik#26, #6443).
 *
 * **The gating fact is `enabledPlugins`, and the marketplace source is the key's own suffix.** A
 * Claude Code `enabledPlugins` key is `plugin@marketplace`, so one entry names both halves the
 * wiring needs; a bare `fabrika` key names no source and never resolves. `extraKnownMarketplaces`
 * is deliberately not read: ADR 0273's 2026-08-16 amendment records that Claude Code never
 * registers a project-scope `extraKnownMarketplaces` block (verified live on #5705), so a repo
 * carrying one is no more wired than a repo without, and treating it as evidence would green a
 * session that loads nothing.
 *
 * **It detects and writes nothing.** Creating the file is `status bootstrap`'s registry work
 * (epic #5979); a probe that repaired what it measured could never report the state it found.
 */

import {Effect, type FileSystem, type Path, Result} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, readFile} from "../io/fs.ts";
import {isRecord, parseJsonOrReason} from "../io/json.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {type AsOf, asOfToken, detail, EMPTY_CELL, row} from "./fields.ts";

const VERB = "status wiring";

/** Where a repo declares which plugins its sessions load. */
export const SETTINGS_PATH = ".claude/settings.json";

/** The plugin half of the `enabledPlugins` key this verb looks for. */
export const PLUGIN = "fabrika";

/**
 * The settings file as it was found — the same three arms `../config/source.ts` keeps apart, for a
 * different file. An absent file is a fact the repo proves; a read that failed proves nothing.
 */
export type WiringSource =
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * Three states, on the group's three-state law: `wired` is proven on, `unwired` is proven off (an
 * absent file is proven off — nothing enables a plugin there), and a probe that could not be
 * performed is `unknown` and never either of the other two.
 */
export type WiringState = "wired" | "unwired" | "unknown";

/**
 * What the probe established. `entry` and `marketplace` are the two halves of the key that decided
 * it, so a reader can act on the answer without re-opening the file.
 */
export interface WiringRead {
	readonly state: WiringState;
	/** The `enabledPlugins` key naming fabrika, or `null` when no key names it. */
	readonly entry: string | null;
	/** That key's marketplace-source half, or `null` when the key names no source. */
	readonly marketplace: string | null;
	/** Why the state is what it is — always populated, including on `wired`. */
	readonly detail: string;
}

/** The settings file under `root`. Never fails: an unreadable file is an arm, not an error. */
export const readWiringSource = (
	root: string,
): Effect.Effect<WiringSource, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const path = `${root}/${SETTINGS_PATH}`;
		const probe = yield* Effect.result(exists(path));
		if (Result.isFailure(probe)) {
			return {_tag: "Unreadable" as const, reason: `${path}: ${probe.failure.reason}`};
		}
		if (!probe.success) return {_tag: "Absent" as const};
		const text = yield* Effect.result(readFile(path));
		return Result.isFailure(text)
			? {_tag: "Unreadable" as const, reason: `${path}: ${text.failure.reason}`}
			: {_tag: "Text" as const, text: text.success};
	});

/**
 * The settings file at the repo root above `cwd`.
 *
 * A discovery that *failed* is `Unreadable`, never a fall back to `cwd`: falling back would find no
 * file there and answer `Absent`, which is the claim "this repo enables nothing" about a repo
 * nobody located — the same trap `../config/working-root.ts` documents for the config surface.
 */
export const repoWiringSource = (
	cwd: string,
): Effect.Effect<WiringSource, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root = yield* Effect.result(discoverRepoRoot(cwd));
		if (root._tag === "Failure") {
			return {
				_tag: "Unreadable" as const,
				reason: `cannot resolve the repo root above ${cwd}: ${root.failure.reason}`,
			};
		}
		return yield* readWiringSource(root.success ?? cwd);
	});

/** One `enabledPlugins` key, split into the two halves the wiring needs. */
interface PluginEntry {
	readonly key: string;
	readonly marketplace: string | null;
	readonly value: unknown;
}

const entriesNamingFabrika = (enabled: Record<string, unknown>): ReadonlyArray<PluginEntry> =>
	Object.entries(enabled)
		.map(([key, value]) => {
			const at = key.indexOf("@");
			return {
				key,
				marketplace: at === -1 ? null : key.slice(at + 1),
				value,
				name: at === -1 ? key : key.slice(0, at),
			};
		})
		.filter((one) => one.name === PLUGIN);

const off = (entry: string | null, marketplace: string | null, why: string): WiringRead => ({
	state: "unwired",
	entry,
	marketplace,
	detail: detail(why),
});

const unread = (why: string): WiringRead => ({
	state: "unknown",
	entry: null,
	marketplace: null,
	detail: detail(why),
});

/** What the bytes say about whether a session in this repo loads fabrika's skills. */
export const wiringOf = (source: WiringSource): WiringRead => {
	if (source._tag === "Unreadable") {
		return unread(`could not read ${SETTINGS_PATH}: ${source.reason}`);
	}
	if (source._tag === "Absent") {
		return off(null, null, `no ${SETTINGS_PATH} — no fabrika skill can load in a session here`);
	}
	const parsed = parseJsonOrReason(source.text);
	if (parsed._tag === "Failed") {
		return unread(`${SETTINGS_PATH} is not JSON: ${parsed.reason}`);
	}
	if (!isRecord(parsed.value)) {
		return unread(`${SETTINGS_PATH} is not a JSON object, so its plugin block is unread`);
	}
	const enabled = parsed.value.enabledPlugins;
	if (enabled === undefined) {
		return off(null, null, `${SETTINGS_PATH} declares no enabledPlugins block`);
	}
	if (!isRecord(enabled)) {
		return unread(`${SETTINGS_PATH} declares an enabledPlugins that is not an object`);
	}
	const named = entriesNamingFabrika(enabled);
	if (named.length === 0) {
		const others = Object.keys(enabled).length;
		return off(
			null,
			null,
			`enabledPlugins names no ${PLUGIN} entry (${others} other plugin(s)) — the CLI answers, the skills do not exist`,
		);
	}
	const on = named.find((one) => one.value === true);
	if (on === undefined) {
		const first = named[0] as PluginEntry;
		return first.value === false
			? off(first.key, first.marketplace, `enabledPlugins carries ${first.key} switched off`)
			: unread(
					`enabledPlugins carries ${first.key} set to ${JSON.stringify(first.value)} — neither true nor false, so whether the plugin loads is unread`,
				);
	}
	// A key with no `@` half names no marketplace, and Claude Code resolves an `enabledPlugins` key
	// as `plugin@marketplace` — so it enables nothing however it is spelled.
	if (on.marketplace === null || on.marketplace === "") {
		return off(
			on.key,
			null,
			`enabledPlugins carries a bare ${on.key} naming no marketplace source — a key resolves as ${PLUGIN}@<marketplace>`,
		);
	}
	return {
		state: "wired",
		entry: on.key,
		marketplace: on.marketplace,
		detail: detail(`${on.key} is enabled — sessions in this repo load fabrika's skills`),
	};
};

/** How the file itself was found, for the scope line the answer is derived from. */
const sourceNote = (source: WiringSource): string => {
	switch (source._tag) {
		case "Absent":
			return `no ${SETTINGS_PATH}`;
		case "Text":
			return `read ${SETTINGS_PATH}`;
		case "Unreadable":
			return `could not read ${SETTINGS_PATH}: ${source.reason}`;
	}
};

export interface WiringInput {
	readonly source: WiringSource;
	readonly read: WiringRead;
	/** This invocation's own read of the file — the one fact the answer's freshness comes from. */
	readonly asOf: AsOf;
	readonly json: boolean;
}

/**
 * **`unwired` is an answer at exit `0`, `unknown` is a refusal.** A proven-off plugin is a fact the
 * caller acts on — the same seat `status board`'s proven `0` and `status readout`'s `absent` take —
 * while a probe that could not be performed has no answer to seat, so it refuses on the group's
 * UNKNOWN code rather than printing a state it did not establish.
 */
export const runWiring = ({source, read, asOf, json}: WiringInput): VerbOutcome => {
	const scope = `${VERB}: ${sourceNote(source)}; plugin ${PLUGIN} is ${read.state}.`;
	if (read.state === "unknown") {
		return refuse(
			PRECONDITION_UNKNOWN,
			`${VERB}: ${read.detail} — whether a session here loads fabrika's skills is UNKNOWN, never unwired and never green.`,
			[scope],
		);
	}
	const body = json
		? JSON.stringify({
				outcome: read.state,
				path: SETTINGS_PATH,
				entry: read.entry,
				marketplace: read.marketplace,
				detail: read.detail,
				asOf: asOf.at,
				asOfKind: asOf.kind,
			})
		: row(
				"wiring",
				read.state,
				read.entry ?? EMPTY_CELL,
				read.marketplace ?? EMPTY_CELL,
				read.detail,
				asOfToken(asOf),
			);
	return answer(`${body}\n`, [scope]);
};
