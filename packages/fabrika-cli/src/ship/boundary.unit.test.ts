import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeHttp, fakeShell, type HttpReply} from "../fakes.test-support.ts";
import {readBoundary} from "./boundary.ts";
import {classify} from "./codeowners.ts";
import {CODEOWNERS} from "./fixtures.test-support.ts";

const OWNERS = /contents\/\.github\/CODEOWNERS/;

const read = (script: ReadonlyArray<readonly [RegExp, HttpReply]>) =>
	Effect.runPromise(
		Effect.provide(
			readBoundary("o/r", "main"),
			Layer.merge(fakeShell([]).layer, fakeHttp(script).layer),
		),
	);

describe("readBoundary", () => {
	it("parses a present boundary", async () => {
		const out = await read([[OWNERS, {status: 200, body: CODEOWNERS}]]);
		expect(out._tag).toBe("Rows");
		expect(out._tag === "Rows" && out.rows.length).toBeGreaterThan(0);
	});

	it("answers an empty row set on a proven 404 — which classifies as the `unknown` hold", async () => {
		const out = await read([[OWNERS, {status: 404, body: '{"message":"Not Found"}'}]]);
		expect(out._tag).toBe("Rows");
		expect(out._tag === "Rows" && out.rows).toEqual([]);
		expect(out._tag === "Rows" && classify(out.rows, [".github/workflows/ci.yml"])).toBe("unknown");
	});

	it("refuses a failed read — never `not-control-plane`, the fail-open collapse ADR 0220 §4 bans", async () => {
		const out = await read([[OWNERS, {status: 500, body: '{"message":"server error"}'}]]);
		expect(out._tag).toBe("Unreadable");
	});

	it("refuses a transport fault too — never reached is not the same as answered", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				readBoundary("o/r", "main"),
				Layer.merge(fakeShell([]).layer, fakeHttp([], undefined, [OWNERS]).layer),
			),
		);
		expect(out._tag).toBe("Unreadable");
	});
});
