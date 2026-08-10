/**
 * Which exit tables in this package must agree, what "agree" means, and the derivation that decides
 * it — read from the shipped modules' own exports, never from a copied list of numbers.
 *
 * `report/codes.ts` is the **base**: the table the writing verbs shipped first, so every other group
 * seats itself against it rather than the other way round. An aligning group owes the base two
 * things, and they are different obligations that need different machinery:
 *
 *   - **The shared seats carry the same number.** Handled by identity, not by assertion: an aligning
 *     group *imports* the base's constant (`review/codes.ts` already does; `triage/codes.ts` now does
 *     too), so a drift is unrepresentable rather than merely detectable. {@link SHARED_SEATS} records
 *     which meanings are claimed shared, so swapping an import back to a numeral reds instead of
 *     drifting quietly.
 *   - **The codes the group adds on its own account clear the base's whole table.** This one cannot
 *     be an import — the group's private codes are its own — so it is a check, and the check derives
 *     the base's occupied seats from `report`'s exports. That is the direction that bit: `triage`'s
 *     `HUMAN_FILED` had to be re-seated `12` because `11` was already `PRECONDITION_UNKNOWN`
 *     upstream, and it was a human reading both files side by side who caught it (#4924).
 *
 * Not every group aligns. `wire` allocates `3`-`6` for entirely different facts and is right to —
 * see {@link UNALIGNED_GROUPS}, which lists it rather than omitting it, because an omission is
 * indistinguishable from a group nobody registered.
 *
 * **What the guard scans is the shipped verb registry, not the tables on disk (#5213).** Scoping
 * the coverage check to directories that hold a `codes.ts` made the group with the loosest exit
 * discipline the one it could not see: `eval` shipped no table, so it was absent from the scan and
 * absent from both registries, and the check stayed green over it. A group is now checked because
 * `registry.ts` ships it, so the only way to leave one unchecked is to not ship it at all —
 * {@link coverageGaps} takes the registered names and reds on any it cannot classify.
 */

import {existsSync, readdirSync, readFileSync, realpathSync} from "node:fs";
import {join} from "node:path";

/** The group whose table every aligning group seats itself against. */
export const ALIGNMENT_BASE = "report";

/**
 * The seats an aligning group shares with the base, as `<group export> → <base export>`.
 *
 * The names differ where the group's reading is a documented superset (`triage`'s `ZERO_SCOPE` over
 * `report`'s `NO_TARGET`), which is why this is a map of names and not a set of numbers: the claim
 * is that these two meanings sit on one code, and a number cannot say that.
 */
export type SharedSeats = Readonly<Record<string, string>>;

/**
 * The seats `triage` and `review` share with `report`. Both groups claim the same eight, so the map
 * is written once.
 */
export const SHARED_SEATS: SharedSeats = {
	EMPTY_STDIN: "EMPTY_STDIN",
	LEAKED_PATH: "LEAKED_PATH",
	BARE_AT_PATH: "BARE_AT_PATH",
	ZERO_SCOPE: "NO_TARGET",
	WRITE_UNKNOWN: "WRITE_UNKNOWN",
	READBACK_MISMATCH: "READBACK_MISMATCH",
	OFF_VOCABULARY: "CLASSIFIED",
	PRECONDITION_UNKNOWN: "PRECONDITION_UNKNOWN",
};

/**
 * `build`'s seats: the same eight, plus `report file`'s body-section seat.
 *
 * `review` and `triage` leave `4` a deliberate gap because neither performs a section check;
 * `build pr` does — a body with no `## Deviations` block is that same fact — so the seat is claimed
 * rather than re-invented one code higher. `epic` claims the identical nine: `epic open` reads the
 * same fact off an epic body with no parseable planned ledger. `plan` claims them too: `plan read`
 * seats `4` for a ledger section declared twice, so under `SHARED_SEATS` the checker would report
 * `4` as a private code colliding with the base.
 */
export const BUILD_SEATS: SharedSeats = {...SHARED_SEATS, BAD_SECTIONS: "BAD_SECTIONS"};

