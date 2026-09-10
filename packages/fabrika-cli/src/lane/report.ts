/**
 * The terminal-token map — one shell terminal in, one operator event out, in code.
 *
 * Each fabrika shell ends on a fixed token from a closed vocabulary its own skill owns; this table
 * is the one place those vocabularies meet the machine's operator events, replacing the prose
 * translation table the operator LLM used to execute per spawn. The map is total over the tokens
 * listed and refuses everything else — an unrecognised token is a refusal, never a permissive
 * `BLOCKED` guess, because "a report you cannot parse" stops being a failure class only when
 * nothing is left to parse.
 */
import {SHIP_CLASS_NAMES} from "../review/classes.ts";
import {MACHINERY_EVENT, type OperatorEvent} from "./machine.ts";

/**
 * Every recognised terminal token, grouped by the shell skill that owns its vocabulary — the
 * builder's (`build/SKILL.md`), the reviewer's (`review/SKILL.md`), the shipper's
 * (`ship/SKILL.md`), the UI reviewer's (`review-ui/SKILL.md`) — plus one group that belongs to no
 * shell: `machinery`, which a driver records about the pipeline itself. Documentation and test
 * surface; the lookup below flattens it.
 */
export const SHELL_VOCABULARIES = {
	builder: {
		"SHIPPED-PR": "DONE",
		"SUCCESS-NO-PR": "DONE",
		// An epic child builds, commits and deliberately opens no PR, so neither of the
		// two terminals above fits and the token used to fall to the refusal — recording a clean
		// build as BLOCKED. Its proof is already the child arm of `lane prove`: a DONE out
		// of `build` in a child role stands on the range's commits, not on a PR.
		"BUILT-NO-PR": "DONE",
		"BACKED-OFF": "BLOCKED",
		ESCALATED: "BLOCKED",
		STOPPED: "BLOCKED",
	},
	reviewer: {
		PASS: "PASS",
		FAIL: "FAIL",
		UNKNOWN: "BLOCKED",
		STALE: "BLOCKED",
		UNBINDABLE: "BLOCKED",
		ROUTED: "BLOCKED",
	},
	// The rendered gate's six terminals. Three of them named no event at all until this
	// group existed, so an unrenderable `review:ui` lane hit the refusal and stayed `active` with no
	// live shell — the park it actually was reached nobody. Each of the three is the reviewer
	// group's own BLOCKED shape: no verdict landed and a human is owed the render, the manifest or
	// the route. The three that re-spell the reviewer's agree with it, which is why flattening still
	// reports `Flat`.
	"ui-reviewer": {
		PASS: "PASS",
		FAIL: "FAIL",
		"CANT-SEE": "BLOCKED",
		ESCALATED: "BLOCKED",
		"BLOCKED-NO-MANIFEST": "BLOCKED",
		"ROUTED-ELSEWHERE": "BLOCKED",
	},
	// The machinery group — a failure of the pipeline carrying the artifact, never a judgment of the
	// artifact. Each token maps to the machine's own machinery event, so a collision at integrate and
	// a reviewer's FAIL stop arriving as one indistinguishable `FAIL`, and each names exactly one row
	// of `PARK_CAUSES` through `MACHINERY_CAUSES` — which is what makes "every machinery event
	// carries a cause" structural rather than a recorder's discipline.
	machinery: {
		"REPLAY-COLLIDED": "LAP",
		"BASE-DRIFTED": "LAP",
		"QUEUE-EJECTED": "LAP",
		"SEAT-DIRTY": "LAP",
	},
	shipper: {
		"ALREADY-MERGED": "DONE",
		// The two queue terminals are waits, not landings. Only a merge this pipeline read
		// back is `DONE`, and neither of these is one: `QUEUED` means the arm took and the shipper did
		// not watch it to an outcome, `UNRESOLVED` means it watched to its horizon and the PR is still
		// in the queue. Both used to fold the lane out of the loop — `QUEUED` to `shipped` over a merge
		// nobody observed, `UNRESOLVED` to a human park over a merge that was always going to land
		// — and both now route to the machine's wait cell, which a driver re-folds.
		QUEUED: "WIP",
		UNRESOLVED: "WIP",
		LANDED: "DONE",
		REFUSED: "BLOCKED",
		"AWAITING-CP-APPROVAL": "BLOCKED",
		// A routing terminal names its arm, because the three arms are three different answers to
		// the machine: repair is work this lane can retry, heal-ci and review are waits it cannot.
		// A shipper that routes to repair but reports one flat `ROUTED` parks the lane on a
		// control-plane approval nobody is waiting on.
		"ROUTED-REPAIR": "FAIL",
		"ROUTED-HEAL-CI": "BLOCKED",
		"ROUTED-REVIEW": "BLOCKED",
		// An ejection is always "routed to repair", so it feeds the machine's `ship` FAIL edge and
		// spends a retry rather than parking the lane.
		EJECTED: "FAIL",
		UNKNOWN: "BLOCKED",
	},
} as const satisfies Readonly<Record<string, Readonly<Record<string, OperatorEvent>>>>;

