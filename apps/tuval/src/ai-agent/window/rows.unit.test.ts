/**
 * The three things a session row is judged on, without a DOM: the order they come in, what a row
 * says when the store said nothing, and what the filter box matches.
 */

import {describe, expect, it} from "vitest";
import type {SessionRow} from "../../protocol/session-list.ts";
import {bareSession, claudeSession, NOW, piSession, scrambled} from "./fixtures.ts";
import {
	lastModifiedLabel,
	matchesQuery,
	NO_FIRST_PROMPT,
	newestFirst,
	rowValue,
	sessionDescription,
	sessionItems,
} from "./rows.ts";

describe("newestFirst", () => {
	it("puts the most recently modified session first", () => {
		expect(newestFirst(scrambled).map((session) => session.sessionId)).toEqual([
			"c-1",
			"p-1",
			"b-1",
		]);
	});

	it("leaves the caller's list alone", () => {
		const given = [...scrambled];
		newestFirst(given);
		expect(given).toEqual(scrambled);
	});

	it("makes no origin split — one backend's session sorts against another's", () => {
		const [first, second] = newestFirst([bareSession, claudeSession]);
		expect([first?.backend, second?.backend]).toEqual(["claude-session", "pi-session"]);
	});
});

describe("rowValue", () => {
	it("keys on backend and id together, so two stores may share one session id", () => {
		const twin: SessionRow = {...piSession, sessionId: claudeSession.sessionId};
		expect(rowValue(twin)).not.toBe(rowValue(claudeSession));
	});
});

describe("sessionDescription", () => {
	it("carries last modified, folder, branch, message count and the backend tag", () => {
		expect(sessionDescription(claudeSession, NOW)).toBe(
			"1 hour ago · /Users/founder/code/phoenix · epic/8070 · 42 messages · claude-session",
		);
	});

	it("drops a field the backend did not supply rather than inventing one", () => {
		const line = sessionDescription(bareSession, NOW);
		expect(line).toBe("3 hours ago · pi-session");
		expect(line).not.toContain("0 messages");
	});

	it("counts one message as one", () => {
		expect(sessionDescription(piSession, NOW)).toContain("1 message ·");
	});
});

describe("sessionItems", () => {
	it("says an absent first prompt out loud, because a label cannot be dropped", () => {
		const items = sessionItems([bareSession], NOW);
		expect(items[0]?.label).toBe(NO_FIRST_PROMPT);
	});

	it("labels a session the store did name with that prompt", () => {
		expect(sessionItems([claudeSession], NOW)[0]?.label).toBe("Wire the session list window");
	});
});

describe("lastModifiedLabel", () => {
	it("scales its unit to the gap", () => {
		expect(lastModifiedLabel(NOW - 30_000, NOW)).toBe("30 seconds ago");
		expect(lastModifiedLabel(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
		expect(lastModifiedLabel(NOW - 4 * 86_400_000, NOW)).toBe("4 days ago");
		// `numeric: "auto"` prefers the word where English has one, which is what a person reads.
		expect(lastModifiedLabel(NOW - 400 * 86_400_000, NOW)).toBe("last year");
	});
});

describe("matchesQuery", () => {
	it("matches the first prompt", () => {
		expect(matchesQuery(claudeSession, "session list")).toBe(true);
		expect(matchesQuery(piSession, "session list")).toBe(false);
	});

	it("matches the folder", () => {
		expect(matchesQuery(piSession, "demlik")).toBe(true);
		expect(matchesQuery(claudeSession, "demlik")).toBe(false);
	});

	it("matches the branch", () => {
		expect(matchesQuery(claudeSession, "epic/80")).toBe(true);
		expect(matchesQuery(piSession, "epic/80")).toBe(false);
	});

	it("ignores case", () => {
		expect(matchesQuery(claudeSession, "WIRE THE")).toBe(true);
	});

	it("keeps every session while the box is empty", () => {
		expect(scrambled.every((session) => matchesQuery(session, "   "))).toBe(true);
	});

	it("does not match the backend tag — typing a backend name is not a way to group by it", () => {
		expect(matchesQuery(piSession, "pi-session")).toBe(false);
	});

	it("matches nothing on a session whose store supplied none of the three fields", () => {
		expect(matchesQuery(bareSession, "b-1")).toBe(false);
	});
});