/**
 * `review-ui`'s seats: the same eight, plus `4` under its own name.
 *
 * The name differs because the meaning is the base's read widened, not renamed: `report file`'s `4`
 * is a body section that is missing or out of order, and `review-ui` seats the same fact about a
 * whole derived document — a capture set's `manifest.json`, or `design-harness.json` at the
 * tier-choice read. Naming the pair is the claim a bare number cannot make.
 */
export const REVIEW_UI_SEATS: SharedSeats = {...SHARED_SEATS, MALFORMED_DOCUMENT: "BAD_SECTIONS"};

/**
 * `ui`'s seats: `build`'s nine minus the stdin seat.
 *
 * No `ui` verb reads stdin, and rather than seat a second meaning on `3` the group holds it empty as
 * `DELIBERATE_GAP` — so the shared-seat map cannot claim it, and the private-code check reads `3` as
 * occupied by the base alone.
 */
export const UI_SEATS: SharedSeats = (() => {
	const {EMPTY_STDIN: _stdin, ...rest} = BUILD_SEATS;
	return rest;
})();

/**
 * `hook`'s seats: one. It shares only `EMPTY_STDIN` — the same fact, an fd 0 read that held nothing
 * — and everything else it speaks is about a harness envelope rather than about a write, so its two
 * private codes sit above the base's whole table instead of claiming a seat in it.
 */
export const HOOK_SEATS: SharedSeats = {EMPTY_STDIN: "EMPTY_STDIN"};

/**
 * `eval`'s seats: two. Its verbs neither read stdin nor write anything, so most of the base's table
 * is about facts they cannot establish; what they do establish is that a named JSON artifact is
 * malformed, and that a decoded eval set carries nothing to run.
 */
export const EVAL_SEATS: SharedSeats = {
	MALFORMED_DOCUMENT: "BAD_SECTIONS",
	ZERO_SCOPE: "NO_TARGET",
};

/**
 * `adr`'s seats: two. Its verbs read decision records off disk rather than writing to GitHub, so
 * most of the base's table is about facts they cannot establish. What they do establish is that the
 * record a caller named is not there, and that the read which would have proven it failed.
 */
export const ADR_SEATS: SharedSeats = {
	NO_SUBJECT: "NO_TARGET",
	DIR_UNREADABLE: "PRECONDITION_UNKNOWN",
};

/**
 * `spend`'s seats: the same two as `adr`, on the same reading — the measured input is not there, and
 * the read that would have proven it failed. The names are the group's own because the target is an
 * input it measures rather than one it writes.
 */
export const SPEND_SEATS: SharedSeats = {
	INPUT_ABSENT: "NO_TARGET",
	INPUT_UNREADABLE: "PRECONDITION_UNKNOWN",
};

/**
 * `map`'s seats: `build`'s nine minus the classification seat, under the base's own names.
 *
 * None of the shipped maps fits, which is why this one is written rather than reused: the eight-seat
 * maps key on `ZERO_SCOPE` and `OFF_VOCABULARY`, `HOOK_SEATS` shares only the stdin seat, and `map`
 * names `7` `NO_TARGET` and holds `10` as `DELIBERATE_GAP` — no `map` verb accepts a label flag or
 * writes a classification, so the base's `10` is unreachable here and cannot be claimed at all.
 */
export const MAP_SEATS: SharedSeats = (() => {
	const {OFF_VOCABULARY: _classified, ZERO_SCOPE: _zero, ...rest} = BUILD_SEATS;
	return {...rest, NO_TARGET: "NO_TARGET"};
})();

/** The groups that align to {@link ALIGNMENT_BASE}, each with the seats it claims to share. */
export const ALIGNED_GROUPS: Readonly<Record<string, SharedSeats>> = {
	adr: ADR_SEATS,
	build: BUILD_SEATS,
	eval: EVAL_SEATS,
	hook: HOOK_SEATS,
	epic: BUILD_SEATS,
	ledger: BUILD_SEATS,
	map: MAP_SEATS,
	plan: BUILD_SEATS,
	triage: SHARED_SEATS,
	review: SHARED_SEATS,
	"review-ui": REVIEW_UI_SEATS,
	ship: SHARED_SEATS,
	spend: SPEND_SEATS,
	status: SHARED_SEATS,
	ui: UI_SEATS,
};

/**
 * The groups that deliberately do **not** align, and the reason each is exempt. A group listed here
 * is a decision; a group listed nowhere is drift, which is what {@link coverageGaps} exists to
 * surface.
 */
