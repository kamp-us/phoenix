/**
 * The two rules picking a session runs on, without a DOM: an open only ever reads, and the send
 * that creates the process happens once (epic #8070, ruling 2).
 */

import {describe, expect, it} from "vitest";
import type {SessionRow} from "../../protocol/session-list.ts";
import {openRead, send, TRANSCRIPT_PAGE_SIZE} from "./opening.ts";

const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({
	sessionId: "s-1",
	lastModified: 1_760_000_000_000,
	programId: "pi-session",
	backend: "pi",
	folder: "/picked/repo",
	...overrides,
});

describe("opening a row", () => {
	it("asks for one page of that session, from the newest end", () => {
		expect(openRead(row())).toEqual({
			_tag: "Read",
			read: {
				programId: "pi-session",
				sessionId: "s-1",
				cwd: "/picked/repo",
				before: null,
				limit: TRANSCRIPT_PAGE_SIZE,
			},
		});
	});

	it("walks older history with the cursor rather than asking for the whole transcript", () => {
		const older = openRead(row(), "m-4", 10);
		expect(older._tag === "Read" ? older.read.before : null).toBe("m-4");
		expect(older._tag === "Read" ? older.read.limit : null).toBe(10);
	});

	it("refuses a row the store filed under no folder rather than guessing one", () => {
		const {folder: _dropped, ...withoutFolder} = row();
		expect(openRead(withoutFolder)).toEqual({
			_tag: "OpenRefused",
			reason: "no-folder",
			session: withoutFolder,
		});
	});
});

describe("sending on an opened row", () => {
	it("creates exactly one process on the first send and none on the second", () => {
		const first = send("reading", row());
		expect(first.spawn).toEqual({programId: "pi-session", cwd: "/picked/repo", resume: "s-1"});
		expect(first.phase).toBe("live");

		const second = send(first.phase, row());
		expect(second.spawn).toBeNull();
		expect(second.phase).toBe("live");
	});

	it("spawns nothing for a row it could not open", () => {
		const {folder: _dropped, ...withoutFolder} = row();
		const plan = send("reading", withoutFolder);
		expect(plan.spawn).toBeNull();
		expect(plan.phase).toBe("reading");
		expect(plan.refused?.reason).toBe("no-folder");
	});
});