export type Flattening =
	| {readonly _tag: "Flat"; readonly tokens: Readonly<Record<string, OperatorEvent>>}
	| {readonly _tag: "Collision"; readonly collisions: ReadonlyArray<string>};

/**
 * Flatten the per-shell vocabularies into the one map `lane report` looks a bare token up in, and
 * name every disagreement rather than resolve it.
 *
 * `lane report` takes no shell argument — a token is all a shell hands over — so the lookup has to
 * be flat, and two shells may legitimately share a spelling: `UNKNOWN` is both the reviewer's and
 * the shipper's, and means `BLOCKED` in both. What must never happen is two shells spelling one
 * token with *different* events. A plain spread resolves that to whichever group is written last,
 * silently rewriting the loser's event; here it is a `Collision` the caller cannot read past.
 */
export const flattenVocabularies = (
	vocabularies: Readonly<Record<string, Readonly<Record<string, OperatorEvent>>>>,
): Flattening => {
	const tokens: Record<string, OperatorEvent> = {};
	const owners: Record<string, string> = {};
	const collisions: string[] = [];
	for (const [shell, vocabulary] of Object.entries(vocabularies)) {
		for (const [token, event] of Object.entries(vocabulary)) {
			const seen = tokens[token];
			if (seen !== undefined && seen !== event) {
				collisions.push(`${token}: ${owners[token]} reports ${seen}, ${shell} reports ${event}`);
				continue;
			}
			tokens[token] = event;
			owners[token] = shell;
		}
	}
	return collisions.length === 0
		? {_tag: "Flat", tokens}
		: {_tag: "Collision", collisions: collisions.sort()};
};

const flattened = flattenVocabularies(SHELL_VOCABULARIES);
if (flattened._tag === "Collision") {
	throw new Error(
		`lane report: the shell vocabularies disagree on ${flattened.collisions.length} token(s) — ${flattened.collisions.join("; ")}. Give the arms distinct spellings; one flat lookup cannot hold both.`,
	);
}

const TOKEN_EVENTS: Readonly<Record<string, OperatorEvent>> = flattened.tokens;

/** The recognised tokens, for the refusal message — sorted so the listing is deterministic. */
export const KNOWN_TOKENS: ReadonlyArray<string> = Object.keys(TOKEN_EVENTS).sort();

export type TokenResolution =
	| {readonly _tag: "Mapped"; readonly token: string; readonly event: OperatorEvent}
	| {readonly _tag: "Unrecognised"; readonly reason: string};

/**
 * Resolve one shell terminal token to its operator event. Case-insensitive, because the shipper's
 * vocabulary is spelled lower-case in its skill (`already-merged`, `landed`) and the builder's
 * upper-case — the token, not its casing, is the report.
 */
