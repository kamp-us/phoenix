/**
 * `map ticket`'s pure half: the cycle check over the frontier's native edges, and the bytes the new
 * ticket carries.
 *
 * The cycle check runs **before** anything is written. A frontier that closes a cycle is one no run
 * can drain — every ticket in the loop waits on another — so the refusal has to land while the
 * frontier is still untouched rather than after a ticket exists.
 */

import type {Ticket} from "./frontier.ts";
import {truncateOnWordBoundary} from "./open.ts";

/** `ticket → the tickets it waits on`, the direction a cycle is a loop in. */
export type WaitsOn = ReadonlyMap<number, ReadonlyArray<number>>;

export const waitsOnGraph = (tickets: ReadonlyArray<Ticket>): WaitsOn =>
	new Map(tickets.map((ticket) => [ticket.number, ticket.blockedBy]));

/** Whether `to` is reachable from `from` by following waits-on edges. */
export const reaches = (graph: WaitsOn, from: number, to: number): boolean => {
	const seen = new Set<number>();
	const stack = [from];
	while (stack.length > 0) {
		const at = stack.pop() as number;
		if (at === to) return true;
		if (seen.has(at)) continue;
		seen.add(at);
		for (const next of graph.get(at) ?? []) stack.push(next);
	}
	return false;
};

/** A cycle the requested edges would close, named end to end, or `null` when they close none. */
export const cycleFrom = (
	graph: WaitsOn,
	blockedByTargets: ReadonlyArray<number>,
	blocksTargets: ReadonlyArray<number>,
): {readonly waitsOn: number; readonly gates: number} | null => {
	for (const waitsOn of blockedByTargets) {
		for (const gates of blocksTargets) {
			// The new ticket waits on `waitsOn` and gates `gates`, so `gates -> new -> waitsOn` already
			// holds; a path from `waitsOn` back to `gates` — including the degenerate one where they are
			// the same ticket — closes the loop.
			if (waitsOn === gates || reaches(graph, waitsOn, gates)) return {waitsOn, gates};
		}
	}
	return null;
};

/** The ticket's title: the question verbatim, truncated on a word boundary. */
export const ticketTitle = (question: string): string => truncateOnWordBoundary(question.trim());

/** The ticket's body: the question, then the line binding it to its map. */
export const ticketBody = (question: string, map: number): string =>
	`${question.trim()}\n\nCharted on #${map}.\n`;
