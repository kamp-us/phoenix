/**
 * The read all four verbs share: the epic precondition, the ledger fetch, and the floor's one probe.
 *
 * `plan check`, `plan flip` and `plan verdict` each re-run this fetch rather than taking a ledger on
 * stdin or trusting an earlier verb's output — a floor that graded a caller-supplied document would
 * grade a document the caller could edit.
 *
 * Every refusal is worded by the calling verb, because the same fact reads differently at each seam:
 * an unreadable child is "the ledger is UNKNOWN" to `plan read` and "nothing was written" to
 * `plan flip`. The codes are identical; only the sentence moves.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type PhaseLine, type RequiresLine, readTopology, renderRef} from "../build/dependencies.ts";
import {openIssue} from "../build/target.ts";
import {getIssue, type IssueRecord} from "../io/issues.ts";
import {EPIC_TYPE_LABEL} from "../triage/facets.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {read as readAcceptanceCriteria} from "../wire/acceptance-criteria.ts";
import {BAD_SECTIONS, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {deriveFloor, type Floor, refsToProbe} from "./defects.ts";
import {type LedgerScope, scopeDigest} from "./digest.ts";
import {getChild, listSubIssues, probeCycleDoc} from "./github.ts";
import {
	CONTAINMENT_FIELD,
	fieldLines,
	readChildStories,
	readContainment,
	readEpicStories,
	STORIES_FIELD,
	sectionCount,
	USER_STORIES_HEADING,
} from "./ledger.ts";
import type {ChildLedger, CriteriaToken, Ledger, Phase} from "./model.ts";

/** Child reads and child writes run bounded. v1 spawned one `gh api` per child, unbounded. */
export const FAN_OUT = 8;

const DEPENDENCIES_HEADING = "Dependencies";

/** The four sentences a verb owns, so this module can refuse in the caller's voice. */
export interface PlanMessages {
	readonly verb: string;
	/** The ledger grammar refused; `reason` is the specific defect. */
	readonly grammar: (reason: string) => string;
	readonly zeroChildren: (epic: number) => string;
	readonly notAnEpic: (epic: number) => string;
	readonly unreadable: (what: string, reason: string) => string;
}

export type EpicTarget =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Epic"; readonly issue: IssueRecord};

/** The precondition every verb runs: an open issue that is a `type:epic`. */
export const requireEpic = (
	messages: PlanMessages,
	repo: string,
	number: number,
): Effect.Effect<EpicTarget, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const target = yield* openIssue(messages.verb, repo, number, (reason) =>
			messages.unreadable(`#${number}`, reason),
		);
		if (target._tag === "Refused") return {_tag: "Refused" as const, outcome: target.outcome};
		if (!target.issue.labels.includes(EPIC_TYPE_LABEL)) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(OFF_VOCABULARY, messages.notAnEpic(number)),
			};
		}
		return {_tag: "Epic" as const, issue: target.issue};
	});

export type LedgerRead =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Ledger"; readonly ledger: Ledger};

const criteriaOf = (body: string): {token: CriteriaToken; count: number} => {
	const read = readAcceptanceCriteria(body);
	if (read._tag === "Found") return {token: "found", count: read.value.length};
	return {token: read._tag === "Absent" ? "absent" : "malformed", count: 0};
};

/**
 * The whole ledger, fetched fresh.
 *
 * The order is deliberate: the epic's own grammar refuses before a single child is fetched, so a
 * ledger nobody could read costs one request rather than sixty.
 */
