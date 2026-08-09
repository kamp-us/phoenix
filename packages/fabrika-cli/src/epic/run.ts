/**
 * Opening the run's ground: the preconditions every `epic` verb shares, and the two files a run is.
 *
 * The preconditions are **`build`'s, guarded identically** — the imported lane guard's linked
 * worktree (`12`), lane branch (`14`) and held claim (`15`/`11`), run against the **epic's** number.
 * Two verbs are exempt by contract and say so at their call site: `epic slice-diff` runs the tree
 * assertion only (an evaluator holds no claim; it reads), and `epic open` runs tree + claim only,
 * because it precedes `build branch` in the loop and the lane branch may not exist yet.
 *
 * A run is two files in one nonce-keyed directory: the append-only `ledger.jsonl`, and `plan.json` —
 * the slice list and order resolved once at `epic open`. The plan is a **file, not a ledger event**,
 * for the reason `epic next` and `epic status` state in their own blocks: both read no GitHub, and a
 * fold that must name slices cannot re-derive them from the epic body without doing so. The ledger
 * still stores no *derived* state; the plan is the run's input, captured where the fold can reach it.
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {requireClaim, requireSession} from "../build/claim.ts";
import {nonceOf} from "../build/lane.ts";
import {requireLane} from "../build/lane-guard.ts";
import {resolveTargetRepo} from "../build/target.ts";
import {assertGround} from "../build/worktree.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {NO_RUN, PRECONDITION_UNKNOWN, UNNAMEABLE_STATE} from "./codes.ts";
import {type LedgerLine, ledgerPathIn, parseLedger, runDir, runKey} from "./ledger.ts";

/** The ground a state-touching verb stands on: this tree, this lane, this claim's nonce. */
export interface Ground {
	readonly root: string;
	readonly branch: string | null;
	readonly repo: string;
	readonly session: string;
	readonly nonce: string;
	readonly key: string;
	readonly dir: string;
	readonly notes: ReadonlyArray<string>;
}

export type GroundResult =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| ({readonly _tag: "Ground"} & Ground);

const withNonce = (
	verb: string,
	token: string,
	epic: number,
	rest: Omit<Ground, "nonce" | "key" | "dir">,
): GroundResult => {
	const nonce = nonceOf(token);
	if (nonce === null) {
		return {
			_tag: "Refused",
			outcome: refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: the claim on #${epic} carries the token ${token}, which yields no lane nonce — the run key is UNKNOWN.`,
				rest.notes,
			),
		};
	}
	const key = runKey(epic, nonce);
	return {_tag: "Ground", ...rest, nonce, key, dir: runDir(rest.root, key)};
};

/** The full lane guard: `12` / `14` / `15` / `11`, on the epic's claim. */
export const laneGround = (
	verb: string,
	epic: number,
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<GroundResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const session = requireSession(verb, env);
		if (session._tag === "Refused") return session;
		const resolved = yield* resolveTargetRepo(verb, repo, env);
		if (resolved._tag === "Refused") return resolved;
		const lane = yield* requireLane(verb, resolved.repo, session.id, epic);
		if (lane._tag === "Refused") return lane;
		return withNonce(verb, lane.marker.token, epic, {
			root: lane.root,
			branch: lane.branch,
			repo: resolved.repo,
			session: session.id,
			notes: lane.notes,
		});
	});

/** Tree + claim, never the lane branch — `epic open`'s stated exemption. */
export const claimGround = (
	verb: string,
	epic: number,
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<GroundResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const tree = yield* assertGround(verb, false);
		if (tree._tag === "Refused") return tree;
		const session = requireSession(verb, env);
		if (session._tag === "Refused") return session;
		const resolved = yield* resolveTargetRepo(verb, repo, env);
		if (resolved._tag === "Refused") return resolved;
		const held = yield* requireClaim(verb, resolved.repo, epic, session.id);
		if (held._tag === "Refused") return held;
		return withNonce(verb, held.marker.token, epic, {
			root: tree.root,
			branch: null,
			repo: resolved.repo,
			session: session.id,
			notes: held.notes,
		});
	});

/** One slice as `epic open` resolved it — the plan file's row. */
export interface RunSlice {
	readonly id: string;
	readonly issue: number;
	readonly title: string;
	/** The imported wire read's three-armed answer, carried as a token and never flattened. */
	readonly criteria: "found" | "absent" | "malformed";
}

