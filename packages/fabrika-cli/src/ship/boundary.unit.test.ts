import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {cpStateOf, readBoundary} from "./boundary.ts";
import {CODEOWNERS} from "./fixtures.test-support.ts";

const OWNERS = /contents\/\.github\/CODEOWNERS/;
const CONFIG = /contents\/\.fabrika\.jsonc/;

const notFound = (): ExecResult => errOut("gh: Not Found (HTTP 404)");

const read = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
	Effect.runPromise(Effect.provide(readBoundary("o/r", "main"), fakeShell(script).layer));

describe("readBoundary", () => {
	it("parses a present boundary", async () => {
		const out = await read([[OWNERS, okOut(CODEOWNERS)]]);
		expect(out._tag).toBe("Boundary");
		expect(out._tag === "Boundary" && out.boundary._tag).toBe("Rows");
	});

	it("answers Absent on a proven 404 — never an empty row set the hold would swallow", async () => {
		const out = await read([[OWNERS, notFound()]]);
		expect(out._tag === "Boundary" && out.boundary._tag).toBe("Absent");
	});

	it("waives an unreadable boundary when the repo declares no policy — the shipped default", async () => {
		const out = await read([
			[OWNERS, errOut("gh: server error (HTTP 500)")],
			[CONFIG, notFound()],
		]);
		expect(out._tag === "Boundary" && out.boundary._tag).toBe("Waived");
	});

	it("refuses an unreadable boundary when the repo declares `refuse`", async () => {
		const out = await read([
			[OWNERS, errOut("gh: server error (HTTP 500)")],
			[CONFIG, okOut('{"unreadableCodeowners": "refuse"}')],
		]);
		expect(out._tag).toBe("Refused");
		expect(out._tag === "Refused" && out.what).toBe("the §CP boundary");
	});

	it("refuses when the POLICY itself could not be read — a policy nobody read waives nothing", async () => {
		const out = await read([
			[OWNERS, errOut("gh: server error (HTTP 500)")],
			[CONFIG, errOut("gh: server error (HTTP 500)")],
		]);
		expect(out._tag).toBe("Refused");
		expect(out._tag === "Refused" && out.what).toContain(".fabrika.jsonc");
	});

	it("refuses on a policy value off the vocabulary rather than falling back to the default", async () => {
		const out = await read([
			[OWNERS, errOut("gh: server error (HTTP 500)")],
			[CONFIG, okOut('{"unreadableCodeowners": "yes"}')],
		]);
		expect(out._tag).toBe("Refused");
	});

	it("never reads the policy at all when the boundary read succeeded", async () => {
		const out = await read([[OWNERS, okOut(CODEOWNERS)]]);
		expect(out._tag).toBe("Boundary");
	});
});

describe("cpStateOf", () => {
	it("resolves an absent boundary to not-control-plane — the PR ships (#5603 comment 8)", () => {
		expect(cpStateOf({_tag: "Absent"}, [".github/workflows/ci.yml"])).toBe("not-control-plane");
	});

	it("resolves a waived boundary the same way, and the reason still travels", () => {
		expect(cpStateOf({_tag: "Waived", reason: "500"}, [".github/workflows/ci.yml"])).toBe(
			"not-control-plane",
		);
	});
});
