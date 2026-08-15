/**
 * The composite read every `map` verb rests on: the map issue, its parsed body, its children, and
 * each child's resolved frontier state.
 *
 * State is resolved from the ticket's markers, its own `state` on GitHub, and its native edges — the
 * body's `## Frontier` rows are a rendering of this answer, never the record of it. An implementer
 * who derives state by matching headings has rebuilt the v1 scar this module exists to remove.
 *
 * <!-- anchor: NEVER-PASS-ON-A-FAILED-READ --> **An empty read that cannot be proven empty is
 * UNKNOWN.** v1's dangling-reference check disabled itself whenever the sub-issue read came back
 * empty (`if (subIssues.length > 0)`), so a rate-limited call silently removed the check rather than
 * refusing — the zero-scope pass ADR 0092 forbids. Here zero children is a **fact** only when the
 * platform proved it with `200 []`; every other outcome is {@link FrontierRead.Unknown}.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {blockedBy, blocking, subIssues} from "../io/edges.ts";
import type {Shell} from "../io/git.ts";
import {type CommentRecord, getIssue, type IssueRecord, listComments} from "../io/issues.ts";
import {permissionFor} from "../io/pulls.ts";
import {type DecisionEntry, type Kind, type MapBody, parseBody} from "./body.ts";
import {
	type Outcome,
	reachesForTicketMarker,
	readFindingMarker,
	readForkMarker,
	readLaneMarker,
	readRetiredMarker,
	readTicketMarker,
} from "./markers.ts";

/** The label a map is found by. `map open` applies it on mint; nothing else touches it. */
export const MAP_LABEL = "wayfinding:map";

/** The permissions that authorize a marker — the ADR 0055 `write+` set. */
const AUTHORIZED = new Set(["admin", "maintain", "write"]);

export type MapRead =
	| {readonly _tag: "Map"; readonly issue: IssueRecord; readonly body: MapBody}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Malformed"; readonly reason: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * The map issue and its parsed body, four ways.
 *
 * `Absent` covers a missing issue **and** one that does not carry {@link MAP_LABEL}: both mean *this
 * number names no map*, which is the same `7` with the same remedy, and neither is a body defect.
 */
export const readMap = (repo: string, map: number): Shell<MapRead> =>
	Effect.gen(function* () {
		const issue = yield* getIssue(repo, map);
		if (issue._tag === "Absent") return {_tag: "Absent" as const};
		if (issue._tag === "Unknown") return {_tag: "Unknown" as const, reason: issue.reason};
		if (!issue.value.labels.includes(MAP_LABEL)) return {_tag: "Absent" as const};
		const parsed = parseBody(issue.value.body);
		return parsed._tag === "Malformed"
			? {_tag: "Malformed" as const, reason: parsed.reason}
			: {_tag: "Map" as const, issue: issue.value, body: parsed.value};
	});

/** The six states a frontier ticket may hold. `graduated` and `retired` are terminal and always win. */
export type TicketState = "open" | "lane-held" | "lane-closed" | "forked" | "graduated" | "retired";

export interface Ticket {
	readonly number: number;
	readonly kind: Kind;
	readonly question: string;
	readonly state: TicketState;
	readonly blockedBy: ReadonlyArray<number>;
	readonly blocking: ReadonlyArray<number>;
	/** Present when `state` is `lane-held`: the run nonce holding the lane. */
	readonly nonce?: string;
	/** Present when `state` is `forked` and `kind` is `decision`. */
	readonly session?: number;
	/** Present when `state` is `forked` and `kind` is `prototype`. */
	readonly spike?: number;
	/** Present when `state` is `lane-closed`. */
	readonly outcome?: Outcome;
	/** Present when `state` is `retired`: the out-of-scope direction it retired into. */
	readonly retiredBy?: string;
}

/** A child this read did **not** count as a frontier ticket, and why. */
export interface Disregarded {
	readonly ticket: number;
	readonly reason: "malformed" | "foreign-map" | "unauthorized";
	readonly detail: string;
}

