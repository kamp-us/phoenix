/**
 * Reading the §CP boundary once, for the two verbs that need it.
 *
 * The ref is the PR's **base branch**, not the PR — a PR must not reclassify itself (#981), and not
 * a literal trunk name either: the base ref is that same branch in this repo and the honest
 * generalization in an adopter repo whose trunk is called something else (#5067 clause 4).
 *
 * Three reads of the file are three different answers and none of them fold:
 *
 * - **Proven absent (404)** — the repo has no control plane, so the PR ships (founder ruling on
 *   #5603 comment 8, built as #6299). It used to be an empty row set, which classified as the
 *   `unknown` hold and gated every PR in a repo that never declared a boundary at all.
 * - **Present** — parsed, and `classify` answers over the rows. A file that reads fine but is
 *   trivial is still the printed `unknown` hold (#4336, #4401): a declared-but-useless boundary is
 *   not the same fact as no boundary.
 * - **Unreadable** — the absence of a fact, so the repo says what to do with it through the
 *   `unreadableCodeowners` key, read at the same ref. Its shipped default ships; phoenix declares
 *   `refuse` because here CODEOWNERS *is* the gate (#4216). A config that itself could not be read,
 *   or whose value did not decode, is `Refused` — a policy nobody read cannot waive a gate.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {CONFIG_PATH} from "../config/document.ts";
import {type UnreadableCodeowners, unreadableCodeownersKey} from "../config/keys/control-plane.ts";
import {loadConfig, resolve} from "../config/load.ts";
import {type CpState, classify, type OwnerRow, parseCodeowners} from "./codeowners.ts";
import {readFileAtRef} from "./github.ts";

export const CODEOWNERS_PATH = ".github/CODEOWNERS";

/** A boundary a caller may classify against. Every arm is a fact the read proved. */
export type Boundary =
	/** Proven absent at the base ref: this repo declares no control plane. */
	| {readonly _tag: "Absent"}
	/** Unreadable, and this repo's declared policy ships anyway. The reason still prints. */
	| {readonly _tag: "Waived"; readonly reason: string}
	| {readonly _tag: "Rows"; readonly rows: ReadonlyArray<OwnerRow>};

export type BoundaryRead =
	/** Nothing was proven: the caller's `11`. `what` names which read failed, for its message. */
	| {readonly _tag: "Refused"; readonly what: string; readonly reason: string}
	| {readonly _tag: "Boundary"; readonly boundary: Boundary};

/**
 * The §CP state of one change set against a boundary.
 *
 * The one place the absent-file rule lives, so `ship scope`'s printed `cp` and `ship cp-approval`'s
 * `n/a` cannot come to disagree about a repo with no CODEOWNERS.
 */
export const cpStateOf = (boundary: Boundary, files: ReadonlyArray<string>): CpState =>
	boundary._tag === "Rows" ? classify(boundary.rows, files) : "not-control-plane";

/** The declared policy, or the one reason no policy of this config may be used. */
type PolicyRead =
	| {readonly _tag: "Policy"; readonly value: UnreadableCodeowners}
	| {readonly _tag: "Unusable"; readonly reason: string};

const readPolicy = (
	repo: string,
	ref: string,
): Effect.Effect<PolicyRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* readFileAtRef(repo, CONFIG_PATH, ref);
		if (found._tag === "Unknown") return {_tag: "Unusable" as const, reason: found.reason};
		const resolved = resolve(
			loadConfig(found._tag === "Absent" ? {_tag: "Absent"} : {_tag: "Text", text: found.value}),
			unreadableCodeownersKey,
		);
		return resolved._tag === "Malformed" || resolved._tag === "Unknown"
			? {_tag: "Unusable" as const, reason: resolved.reason}
			: {_tag: "Policy" as const, value: resolved.value};
	});

export const readBoundary = (
	repo: string,
	ref: string,
): Effect.Effect<BoundaryRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* readFileAtRef(repo, CODEOWNERS_PATH, ref);
		if (found._tag === "Absent") return {_tag: "Boundary", boundary: {_tag: "Absent"}};
		if (found._tag === "Present") {
			return {_tag: "Boundary", boundary: {_tag: "Rows", rows: parseCodeowners(found.value)}};
		}

		const unreadable = `${CODEOWNERS_PATH} at ${ref}: ${found.reason}`;
		const policy = yield* readPolicy(repo, ref);
		if (policy._tag === "Unusable") {
			return {
				_tag: "Refused",
				what: `the §CP policy in ${CONFIG_PATH}`,
				reason: `${policy.reason}, and ${unreadable}`,
			};
		}
		return policy.value === "refuse"
			? {_tag: "Refused", what: "the §CP boundary", reason: unreadable}
			: {_tag: "Boundary", boundary: {_tag: "Waived", reason: unreadable}};
	});
