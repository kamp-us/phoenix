/**
 * The chat window's running-list model over a real Claude background spawn, which is the shape it
 * used to draw nothing for (#9506).
 *
 * Synthetic slots prove what the list does with a slot (`@kampus/tuval-ui`'s own
 * `subagents.unit.test.ts`); only the captured frames prove there is a slot to draw. So this folds
 * `background-subagent-turn.json` through the same mapping and core the window's process runs and
 * asks the list after every frame. It lives beside Claude's window because the capture is Claude's.
 */

import {foldEvent} from "@kampus/tuval-sdk/kernel/ai-agent/core/fold";
import {initialState, settleTurn} from "@kampus/tuval-sdk/kernel/ai-agent/core/state";
import {runningSubagents} from "@kampus/tuval-ui/chat";
import {describe, expect, it} from "vitest";
import {fixtureEventFrames} from "../history/fixtures/events.ts";

describe("runningSubagents over a captured background spawn", () => {
	const SPAWN = "toolu_000000000000000000000001";

	/** The list model after each frame in turn, folded exactly as the live session folds it. */
	const perFrame = () => {
		const seen: Array<ReturnType<typeof runningSubagents>> = [];
		let state = initialState("/repo");
		for (const events of fixtureEventFrames("background-subagent-turn", {at: 1_700_000_000_000})) {
			state = events.reduce((carried, event) => foldEvent(carried, event, {}), state);
			seen.push(runningSubagents(state.subagents));
		}
		return seen;
	};

	it("draws the worker's row for every frame between the launch answer and the notification", () => {
		const seen = perFrame();
		expect(seen).toHaveLength(3);
		for (const model of seen.slice(0, 2)) {
			expect(model.rows.map((row) => row.id)).toEqual([SPAWN]);
			expect(model.rows[0]).toMatchObject({type: "Explore", status: "running", current: false});
			expect(model.more).toBe(0);
		}
	});

	it("drops the row once the notification ends the worker (Q2)", () => {
		expect(perFrame().at(-1)).toEqual({rows: [], more: 0});
	});

	/**
	 * The row the desk check actually lost: the launch answer arrives seconds into a two-minute
	 * worker, and the parent's turn ends right behind it — so the list was empty for the whole run
	 * even after the mapper stopped ending the slot (#9587).
	 */
	it("still draws the row after the turn that launched the worker has settled under it", () => {
		let state = initialState("/repo");
		for (const events of fixtureEventFrames("background-subagent-turn", {
			at: 1_700_000_000_000,
		}).slice(0, 2)) {
			state = events.reduce((carried, event) => foldEvent(carried, event, {}), state);
		}
		const settled = settleTurn(state);
		expect(runningSubagents(settled.subagents).rows.map((row) => row.id)).toEqual([SPAWN]);
		expect(settled.subagents[SPAWN]?.status).toBe("running");
	});
});