export interface Frontier {
	readonly tickets: ReadonlyArray<Ticket>;
	readonly disregarded: ReadonlyArray<Disregarded>;
	readonly scanned: {
		readonly children: number;
		readonly edgeReads: number;
		readonly comments: number;
	};
}

export type FrontierRead =
	| {readonly _tag: "Frontier"; readonly value: Frontier}
	| {readonly _tag: "MapAbsent"}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** Whether a ticket has left the frontier for good. */
export const isTerminal = (state: TicketState): boolean =>
	state === "graduated" || state === "retired";

/** The ticket's question: the first non-blank line of its body, else its title. */
const questionOf = (issue: IssueRecord): string => {
	const line = issue.body.split("\n").find((l) => l.trim() !== "");
	return (line ?? issue.title).trim();
};

interface MarkerScan {
	readonly lane: {readonly nonce: string} | null;
	readonly finding: {readonly outcome: Outcome; readonly nonce: string} | null;
	readonly fork: {readonly route: "session" | "spike"; readonly issue: number} | null;
	readonly retired: {readonly direction: string} | null;
}

/**
 * The last marker of each kind on a ticket, in comment order.
 *
 * Last rather than first: a re-laned ticket carries an older `map-lane` and a newer one, and the
 * lane that holds it now is the newer. Pairing is by ticket, so a finding always closes the lane
 * that precedes it.
 */
export const scanTicketMarkers = (
	map: number,
	ticket: number,
	comments: ReadonlyArray<CommentRecord>,
): MarkerScan => {
	let lane: MarkerScan["lane"] = null;
	let finding: MarkerScan["finding"] = null;
	let fork: MarkerScan["fork"] = null;
	let retired: MarkerScan["retired"] = null;
	for (const comment of comments) {
		const laneMarker = readLaneMarker(comment.body);
		if (laneMarker !== null && laneMarker.map === map && laneMarker.ticket === ticket) {
			lane = {nonce: laneMarker.nonce};
			finding = null;
		}
		const findingMarker = readFindingMarker(comment.body);
		if (findingMarker !== null && findingMarker.map === map && findingMarker.ticket === ticket) {
			finding = {outcome: findingMarker.outcome, nonce: findingMarker.nonce};
		}
		const forkMarker = readForkMarker(comment.body);
		if (forkMarker !== null && forkMarker.map === map && forkMarker.ticket === ticket) {
			fork = {route: forkMarker.route, issue: forkMarker.issue};
		}
		const retiredMarker = readRetiredMarker(comment.body);
		if (retiredMarker !== null && retiredMarker.map === map && retiredMarker.ticket === ticket) {
			retired = {direction: retiredMarker.direction};
		}
	}
	return {lane, finding, fork, retired};
};

/**
 * Whether the map's `## Decisions` already carries this ticket's answer.
 *
 * Two citations resolve to one ticket, because the contract's citation grammar has two forms and only
 * one of them names a ticket: a research or spike finding cites `— from #<ticket>`, and a relayed
 * ruling cites `— ruled on #<session>`, which names the session the fork pointed at. Matching the
 * fork's session is what lets a decision ticket graduate at all; without it a forked ticket's answer
 * could land on the map and the ticket would still read `forked` forever.
 */
export const decisionCiting = (
	body: MapBody,
	ticket: number,
	forkedSession: number | null,
): DecisionEntry | undefined =>
	body.decisions.find((entry) =>
		entry.authority._tag === "Finding"
			? entry.authority.ticket === ticket
			: forkedSession !== null && entry.authority.session === forkedSession,
	);

export const decisionCites = (
	body: MapBody,
	ticket: number,
	forkedSession: number | null,
): boolean => decisionCiting(body, ticket, forkedSession) !== undefined;

const stateOf = (
	closed: boolean,
	markers: MarkerScan,
	body: MapBody,
	ticket: number,
): TicketState => {
	if (markers.retired !== null && closed) return "retired";
	const forkedSession =
		markers.fork !== null && markers.fork.route === "session" ? markers.fork.issue : null;
	if (closed && decisionCites(body, ticket, forkedSession)) return "graduated";
	if (markers.fork !== null) return "forked";
	if (markers.finding !== null) return "lane-closed";
	if (markers.lane !== null) return "lane-held";
	return "open";
};