export const eventForToken = (raw: string): TokenResolution => {
	const token = raw.trim().toUpperCase();
	const event = TOKEN_EVENTS[token];
	return event === undefined
		? {
				_tag: "Unrecognised",
				reason: `"${raw}" is no shell's terminal token (known: ${KNOWN_TOKENS.join(", ")})`,
			}
		: {_tag: "Mapped", token, event};
};

/**
 * Whose failure a park is, and so who takes the next move on it.
 *
 * `driver` is machinery — residue a driver session owns, or a read some verb can take again — so a
 * driver may work the park itself. `founder` is a judgment no verb may make on its own account, so
 * the park leaves the machine. Two arms and no third: an "either" would be the guess this field
 * exists to delete.
 */
export type ParkRoute = "driver" | "founder";

/**
 * One park cause: what it means, in a clause a refusal can quote, whose failure it is, and the verb
 * that removes it.
 */
export interface ParkCauseEntry {
	readonly meaning: string;
	readonly route: ParkRoute;
	/**
	 * The verb that removes this cause before anything re-reads it, or `null` for a cause whose
	 * removal is somebody else's act.
	 *
	 * `null` is deliberate rather than unfinished: resuming a campaign is a human's judgment and
	 * dispatching the other gate is the driver's own move, so a verb that "removed" either would be
	 * taking a decision it is only allowed to observe.
	 */
	readonly remedy: string | null;
}

/**
 * Why a lane parked, as a closed set of tokens — the field that makes a `BLOCKED` clearable.
 *
 * The token map above folds thirteen distinct shell terminals into one flat `BLOCKED`, so the event
 * that lands records that a park happened and never why. `recipe unpark` keys its recipe table on a
 * park's cause, which left every `BLOCKED` novel by construction: the mechanism to clear a park
 * autonomously existed and could match nothing. A cause is the key it was missing.
 *
 * It is a closed set for the same reason the terminal tokens are: a free-text cause is prose a
 * recipe would have to interpret, and interpreting a report is the failure class this module
 * deletes. Each entry carries `meaning` — what the cause means, in the clause a refusal can quote —
 * {@link ParkRoute}, whose failure the park is, and `remedy`, the verb that removes it.
 *
 * **The remedy is written here and nowhere else.** A `KNOWN_PARKS` row used to declare its own, so
 * two rows keying on two causes could name the same verb and nothing compared them to the cause
 * they were clearing; `recipe/parks.ts` now derives the field through {@link remedyForCause}, the
 * way it already derives the route.
 *
 * **The route is the second field because the cause alone never said whose problem it is.** A park
 * a driver can work through and one only the founder can answer take opposite next moves, and with
 * both folded into one token a sweep had to guess. `driver` is machinery — residue a driver session
 * owns, or a read a verb can take again; `founder` is a product call no verb may make on its own.
 * Every entry records its route with a one-line reason in its own docblock, so the routing is
 * readable at the token rather than derived somewhere else.
 *
 * A cause is seated on its own account, and a `KNOWN_PARKS` row is never its precondition.
 * Where no row covers it, `classifyPark` answers `Novel` **naming this cause** instead of the bare
 * "recorded the event and not why", which is the difference between a gap somebody can write a row
 * for and a structural dead end (`recipe/parks.ts`). The row is what buys an autonomous clear, and
 * that still costs the recipe's own proving read.
 */
