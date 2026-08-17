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
import {
	bindRange,
	contentDigest,
	contentDigestAt,
	judgedPaths,
	parseRaw,
	rangeContentAt,
	rangeDigestOnto,
	serializeContent,
} from "./content-binding.ts";
import {BASE, HEAD, OLD_HEAD, RAW, RAW_AT, RAW_ONTO} from "./fixtures.test-support.ts";

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

describe("the range scope", () => {
	const JUDGED = ["README.md", "src/cart.ts"] as const;
	const ONTO = RAW_ONTO(BASE, OLD_HEAD, ...JUDGED);

	const range = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
		Effect.runPromise(
			Effect.provide(rangeContentAt({base: BASE, tip: HEAD}), fakeShell(script).layer),
		);
	const onto = (script: ReadonlyArray<readonly [RegExp, ExecResult]>) =>
		Effect.runPromise(
			Effect.provide(rangeDigestOnto(BASE, OLD_HEAD, [...JUDGED]), fakeShell(script).layer),
		);

	it("names both sides of a rename, so the pathspec can still detect it", () => {
		const renamed = rows(record("R100", oid("a"), oid("b"), "src/new.ts", "src/old.ts"));
		expect(judgedPaths(renamed)).toEqual(["src/new.ts", "src/old.ts"]);
	});

	it("digests a range through the SAME serialization the PR scope uses", async () => {
		const out = await range([[RAW_AT(), okOut(RAW)]]);
		expect(out).toEqual({_tag: "Ok", value: {digest: digestOf(RAW), paths: JUDGED}});
	});

	it("FAILS on an empty range rather than binding a verdict to nothing", async () => {
		expect((await range([[RAW_AT(), okOut("")]]))._tag).toBe("Failure");
	});

	it("re-derives from a later state over the judged paths only", async () => {
		expect(await onto([[ONTO, okOut(RAW)]])).toEqual({_tag: "Digest", digest: digestOf(RAW)});
	});

	it("tells a state that carries none of the judged change from one it could not read", async () => {
		expect(await onto([[ONTO, okOut("")]])).toEqual({_tag: "Unchanged"});
		expect((await onto([[ONTO, okOut("src/cart.ts\0")]]))._tag).toBe("Unreadable");
	});
});

describe("bindRange", () => {
	const CLAIMED = "7af166f42fdb";

	it("is Current only when the state re-derives the claimed digest", () => {
		expect(bindRange({content: CLAIMED}, {_tag: "Digest", digest: CLAIMED})).toEqual({
			_tag: "Current",
			digest: CLAIMED,
		});
	});

	it("is Stale when the state derives a different digest", () => {
		expect(bindRange({content: CLAIMED}, {_tag: "Digest", digest: "0123456789ab"})).toEqual({
			_tag: "Stale",
			claimed: CLAIMED,
			found: "0123456789ab",
		});
	});

	it("is Stale, not Unbindable, when the state carries none of the judged change", () => {
		expect(bindRange({content: CLAIMED}, {_tag: "Unchanged"})._tag).toBe("Stale");
	});

	/**
	 * The non-folding ADR 0276 turns on: a derivation that could not be made is UNKNOWN. Read as
	 * `Current` it would ship an unverifiable verdict; read as `Stale` it would name the wrong cause
	 * and send an operator to re-review instead of to a broken checkout.
	 */
	it("is Unbindable when the derivation could not be made", () => {
		const out = bindRange({content: CLAIMED}, {_tag: "Unreadable", reason: "no merge base"});
		expect(out._tag).toBe("Unbindable");
	});

	it("is Unbindable on a claim that is not a digest — never a comparison against a typo", () => {
		expect(bindRange({content: "nope"}, {_tag: "Digest", digest: CLAIMED})._tag).toBe("Unbindable");
	});
});