/** One resolved child, or the reason it is not counted as a ticket of this map. */
type ChildOutcome =
	| {readonly _tag: "Ticket"; readonly value: Ticket}
	| {readonly _tag: "Disregarded"; readonly value: Disregarded}
	| {readonly _tag: "Skip"}
	| {readonly _tag: "Unknown"; readonly reason: string};

const resolveChild = (
	repo: string,
	map: number,
	body: MapBody,
	child: number,
	permissions: Map<string, string | null>,
	counters: {comments: number; edgeReads: number},
): Effect.Effect<ChildOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const issue = yield* getIssue(repo, child);
		if (issue._tag === "Absent") {
			return {
				_tag: "Unknown" as const,
				reason: `#${child} is listed as a child of #${map} and does not exist`,
			};
		}
		if (issue._tag === "Unknown") return {_tag: "Unknown" as const, reason: issue.reason};

		const listed = yield* listComments(repo, child);
		if (listed._tag === "Failure") return {_tag: "Unknown" as const, reason: listed.reason};
		counters.comments += listed.value.length;

		const reaching = listed.value.find((comment) => reachesForTicketMarker(comment.body));
		// A child with no `map-ticket:` comment at all reaches for nothing — an unmarked issue is not
		// a frontier ticket and is not a ticket that "looks like" this map's, so it is neither counted
		// nor disregarded. `map ticket`'s partial application leaves exactly this, and re-running it
		// with the same question resumes rather than duplicating.
		if (reaching === undefined) return {_tag: "Skip" as const};

		// Content is not authority (ADR 0055): every marker this walk reads must come from a `write+`
		// author, so a thread anyone can comment on cannot hand itself a lane or retire a ticket. A
		// permission read that FAILS is UNKNOWN for the whole run, never a demotion — v1 demoted an
		// authorized author on a transient read failure, which hands the lane to a later claimant on a
		// network blip.
		const authorized: CommentRecord[] = [];
		for (const comment of listed.value) {
			let permission = permissions.get(comment.author);
			if (permission === undefined) {
				const read = yield* permissionFor(repo, comment.author);
				if (read._tag === "Unknown") {
					return {
						_tag: "Unknown" as const,
						reason: `the repository permission of "${comment.author}" could not be read (${read.reason})`,
					};
				}
				permission = read._tag === "Present" ? read.value : null;
				permissions.set(comment.author, permission);
			}
			if (permission !== null && AUTHORIZED.has(permission)) authorized.push(comment);
		}

		const opening = authorized.find((comment) => reachesForTicketMarker(comment.body));
		if (opening === undefined) {
			return {
				_tag: "Disregarded" as const,
				value: {
					ticket: child,
					reason: "unauthorized" as const,
					detail:
						"every map-ticket marker on this child is from an author with no write permission",
				},
			};
		}

		const marker = readTicketMarker(opening.body);
		if (marker === null) {
			return {
				_tag: "Disregarded" as const,
				value: {
					ticket: child,
					reason: "malformed" as const,
					detail: "the map-ticket marker is not `map-ticket: #<map> · <kind> · <nonce>`",
				},
			};
		}
		if (marker.map !== map) {
			return {
				_tag: "Disregarded" as const,
				value: {
					ticket: child,
					reason: "foreign-map" as const,
					detail: `the map-ticket marker names map #${marker.map}, not #${map}`,
				},
			};
		}

		const waits = yield* blockedBy(repo, child);
		counters.edgeReads += 1;
		if (waits._tag !== "Present") {
			return {
				_tag: "Unknown" as const,
				reason:
					waits._tag === "Absent"
						? `#${child}'s blocked_by list reports the issue does not exist`
						: waits.reason,
			};
		}
		const gates = yield* blocking(repo, child);
		counters.edgeReads += 1;
		if (gates._tag !== "Present") {
			return {
				_tag: "Unknown" as const,
				reason:
					gates._tag === "Absent"
						? `#${child}'s blocking list reports the issue does not exist`
						: gates.reason,
			};
		}

		const markers = scanTicketMarkers(map, child, authorized);
		const state = stateOf(issue.value.state === "closed", markers, body, child);
		return {
			_tag: "Ticket" as const,
			value: {
				number: child,
				kind: marker.kind,
				question: questionOf(issue.value),
				state,
				blockedBy: waits.value,
				blocking: gates.value,
				...(state === "lane-held" && markers.lane !== null ? {nonce: markers.lane.nonce} : {}),
				...(state === "forked" && markers.fork?.route === "session"
					? {session: markers.fork.issue}
					: {}),
				...(state === "forked" && markers.fork?.route === "spike"
					? {spike: markers.fork.issue}
					: {}),
				...(state === "lane-closed" && markers.finding !== null
					? {outcome: markers.finding.outcome}
					: {}),
				...(state === "retired" && markers.retired !== null
					? {retiredBy: markers.retired.direction}
					: {}),
			},
		};
	});