export const PARK_CAUSES = {
	/**
	 * A finished lane's worktree still holds the branch this lane must build on, so
	 * `build branch --resume-lane` refuses at exit 11 rather than re-key a branch out from under
	 * another tree. The whole remedy is removing that worktree, which is why it owes no decision.
	 *
	 * Route `driver`: the tree is a driver session's own residue, and removing it decides nothing.
	 */
	"worktree-holds-branch": {
		meaning: "a working tree still holds the lane branch this build must stand on",
		route: "driver",
		remedy: "fabrika build retire",
	},
	/**
	 * `ship cp-approval` stops on a head behind its base, and the head must move before
	 * an approval is solicited. The park spends neither budget, and reporting it as
	 * `ROUTED-REPAIR` charged a repair retry for a trip through a stage that owns no verb that can
	 * move a branch.
	 *
	 * Its remedy is `lane refresh`, which merges the base into an epic run's assembly branch and
	 * proves the head it lands on. It still carries no `KNOWN_PARKS` row: a row is what buys an
	 * autonomous clear, and that costs a proving read of the moved head this cause does not yet have.
	 *
	 * Route `driver`: moving a head onto its base is machinery, and no product call is in it.
	 */
	"head-behind-base": {
		meaning: "the PR's head is behind its base and must move before an approval is solicited",
		route: "driver",
		remedy: "fabrika lane refresh",
	},
	/**
	 * `lane refresh` found a real conflict between the trunk and an epic run's assembly branch. The
	 * merge was aborted and the branch put back where the refresh found it, so the tail cannot bind
	 * to a refreshed head until the two sides are reconciled.
	 *
	 * No remedy: resolving a conflict that is not a plain keep-both is a judgment about content, and
	 * a verb that "removed" this cause would be making it.
	 *
	 * Route `driver`: reconciling two branches of this repo's own code is machinery, not a product
	 * call.
	 */
	"assembly-conflict": {
		meaning:
			"the trunk conflicts with the epic run's assembly branch, so the tail cannot bind to a refreshed head",
		route: "driver",
		remedy: null,
	},
	/**
	 * `lane integrate` replayed a colliding child onto the assembly tip and hit a hunk that is not a
	 * plain keep-both — two sides editing one text rather than an append each. The pick was abandoned
	 * and the seat put back, so the assembly branch carries neither the merge nor the replay.
	 *
	 * Distinct from `assembly-conflict`, which is the trunk against the assembly branch: this one is
	 * one child's range against another child's, and it is the collision the replay exists for. It
	 * carries no `KNOWN_PARKS` row and no remedy for the same reason `assembly-conflict` does not —
	 * resolving a semantic conflict is a judgment about content, and a verb that "removed" this cause
	 * would be making it.
	 *
	 * Route `driver`: reconciling two children of this repo's own code is machinery, not a product
	 * call.
	 */
	"replay-conflict": {
		meaning:
			"a child's replay onto the assembly tip hit a hunk that is not a plain keep-both, so the collision needs a judgment about content",
		route: "driver",
		remedy: null,
	},
	/**
	 * The lane is homed on a milestone whose `## Campaigns` row reads `paused`, and
	 * that cell is the whole dispatch permission — so no stage may open against it.
	 *
	 * A pause is open-ended, which is why this is a park and not a bounded wait (the merge-queue
	 * dwell is the other side of that line). Its `KNOWN_PARKS` row clears by re-reading the same cell:
	 * resuming the campaign stays a human's act on `ROADMAP.md`, so the row names no remedy verb.
	 *
	 * Route `founder`: a campaign's lifecycle is a product call, and no driver may take it.
	 */
	"campaign-paused": {
		meaning:
			"the campaign homing this lane's milestone reads paused, so no stage may dispatch against it",
		route: "founder",
		remedy: null,
	},
	/**
	 * The shell driving this lane's stage was killed by its provider before it
	 * recorded a terminal — a session limit, a transport drop, a `network_error` on every completion.
	 * Nothing about the ticket or the artifact is wrong, and the remedy is to dispatch the same brief
	 * again.
	 *
	 * Its `KNOWN_PARKS` row reads the residue the dead shell left rather than the provider's health,
	 * because no verb can spawn an agent to test the latter: the operator's next dispatch is that
	 * test.
	 *
	 * Route `driver`: the residue is the driver's own, and the re-dispatch is the driver's move.
	 */
	"spawn-dead": {
		meaning:
			"the shell driving this lane's stage was killed by its provider before it recorded a terminal",
		route: "driver",
		remedy: "fabrika build retire",
	},
	/**
	 * The rendered gate's `CANT-SEE`: no preview deployment stands at the PR's head, or the
	 * one that does is stale beyond repair, so there is no rendered surface to judge. It is the
	 * routine outcome of the three, not the exceptional one — a PR whose preview has not finished
	 * building hits it.
	 *
	 * Naming-only: a `KNOWN_PARKS` row would have to re-test the deployment, and that proving
	 * read is separate work, so the sweep routes this to a human by naming the cause.
	 *
	 * Route `driver`: a deployment is machinery, and re-reading it needs no product call.
	 */
	"no-preview-render": {
		meaning: "no preview deployment stands at the PR's head, so no rendered surface can be judged",
		route: "driver",
		remedy: null,
	},
	/**
	 * The rendered gate's `BLOCKED-NO-MANIFEST`: the repo's design law covers no surface in
	 * this diff, so the gate has nothing to judge against and routed to the front door.
	 *
	 * Naming-only: writing the manifest coverage is a human's act on the design law, and no verb
	 * ships that can, exactly as `campaign-paused`'s resume stays a human's act on `ROADMAP.md`.
	 *
	 * Route `driver`: the design law is repo text, so widening its coverage is a diff a driver
	 * builds — a human writes it, and that is not the same as a product call only the founder makes.
	 */
	"no-design-manifest": {
		meaning:
			"the repo's design law covers no surface in this diff, so the rendered gate has nothing to judge against",
		route: "driver",
		remedy: null,
	},
	/**
	 * The rendered gate's `ROUTED-ELSEWHERE`: the diff raises no rendered delta, so the
	 * verdict is `review`'s to give and never this gate's. The park is the route itself, which the
	 * group's own mapping keeps as `BLOCKED` rather than a routing arm.
	 *
	 * Naming-only: clearing it means dispatching the other gate, which is the operator's act and not
	 * a condition a recipe can read back.
	 *
	 * Route `driver`: dispatching the other gate is the driver's own act.
	 */
	"no-rendered-delta": {
		meaning:
			"the diff raises no rendered delta, so the verdict is `review`'s to give and not the rendered gate's",
		route: "driver",
		remedy: null,
	},
	/**
	 * The merge queue ejected the PR before it merged — a sibling's red, a base that moved under the
	 * batch, a queue timeout. The head is where the shipper left it and the verdicts still stand.
	 *
	 * Naming-only: re-enqueuing is `ship`'s own next dispatch, and a verb that "removed" this cause
	 * would be taking that act rather than observing it.
	 *
	 * Route `driver`: a queue ejection is machinery, and nothing about the artifact was judged.
	 */
	"queue-ejected": {
		meaning: "the merge queue ejected this PR before it merged, and no verdict against it changed",
		route: "driver",
		remedy: null,
	},
} as const satisfies Record<string, ParkCauseEntry>;