export const UNALIGNED_GROUPS: Readonly<Record<string, string>> = {
	wire: "3-6 are ABSENT / MALFORMED / EMPTY_ARTIFACT / ARTIFACT_UNKNOWN — a different vocabulary about artifacts, not about writes",
};

/**
 * The registered groups that ship no `<group>/codes.ts` at all, and the tracked reason each is
 * still unchecked.
 *
 * **Empty is the goal state, and it is where this stands: `adr` and `spend` were its only two
 * entries and both now ship a table (#5294).** The registry stays because it is what lets
 * {@link coverageGaps} treat an untabled group as the failure it is instead of the silence that hid
 * `eval` — a future group that ships before its table is recorded here with the issue tracking it,
 * never left out. An entry is an admission, never an exemption: nothing here is a decision that a
 * group table is unwarranted.
 */
export const UNTABLED_GROUPS: Readonly<Record<string, string>> = {};

/** Every group this module has an answer for, whichever of the three registries holds it. */
export const classifiedGroups = (): ReadonlySet<string> =>
	new Set([
		ALIGNMENT_BASE,
		...Object.keys(ALIGNED_GROUPS),
		...Object.keys(UNALIGNED_GROUPS),
		...Object.keys(UNTABLED_GROUPS),
	]);

/** What a scan of the shipped registry against this module's registries turned up. */
export interface CoverageGaps {
	/**
	 * Groups classified nowhere here — shipped by the registry, carrying a table on disk, or both.
	 * Non-empty means the guard is blind to one, which is the defect it exists to red on.
	 */
	readonly unclassified: readonly string[];
	/** Groups classified here that the registry no longer ships — a stale registration. */
	readonly unshipped: readonly string[];
	/** Groups recorded as untabled that do ship a `codes.ts` — the record is out of date. */
	readonly untabledWithTable: readonly string[];
	/** Groups classified as base/aligned/unaligned that ship no `codes.ts` to check. */
	readonly tableMissing: readonly string[];
}

/** A scan that had nothing to scan, so its all-clear would mean nothing (ADR 0092). */
export class ZeroCoverageScope extends Error {}

/**
 * Every gap between what `registry.ts` ships and what this module classifies. Empty arrays are the
 * covered state.
 *
 * Takes the registered names rather than importing the registry so this module stays loadable
 * without constructing the whole CLI; the caller passes `registeredGroups.map((g) => g.name)`.
 *
 * Throws on an empty scan on either side. An all-clear derived from nothing is the vacuous pass ADR
 * 0092 forbids, and it is the shape that would return here first: a registry that failed to load
 * would report zero groups and therefore zero gaps.
 */
export const coverageGaps = (input: {
	readonly registered: readonly string[];
	readonly onDisk: readonly string[];
}): CoverageGaps => {
	if (input.registered.length === 0) {
		throw new ZeroCoverageScope("no verb groups were registered — nothing to check (ADR 0092)");
	}
	if (input.onDisk.length === 0) {
		throw new ZeroCoverageScope("no `<group>/codes.ts` was found on disk (ADR 0092)");
	}

	const registered = new Set(input.registered);
	const onDisk = new Set(input.onDisk);
	const classified = classifiedGroups();
	const untabled = new Set(Object.keys(UNTABLED_GROUPS));

	return {
		unclassified: [...new Set([...input.registered, ...input.onDisk])]
			.filter((name) => !classified.has(name))
			.sort(),
		unshipped: [...classified].filter((name) => !registered.has(name)).sort(),
		untabledWithTable: [...untabled].filter((name) => onDisk.has(name)).sort(),
		tableMissing: [...classified].filter((name) => !untabled.has(name) && !onDisk.has(name)).sort(),
	};
};

/**
 * The export every aligned table uses for the code it deliberately leaves empty. Excluded from a
 * table's allocations: reading a gap as an allocation reports a collision on a seat nobody sits in.
 */
export const GAP_EXPORT = "DELIBERATE_GAP";

/** A code table as its module namespace — every numeric export is a code the group speaks. */
export type CodeTable = object;