/**
 * Every frontier ticket of `map`, with its state and edges resolved.
 *
 * The scan is sequential rather than concurrent on purpose: the ACL memo is what keeps a thread of
 * markers from one author to one permission read, and a concurrent walk would race the memo into one
 * lookup per child.
 */
export const readFrontier = (
	repo: string,
	map: number,
	body: MapBody,
): Effect.Effect<FrontierRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const children = yield* subIssues(repo, map);
		if (children._tag === "Absent") return {_tag: "MapAbsent" as const};
		if (children._tag === "Unknown") return {_tag: "Unknown" as const, reason: children.reason};

		const permissions = new Map<string, string | null>();
		const counters = {comments: 0, edgeReads: 0};
		const tickets: Ticket[] = [];
		const disregarded: Disregarded[] = [];
		for (const child of children.value) {
			const outcome = yield* resolveChild(repo, map, body, child, permissions, counters);
			if (outcome._tag === "Unknown") return {_tag: "Unknown" as const, reason: outcome.reason};
			if (outcome._tag === "Ticket") tickets.push(outcome.value);
			if (outcome._tag === "Disregarded") disregarded.push(outcome.value);
		}

		return {
			_tag: "Frontier" as const,
			value: {
				tickets,
				disregarded,
				scanned: {children: children.value.length, ...counters},
			},
		};
	});

/** The four answers a frontier may carry. All four are answers, and all four exit `0`. */
export type FrontierToken = "awaiting-founder" | "lanes-pending" | "clear" | "empty";

export const frontierToken = (tickets: ReadonlyArray<Ticket>): FrontierToken => {
	if (tickets.length === 0) return "empty";
	const awaiting = tickets.some(
		(ticket) =>
			ticket.kind === "decision" && (ticket.state === "open" || ticket.state === "forked"),
	);
	if (awaiting) return "awaiting-founder";
	return tickets.every((ticket) => isTerminal(ticket.state)) ? "clear" : "lanes-pending";
};

/** `state → how many tickets hold it`, plus the derived `blocked` count. */
export const counts = (tickets: ReadonlyArray<Ticket>): Readonly<Record<string, number>> => {
	const unresolved = new Set(
		tickets.filter((ticket) => !isTerminal(ticket.state)).map((ticket) => ticket.number),
	);
	const tally: Record<string, number> = {
		open: 0,
		"lane-held": 0,
		"lane-closed": 0,
		forked: 0,
		graduated: 0,
		retired: 0,
		blocked: 0,
	};
	for (const ticket of tickets) {
		tally[ticket.state] = (tally[ticket.state] ?? 0) + 1;
		// Derived, never stored: a ticket can be both `open` and blocked, and collapsing the two would
		// lose which. Whether a standalone issue may carry stored blockedness is open at #4840; this
		// read takes no position on it.
		if (ticket.blockedBy.some((number) => unresolved.has(number))) {
			tally.blocked = (tally.blocked ?? 0) + 1;
		}
	}
	return tally;
};