export type ParkCause = keyof typeof PARK_CAUSES;

/**
 * Each machinery terminal's own cause — the binding that makes a lap's cause structural.
 *
 * A `--cause` is a caller's discipline and a lap's cause is not: every machinery token names exactly
 * one machinery failure, so the cause is read off the token here and a recorder that passes none
 * still lands a caused line. Passing one still works and is checked against {@link PARK_CAUSES} like
 * any other, which is how a recorder that knows better (a replay that parked on
 * `assembly-conflict` rather than `replay-conflict`) says so.
 */
export const MACHINERY_CAUSES: Readonly<Record<string, ParkCause>> = {
	"REPLAY-COLLIDED": "replay-conflict",
	"BASE-DRIFTED": "head-behind-base",
	"QUEUE-EJECTED": "queue-ejected",
	"SEAT-DIRTY": "worktree-holds-branch",
};

/** The cause a machinery terminal carries on its own, or `null` for every other token. */
export const machineryCause = (token: string): ParkCause | null =>
	MACHINERY_CAUSES[token.trim().toUpperCase()] ?? null;

/** The recognised causes, for a refusal's listing — sorted so the listing is deterministic. */
export const PARK_CAUSE_TOKENS: ReadonlyArray<string> = Object.keys(PARK_CAUSES).sort();