/** `code → the exports that name it`, so a table that seats two meanings on one code shows up too. */
export const allocatedCodes = (table: CodeTable): ReadonlyMap<number, readonly string[]> => {
	const byCode = new Map<number, string[]>();
	for (const [name, value] of Object.entries(table)) {
		if (name === GAP_EXPORT || typeof value !== "number") continue;
		const names = byCode.get(value);
		if (names === undefined) byCode.set(value, [name]);
		else names.push(name);
	}
	return byCode;
};

/** The codes a group allocates on its own account: everything outside the seats it shares. */
export const privateCodes = (
	table: CodeTable,
	seats: SharedSeats,
): ReadonlyMap<number, readonly string[]> => {
	const shared = new Set(Object.keys(seats));
	const own = new Map<number, readonly string[]>();
	for (const [code, names] of allocatedCodes(table)) {
		const ownNames = names.filter((name) => !shared.has(name));
		if (ownNames.length > 0) own.set(code, ownNames);
	}
	return own;
};

/** A shared seat whose two constants no longer sit on one code. */
export interface SeatDrift {
	readonly groupExport: string;
	readonly baseExport: string;
	readonly groupCode: unknown;
	readonly baseCode: unknown;
}

/** A code a group added on its own account that the base already spoke for. */
export interface Collision {
	readonly code: number;
	readonly groupExports: readonly string[];
	readonly baseExports: readonly string[];
}

/** Both obligations, evaluated over the live modules. Empty arrays are the aligned state. */
export interface AlignmentReport {
	readonly drifted: readonly SeatDrift[];
	readonly collisions: readonly Collision[];
}

export const checkAlignment = (
	base: CodeTable,
	group: CodeTable,
	seats: SharedSeats,
): AlignmentReport => {
	const baseValues = base as Readonly<Record<string, unknown>>;
	const groupValues = group as Readonly<Record<string, unknown>>;

	const drifted: SeatDrift[] = [];
	for (const [groupExport, baseExport] of Object.entries(seats)) {
		const groupCode = groupValues[groupExport];
		const baseCode = baseValues[baseExport];
		if (groupCode !== baseCode || typeof groupCode !== "number") {
			drifted.push({groupExport, baseExport, groupCode, baseCode});
		}
	}

	const occupied = allocatedCodes(base);
	const collisions: Collision[] = [];
	for (const [code, groupExports] of privateCodes(group, seats)) {
		const baseExports = occupied.get(code);
		if (baseExports !== undefined) collisions.push({code, groupExports, baseExports});
	}

	return {drifted, collisions};
};

/**
 * The `<group>/codes.ts` tables that actually exist on disk — one of {@link coverageGaps}'s two
 * inputs, and on its own never the scan's scope: a group with no table is exactly what this read
 * cannot see (#5213). Paths resolve physically — a `..` folded across the repo's `.claude/skills`
 * symlink resolves somewhere else entirely.
 */
export const codeTableGroupsIn = (srcDir: string): readonly string[] => {
	const root = realpathSync(srcDir);
	return readdirSync(root, {withFileTypes: true})
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => existsSync(join(root, name, "codes.ts")))
		.sort();
};

/**
 * The exit-code constants a group's verb modules declare **themselves**, as `<file>: <NAME>`.
 *
 * A group with a table owes an empty answer here. Reading the module namespaces cannot establish
 * that — an import and a declaration are the same export once the module is loaded — so this reads
 * the source, which is the only place the difference survives. That difference is the whole defect:
 * `adr` shipped a `NO_SUBJECT` in two verb files on two numbers (#5294).
 *
 * The read is `*-verb.ts` only and shape-based, so a code seated in a non-verb module of the same
 * group is outside what it can see. The whole result is sorted, not each file's share of it —
 * `readdirSync` order is not guaranteed, so a per-file sort would leave the list unordered.
 */
export const verbLocalCodesIn = (groupDir: string): readonly string[] => {
	const root = realpathSync(groupDir);
	return readdirSync(root)
		.filter((name) => name.endsWith("-verb.ts"))
		.flatMap((name) =>
			[
				...readFileSync(join(root, name), "utf8").matchAll(
					/^export const ([A-Z][A-Z0-9_]*) = \d/gm,
				),
			].map((match) => `${name}: ${match[1]}`),
		)
		.sort();
};