export const loadLedger = (
	messages: PlanMessages,
	repo: string,
	epic: IssueRecord,
): Effect.Effect<LedgerRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const number = epic.number;
		const grammarRefusal = (reason: string): LedgerRead => ({
			_tag: "Refused" as const,
			outcome: refuse(BAD_SECTIONS, messages.grammar(reason)),
		});

		for (const [heading, spelling] of [
			[DEPENDENCIES_HEADING, "## Dependencies"],
			[USER_STORIES_HEADING, "### User stories"],
		] as const) {
			const count = sectionCount(epic.body, heading);
			if (count > 1) {
				return grammarRefusal(
					`#${number} carries ${count} "${spelling}" sections — a ledger with two of one section has no single meaning.`,
				);
			}
		}

		const topology = readTopology(epic.body);
		if (topology._tag === "Unparseable") {
			return grammarRefusal(
				`#${number}'s ## Dependencies block is unparseable at line ${topology.line}: ${topology.text}`,
			);
		}

		const stories = readEpicStories(epic.body);
		if (stories._tag === "MisNumbered") {
			return grammarRefusal(
				`#${number}'s user stories are numbered ${stories.ids.join(", ")} — a story list must run from 1 with no gaps or repeats.`,
			);
		}

		const listed = yield* listSubIssues(repo, number);
		if (listed._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					messages.unreadable(`#${number}'s sub-issue list`, listed.reason),
				),
			};
		}
		if (listed.value.length === 0) {
			return {_tag: "Refused" as const, outcome: refuse(ZERO_SCOPE, messages.zeroChildren(number))};
		}

		const fetched = yield* Effect.forEach(
			listed.value.map((link) => link.number).sort((a, b) => a - b),
			(child) => getChild(repo, child).pipe(Effect.map((found) => [child, found] as const)),
			{concurrency: FAN_OUT},
		);

		const children: ChildLedger[] = [];
		for (const [number_, found] of fetched) {
			if (found._tag !== "Present") {
				return {
					_tag: "Refused" as const,
					outcome: refuse(
						PRECONDITION_UNKNOWN,
						messages.unreadable(
							`child #${number_}`,
							found._tag === "Absent" ? "it is proven absent" : found.reason,
						),
					),
				};
			}
			const payload = found.value;
			for (const [field, spelling] of [
				[STORIES_FIELD, "**Stories:**"],
				[CONTAINMENT_FIELD, "**Containment:**"],
			] as const) {
				const lines = fieldLines(payload.body, field);
				if (lines.length > 1) {
					return grammarRefusal(
						`#${number}'s child #${number_} carries ${lines.length} "${spelling}" lines — a field declared twice has no single meaning.`,
					);
				}
			}
			const childStories = readChildStories(fieldLines(payload.body, STORIES_FIELD)[0]);
			const criteria = criteriaOf(payload.body);
			children.push({
				number: payload.number,
				labels: [...payload.labels].sort(),
				assignees: payload.assignees === null ? null : [...payload.assignees].sort(),
				assigneesObserved: payload.assigneesObserved,
				criteria: criteria.token,
				criteriaCount: criteria.count,
				stories: childStories._tag === "Ids" ? childStories.ids : null,
				storiesValue: childStories._tag === "NonConforming" ? childStories.value : null,
				containment: readContainment(fieldLines(payload.body, CONTAINMENT_FIELD)[0]),
			});
		}

		const parsed = topology._tag === "Parsed" ? topology.edges : [];
		const phases: Phase[] = parsed
			.filter((edge): edge is PhaseLine => edge._tag === "Phase")
			.map((edge) => ({phase: edge.phase, members: edge.members.map(renderRef)}));
		// Only `requires:` lines become edges. A phase boundary is a total order and cannot cycle, so
		// `DEP_CYCLE` can only ever arise from an explicit requirement — see the `deps=` vs `edges=`
		// split in the scope digest, which carries the phase spine separately.
		const edges = parsed
			.filter((edge): edge is RequiresLine => edge._tag === "Requires")
			.flatMap((edge) =>
				edge.needs.map(
					(need) => [renderRef(edge.subject), renderRef(need)] as readonly [string, string],
				),
			);

		const scope: LedgerScope = {
			epic: number,
			children,
			epicStories: stories.ids,
			cycleDoc: yield* probeCycleDoc(repo),
			topology: {phases, edges},
			dependenciesAbsent: topology._tag === "Absent",
		};
		return {_tag: "Ledger" as const, ledger: {...scope, digest: scopeDigest(scope)}};
	});

/**
 * The scope line every verb prints on stderr: the count first, then the set.
 *
 * A sibling of `build/target.ts`'s `scannedLine` rather than a call to it — that one pluralises by
 * appending `s`, and the noun here is `children`. The discipline it encodes is the one that matters
 * and is kept: the count leads, so an answer over a surprising scope is auditable without re-running.
 */
export const scannedChildren = (verb: string, numbers: ReadonlyArray<number>): string =>
	`${verb}: scanned ${numbers.length} child${numbers.length === 1 ? "" : "ren"}; ${numbers
		.map((n) => `#${n}`)
		.join(", ")}.`;

export type FloorRead =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Floor"; readonly floor: Floor};

/**
 * The floor over a loaded ledger, including the one read it needs: the 404-discriminating probe
 * behind `DANGLING_DEP`.
 *
 * An `Unknown` probe refuses on `11` rather than resolving either way — "I could not tell whether
 * this ref exists" is not "it does", and it is certainly not "it does not".
 */
export const deriveFloorFor = (
	messages: PlanMessages,
	repo: string,
	ledger: LedgerScope,
): Effect.Effect<FloorRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const probed = yield* Effect.forEach(
			refsToProbe(ledger),
			(ref) => getIssue(repo, ref).pipe(Effect.map((found) => [ref, found] as const)),
			{concurrency: FAN_OUT},
		);
		const provenAbsent = new Set<number>();
		for (const [ref, found] of probed) {
			if (found._tag === "Unknown") {
				return {
					_tag: "Refused" as const,
					outcome: refuse(
						PRECONDITION_UNKNOWN,
						messages.unreadable(`referenced issue #${ref}`, found.reason),
					),
				};
			}
			if (found._tag === "Absent") provenAbsent.add(ref);
		}
		return {_tag: "Floor" as const, floor: deriveFloor({ledger, provenAbsent})};
	});
