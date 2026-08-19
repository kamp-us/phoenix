import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {readBoundary} from "./boundary.ts";
import {classify} from "./codeowners.ts";
import {CODEOWNERS} from "./fixtures.test-support.ts";

const OWNERS = /contents\/\.github\/CODEOWNERS/;
const CONFIG = /contents\/\.fabrika\.jsonc/;

const notFound = (): ExecResult => errOut("gh: Not Found (HTTP 404)");

const read = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(Effect.provide(readBoundary("o/r", "main"), fakeShell(script).layer));

describe("readBoundary", () => {
	it("parses a present boundary", async () => {
		const out = await read([[OWNERS, okOut(CODEOWNERS)]]);
		expect(out._tag).toBe("Rows");
		expect(out._tag === "Rows" && out.rows.length).toBeGreaterThan(0);
	});

	it("answers an empty row set on a proven 404 — which classifies as the `unknown` hold", async () => {
		const out = await read([[OWNERS, notFound()]]);
		expect(out._tag).toBe("Rows");
		expect(out._tag === "Rows" && out.rows).toEqual([]);
		expect(out._tag === "Rows" && classify(out.rows, [".github/workflows/ci.yml"])).toBe("unknown");
	});

	it("refuses a failed read — never `not-control-plane`, the fail-open collapse ADR 0220 §4 bans", async () => {
		const out = await read([[OWNERS, errOut("gh: server error (HTTP 500)")]]);
		expect(out._tag).toBe("Unreadable");
	});

	it("refuses a failed read whatever the repo's config says — no policy can waive the gate", async () => {
		const out = await read([
			[OWNERS, errOut("gh: server error (HTTP 500)")],
			[CONFIG, okOut('{"unreadableCodeowners": "ship"}')],
		]);
		expect(out._tag).toBe("Unreadable");
	});
});