/**
 * The route a park takes, read off the one table — the only place a route is written down.
 *
 * A park carrying **no** cause routes `founder`, and that is fail-closed rather than a default: a
 * park nothing named cannot be attributed to machinery, so nothing here may claim a driver can work
 * it. The two `KNOWN_PARKS` rows keyed by their leaf alone (`human:cp-approval`, `human:queue-stall`)
 * take that arm, and both are already waits on somebody else's act.
 */
export const routeForCause = (cause: string | null): ParkRoute =>
	cause !== null && Object.hasOwn(PARK_CAUSES, cause)
		? PARK_CAUSES[cause as ParkCause].route
		: "founder";

/**
 * The verb that removes a cause, read off the one table — the only place a remedy is written down.
 *
 * A park carrying **no** cause has no remedy, on the same fail-closed reasoning the route takes:
 * nothing named what went wrong, so nothing here may name the verb that undoes it. The two
 * `KNOWN_PARKS` rows keyed by their leaf alone take that arm, and both are waits on somebody else's
 * act rather than something a verb removes.
 */
export const remedyForCause = (cause: string | null): string | null =>
	cause !== null && Object.hasOwn(PARK_CAUSES, cause)
		? PARK_CAUSES[cause as ParkCause].remedy
		: null;

export type ClassResolution =
	| {readonly _tag: "Classed"; readonly classes: ReadonlyArray<string> | null}
	| {readonly _tag: "Rejected"; readonly reason: string};

/**
 * Resolve the `--class` values against the closed set `ship scope` / `review scope` derive from.
 *
 * A silent miss is the failure mode this closes: an unknown spelling matched no `class:<name>` arm,
 * the guarded array fell through to its unclassed target, and the lane built as a plain lane with
 * the rendered-visual verdict it owed never asked for. Spelling is normalised the way a
 * cause's is, so `--class UI` is the `ui` class rather than a refusal.
 */
export const classesForEvent = (raw: ReadonlyArray<string>): ClassResolution => {
	if (raw.length === 0) return {_tag: "Classed", classes: null};
	const classes: string[] = [];
	for (const value of raw) {
		const token = value.trim().toLowerCase();
		if (!(SHIP_CLASS_NAMES as ReadonlyArray<string>).includes(token)) {
			return {
				_tag: "Rejected",
				reason: `"${value}" is no lane class this repo routes on (known: ${SHIP_CLASS_NAMES.join(", ")})`,
			};
		}
		if (!classes.includes(token)) classes.push(token);
	}
	return {_tag: "Classed", classes};
};

export type CauseResolution =
	| {readonly _tag: "Uncaused"}
	| {readonly _tag: "Caused"; readonly cause: ParkCause}
	/** A `BLOCKED` carrying no cause, under a repo that declared cause-less parks unrecordable. */
	| {readonly _tag: "Required"; readonly reason: string}
	| {readonly _tag: "Rejected"; readonly reason: string};

const isParkCause = (token: string): token is ParkCause => Object.hasOwn(PARK_CAUSES, token);

/**
 * Resolve one `--cause` against the event it rides on, under the repo's declared park-cause rule.
 *
 * A cause on a non-`BLOCKED` event is refused rather than dropped. Only a park has a cause to be
 * gone, so a `DONE` carrying one is a caller that misunderstood the field, and recording it would
 * seat a cause on a line no unpark will ever read.
 *
 * **An absent cause on a `BLOCKED` is the axis `requireCause` turns.** Off — the shipped default —
 * it is `Uncaused` exactly as it always was, and the bare park routes to a human. On, it is
 * `Required`: a park recorded with no cause folds to a `Novel` no verb can clear, so recording it
 * spends a person to say a thing the recorder already knew.
 *
 * **A machinery lap requires one under every rule.** The whole difference between a lap and a repair
 * round is which machinery spent it, and a lap recorded with none says only that the pipeline failed
 * — which is the reading this axis exists to replace. The recorder never has to type it:
 * {@link machineryCause} reads it off the token.
 */
