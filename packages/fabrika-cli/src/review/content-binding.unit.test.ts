/**
 * The content digest's own tier: the `--raw` walk, the serialization, and the two legs ADR 0276
 * rules the digest must cover.
 *
 * The assertions that carry the design are the two `changes the digest` cases. A digest that moved
 * only when the destination blob moved would miss a head that drops its own edit onto a base that
 * already made it; a digest that moved only when the diff moved would miss the merge that leaves
 * the three-dot diff identical and the merged file different. Both are what the ruling is about, so
 * both are asserted from a fixture rather than argued in a comment.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {contentDigest, contentDigestAt, parseRaw, serializeContent} from "./content-binding.ts";
import {BASE, HEAD, RAW, RAW_AT} from "./fixtures.test-support.ts";

const oid = (letter: string) => letter.repeat(40);

const record = (status: string, src: string, dst: string, path: string, from?: string) =>
	from === undefined
		? `:100644 100644 ${src} ${dst} ${status}\0${path}\0`
		: `:100644 100644 ${src} ${dst} ${status}\0${from}\0${path}\0`;

const rows = (stream: string) => {
	const parsed = parseRaw(stream);
	if (typeof parsed === "string") throw new Error(`expected records, got: ${parsed}`);
	return parsed;
};

const digestOf = (stream: string) => contentDigest(rows(stream));

describe("parseRaw", () => {
	it("reads one record per changed path, keeping git's own change letter", () => {
		expect(rows(RAW)).toEqual([
			{
				status: "M",
				srcMode: "100644",
				dstMode: "100644",
				srcOid: oid("a"),
				dstOid: oid("b"),
				srcPath: null,
				path: "src/cart.ts",
			},
			{
				status: "M",
				srcMode: "100644",
				dstMode: "100644",
				srcOid: oid("c"),
				dstOid: oid("d"),
				srcPath: null,
				path: "README.md",
			},
		]);
	});

	it("walks a rename's THREE fields, so the record after it is not shifted by one", () => {
		const stream =
			record("R100", oid("a"), oid("b"), "src/new.ts", "src/old.ts") +
			record("M", oid("c"), oid("d"), "README.md");
		expect(rows(stream)).toHaveLength(2);
		expect(rows(stream)[0]).toMatchObject({srcPath: "src/old.ts", path: "src/new.ts"});
		expect(rows(stream)[1]).toMatchObject({srcPath: null, path: "README.md"});
	});

	it("refuses a stream it cannot fully account for rather than digesting a partial one", () => {
		expect(parseRaw("src/cart.ts\0")).toContain("not a");
		expect(parseRaw(record("M", oid("a"), oid("b"), "").replace("\0\0", "\0"))).toContain("path");
	});

	it("reads an empty stream as zero records, never as a refusal", () => {
		expect(rows("")).toEqual([]);
	});
});

describe("the digest covers both legs ADR 0276 names", () => {
	it("moves when the RESULTING content of a changed file moves, the diff aside", () => {
		const before = record("M", oid("a"), oid("b"), "src/cart.ts");
		const after = record("M", oid("a"), oid("e"), "src/cart.ts");
		expect(digestOf(after)).not.toBe(digestOf(before));
	});

	it("moves when the BASE side of a changed file moves, the resulting content aside", () => {
		const before = record("M", oid("a"), oid("b"), "src/cart.ts");
		const after = record("M", oid("f"), oid("b"), "src/cart.ts");
		expect(digestOf(after)).not.toBe(digestOf(before));
	});

	it("moves when a path enters or leaves the range", () => {
		const one = record("M", oid("a"), oid("b"), "src/cart.ts");
		expect(digestOf(one + record("A", oid("0"), oid("c"), "README.md"))).not.toBe(digestOf(one));
	});

	it("does NOT move when the same two trees are read in a different order", () => {
		const first = record("M", oid("a"), oid("b"), "src/cart.ts");
		const second = record("M", oid("c"), oid("d"), "README.md");
		expect(digestOf(first + second)).toBe(digestOf(second + first));
	});

	it("is 12 lowercase hex, the one shape the marker field accepts", () => {
		expect(digestOf(RAW)).toMatch(/^[0-9a-f]{12}$/);
	});

	it("serializes one line per record, so a reader can re-derive the input by hand", () => {
		expect(serializeContent(rows(RAW)).split("\n")).toHaveLength(2);
	});
});

describe("contentDigestAt", () => {
	const run = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
		Effect.runPromise(Effect.provide(contentDigestAt(BASE, HEAD), fakeShell(script).layer));

	it("digests the bound range's raw stream", async () => {
		const out = await run([[RAW_AT(), okOut(RAW)]]);
		expect(out).toEqual({_tag: "Ok", value: digestOf(RAW)});
	});

	it("FAILS on an empty range rather than minting one value every empty PR would share", async () => {
		const out = await run([[RAW_AT(), okOut("")]]);
		expect(out._tag).toBe("Failure");
	});

	it("FAILS on an unreadable stream rather than digesting what it could parse", async () => {
		const out = await run([[RAW_AT(), okOut("src/cart.ts\0")]]);
		expect(out._tag).toBe("Failure");
	});
});
