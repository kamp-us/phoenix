/**
 * The page's answer to a frame it could not decode. It is a unit here rather than a branch only a
 * live socket reaches, because the thing worth proving is that the refusal is *said* — a reply frame
 * the page refused in silence is exactly how an authored spell's Void result looked like a spell
 * that never answered at all (#9365).
 */

import {Effect, Logger} from "effect";
import type {Socket} from "effect/unstable/socket";
import {describe, expect, it} from "vitest";
import {refuseFrame} from "./client.ts";
import {encodeFrame, SPELL_REPLY_KIND} from "./wire.ts";

interface Line {
	readonly level: string;
	readonly message: unknown;
}

const refusing = (text: string, reason: "not-json" | "unknown-kind" | "malformed-payload") =>
	Effect.suspend(() => {
		const lines: Array<Line> = [];
		const closed: Array<Socket.CloseEvent> = [];
		const capture = Logger.layer([
			Logger.make(({logLevel, message}) => {
				lines.push({level: logLevel, message});
			}),
		]);
		return refuseFrame(text, reason, (event) =>
			Effect.sync(() => {
				closed.push(event);
			}),
		).pipe(
			Effect.provide(capture),
			Effect.as({
				lines: lines as ReadonlyArray<Line>,
				closed: closed as ReadonlyArray<Socket.CloseEvent>,
			}),
		);
	});

describe("a frame the page cannot decode", () => {
	it("is logged with the kind it claimed and the reason, then closes the socket", async () => {
		const {lines, closed} = await Effect.runPromise(
			refusing(encodeFrame({kind: SPELL_REPLY_KIND, reply: {} as never}), "malformed-payload"),
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]?.level).toBe("Warn");
		const message = lines[0]?.message;
		const parts = Array.isArray(message) ? message : [message];
		expect(String(parts[0])).toContain("refused a frame");
		expect(parts[1]).toEqual({kind: SPELL_REPLY_KIND, reason: "malformed-payload"});

		expect(closed).toHaveLength(1);
		expect(closed[0]?.code).toBe(1008);
		expect(closed[0]?.reason).toContain("malformed-payload");
	});

	it("names `unknown` for a text that claims no kind, and never echoes the body back", async () => {
		const {lines} = await Effect.runPromise(refusing('{"secret": "hunter2"', "not-json"));
		const flat = JSON.stringify(lines);
		expect(flat).toContain('"kind":"unknown"');
		expect(flat).toContain('"reason":"not-json"');
		expect(flat).not.toContain("hunter2");
	});
});
