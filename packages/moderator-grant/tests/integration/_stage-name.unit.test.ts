/**
 * Stage-name invariants — the pure core of `_d1.ts`'s isolated-stage derivation,
 * asserted without a deploy. Pins the contract real remote D1 relies on: the name is
 * `[a-z0-9-]` only, no leading/trailing dash, no internal `--`, non-empty, ≤ MAX_STAGE_LEN,
 * and run-unique (two runs of the same file get distinct names so they can't collide
 * on the shared Cloudflare account).
 */
import {assert, describe, it} from "@effect/vitest";
import {DISC_LEN, disc, MAX_STAGE_LEN, slugify, stageName} from "./_stage-name.ts";

const LEGAL = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("slugify", () => {
	it("maps to [a-z0-9-] with no leading/trailing dash", () => {
		assert.strictEqual(slugify("Grant.Test"), "grant-test");
		assert.strictEqual(slugify("__weird__name!!"), "weird-name");
		assert.strictEqual(slugify("ALLCAPS"), "allcaps");
	});
});

describe("disc", () => {
	it("is a fixed-width [a-z0-9] discriminator, deterministic per seed", () => {
		const d = disc("grant|run-1");
		assert.strictEqual(d.length, DISC_LEN);
		assert.match(d, /^[a-z0-9]+$/);
		assert.strictEqual(disc("grant|run-1"), d);
		assert.notStrictEqual(disc("grant|run-2"), d);
	});
});

describe("stageName", () => {
	it("NO_DESTROY yields a stable it-<slug> (re-adoptable by name)", () => {
		assert.strictEqual(stageName("grant", true, "run-1"), "it-grant");
		assert.strictEqual(stageName("grant", true, "run-2"), "it-grant");
	});

	it("destroy-on yields a run-unique, legal, length-bounded name", () => {
		const a = stageName("grant", false, "run-1");
		const b = stageName("grant", false, "run-2");
		assert.notStrictEqual(a, b); // distinct across runs
		for (const name of [a, b]) {
			assert.match(name, LEGAL);
			assert.isAtMost(name.length, MAX_STAGE_LEN);
			assert.isAbove(name.length, 0);
		}
	});

	it("a punctuation-only / empty slug still yields a legal non-empty name", () => {
		for (const name of [
			stageName("", false, "r"),
			stageName("", true, "r"),
			stageName("---", false, "r"),
		]) {
			assert.match(name, LEGAL);
			assert.isAbove(name.length, 0);
		}
	});

	it("a long slug is truncated to stay ≤ MAX_STAGE_LEN", () => {
		const name = stageName("a".repeat(80), false, "run-1");
		assert.isAtMost(name.length, MAX_STAGE_LEN);
		assert.match(name, LEGAL);
	});
});