export const causeForEvent = (
	raw: string | null,
	event: OperatorEvent,
	requireCause: boolean,
): CauseResolution => {
	if (raw === null) {
		if (event === MACHINERY_EVENT) {
			return {
				_tag: "Required",
				reason: `a machinery lap must name the machinery that spent it — pass --cause with one of: ${PARK_CAUSE_TOKENS.join(", ")}`,
			};
		}
		return requireCause && event === "BLOCKED"
			? {
					_tag: "Required",
					reason: `a park must name why it parked — pass --cause with one of: ${PARK_CAUSE_TOKENS.join(", ")}`,
				}
			: {_tag: "Uncaused"};
	}
	if (event !== "BLOCKED" && event !== MACHINERY_EVENT) {
		return {
			_tag: "Rejected",
			reason: `a cause names why a lane parked or spent a machinery lap, and this token maps to ${event}, which is neither — drop --cause "${raw}"`,
		};
	}
	const token = raw.trim().toLowerCase();
	return isParkCause(token)
		? {_tag: "Caused", cause: token}
		: {
				_tag: "Rejected",
				reason: `"${raw}" is no park cause this repo's recipes key on (known: ${PARK_CAUSE_TOKENS.join(", ")})`,
			};
};

export type GrantResolution =
	| {readonly _tag: "Granted"; readonly grant: number | null}
	| {readonly _tag: "Rejected"; readonly reason: string};

/**
 * Resolve one `--grant-wait` against the event it rides on. Absent grants nothing and is the
 * ordinary case: every resume out of a park that has waits left records exactly as it always did.
 *
 * Both refusals keep a grant that buys nothing from reading as one that bought something. A grant on
 * a non-`UNBLOCKED` event is a caller that misunderstood the field — only a resume can be short the
 * budget it lands on — and would silently inflate `maxWaits` on a line no reader is looking at. A
 * grant of zero or less raises the budget by nothing while the resume reads as granted, which is the
 * silent no-op the wait axis exists to make loud.
 */
export const grantForEvent = (raw: number | null, event: OperatorEvent): GrantResolution => {
	if (raw === null) return {_tag: "Granted", grant: null};
	if (event !== "UNBLOCKED") {
		return {
			_tag: "Rejected",
			reason: `waits are granted on the resume that spends them, and this token maps to ${event}, not UNBLOCKED — drop --grant-wait ${raw}`,
		};
	}
	return Number.isInteger(raw) && raw > 0
		? {_tag: "Granted", grant: raw}
		: {_tag: "Rejected", reason: `--grant-wait ${raw} is no whole grant of at least one wait`};
};

export type RationaleResolution =
	| {readonly _tag: "Reasoned"; readonly rationale: string | null}
	| {readonly _tag: "Rejected"; readonly reason: string};

/**
 * Resolve one `--rationale` against the event it rides on — the mirror of {@link causeForEvent},
 * which seats why a lane parked on the `BLOCKED` that parked it.
 *
 * A rationale on a non-`UNBLOCKED` event is refused rather than dropped: only a resume is a
 * clearance, so anything else carrying one is a caller that misunderstood the field, and recording
 * it would seat an explanation on a line no unpark and no reader is looking at. A blank one is
 * refused for the reason the field exists at all — a clearance whose recorded reason says nothing is
 * exactly as unauditable as one that recorded none.
 */
export const rationaleForEvent = (
	raw: string | null,
	event: OperatorEvent,
): RationaleResolution => {
	if (raw === null) return {_tag: "Reasoned", rationale: null};
	if (event !== "UNBLOCKED") {
		return {
			_tag: "Rejected",
			reason: `a rationale names why a park was cleared, and this token maps to ${event}, not UNBLOCKED — drop --rationale`,
		};
	}
	const trimmed = raw.trim();
	return trimmed === ""
		? {
				_tag: "Rejected",
				reason: "--rationale is blank, and a clearance that says nothing is one nobody can review",
			}
		: {_tag: "Reasoned", rationale: trimmed};
};