export interface RunPlan {
	readonly epic: number;
	readonly run: string;
	readonly slices: ReadonlyArray<RunSlice>;
	readonly order: ReadonlyArray<string>;
}

export interface Run {
	readonly plan: RunPlan;
	readonly lines: ReadonlyArray<LedgerLine>;
}

export type RunResult =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| ({readonly _tag: "Run"} & Run);

export const planPathIn = (dir: string): string => `${dir}/plan.json`;

export const renderPlan = (plan: RunPlan): string => `${JSON.stringify(plan, null, 2)}\n`;

const CRITERIA = ["found", "absent", "malformed"] as const;

/** Parse `plan.json`. An off-shape plan is unnameable run state, exactly as an off-enum event is. */
export const parsePlan = (text: string): RunPlan | null => {
	const value = parseJson(text);
	if (!isRecord(value)) return null;
	const {epic, run, slices, order} = value;
	if (typeof epic !== "number" || typeof run !== "string" || !Array.isArray(slices)) return null;
	if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) return null;
	const rows: RunSlice[] = [];
	for (const row of slices) {
		if (!isRecord(row)) return null;
		const {id, issue, title, criteria} = row;
		if (typeof id !== "string" || typeof issue !== "number" || typeof title !== "string") {
			return null;
		}
		if (typeof criteria !== "string" || !(CRITERIA as ReadonlyArray<string>).includes(criteria)) {
			return null;
		}
		rows.push({id, issue, title, criteria: criteria as RunSlice["criteria"]});
	}
	return {epic, run, slices: rows, order: order as ReadonlyArray<string>};
};

type FileRead =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * Read one file three ways.
 *
 * Absent and unreadable take opposite branches — a provably absent ledger is `20` and its repair is
 * `epic open`, while a file that could not be read says nothing about whether a run exists (`11`).
 * No message here is worded "does not exist, or is not readable".
 */
export const readFileThreeWays = (
	path: string,
): Effect.Effect<FileRead, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const present = yield* fs
			.exists(path)
			.pipe(
				Effect.catchTag("PlatformError", (cause) =>
					Effect.succeed({_tag: "Unreadable" as const, reason: cause.message}),
				),
			);
		if (typeof present !== "boolean") return present;
		if (!present) return {_tag: "Absent" as const};
		return yield* fs.readFileString(path).pipe(
			Effect.map((text) => ({_tag: "Text" as const, text})),
			Effect.catchTag("PlatformError", (cause) =>
				Effect.succeed({_tag: "Unreadable" as const, reason: cause.message}),
			),
		);
	});

/** Load the run at `ground.dir`, with each failure seated on the code its own fact carries. */
export const loadRun = (
	verb: string,
	epic: number,
	ground: Ground,
): Effect.Effect<RunResult, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const ledgerRead = yield* readFileThreeWays(ledgerPathIn(ground.dir));
		if (ledgerRead._tag === "Absent") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					NO_RUN,
					`${verb}: no run ledger for #${epic} in this lane — run "fabrika epic open ${epic}" first.`,
					ground.notes,
				),
			};
		}
		if (ledgerRead._tag === "Unreadable") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read the run ledger: ${ledgerRead.reason} — the run state is UNKNOWN.`,
					ground.notes,
				),
			};
		}
		const parsed = parseLedger(ledgerRead.text);
		if (parsed._tag === "Unnameable") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					UNNAMEABLE_STATE,
					`${verb}: the ledger at ${ground.key} holds unnameable state (${parsed.detail}) — the run needs a human, never a guess.`,
					ground.notes,
				),
			};
		}

		const planRead = yield* readFileThreeWays(planPathIn(ground.dir));
		if (planRead._tag === "Unreadable") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read the run plan: ${planRead.reason} — the run state is UNKNOWN.`,
					ground.notes,
				),
			};
		}
		const plan = planRead._tag === "Text" ? parsePlan(planRead.text) : null;
		if (plan === null) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					UNNAMEABLE_STATE,
					`${verb}: the run at ${ground.key} has a ledger and ${
						planRead._tag === "Absent" ? "no slice plan" : "an unreadable slice plan"
					} — the run needs a human, never a guess.`,
					ground.notes,
				),
			};
		}
		return {_tag: "Run" as const, plan, lines: parsed.lines};
	});
