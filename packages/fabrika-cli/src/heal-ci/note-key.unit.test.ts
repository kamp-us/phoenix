import {describe, expect, it} from "vitest";
import {HEAD, OTHER_HEAD} from "./fixtures.test-support.ts";
import {readMarker, renderMarker} from "./marker.ts";
import {keyBoundTo, keyOf, readKey, renderKey, withKey} from "./note-key.ts";

const KEY = keyOf(4321, "gated-unshipped", HEAD);

describe("the note key round-trips", () => {
	it("renders the key as one HTML comment and reads it back", () => {
		expect(renderKey(KEY)).toBe(`<!-- heal-ci-note key=4321:gated-unshipped:${HEAD} -->`);
		expect(readKey(renderKey(KEY))).toEqual(KEY);
	});

	it("reads a key that sits below the skill's fixed first line", () => {
		const body = withKey(
			`heal-ci: ROUTED — PR #4321 @ ${HEAD} → ship\n\nNobody is holding it.`,
			KEY,
		);
		expect(body.split("\n")[0]).toBe(`heal-ci: ROUTED — PR #4321 @ ${HEAD} → ship`);
		expect(readKey(body)).toEqual(KEY);
	});
});

describe("the note key is matched as a whole line, never a substring", () => {
	it("ignores a key quoted inside a human's reply", () => {
		expect(readKey(`> ${renderKey(KEY)}\n\nis this still true?`)).toBeNull();
		expect(readKey(`the bot wrote ${renderKey(KEY)} here`)).toBeNull();
	});

	it("refuses an abbreviated head — the key compares as full 40-hex equality", () => {
		expect(readKey("<!-- heal-ci-note key=4321:red:03135b91 -->")).toBeNull();
	});
});

describe("keyBoundTo suppresses on this key alone", () => {
	const carried = (body: string) => [{id: 7, body}];

	it("finds an exact key", () => {
		expect(keyBoundTo(carried(withKey("note", KEY)), KEY)).toEqual({id: 7});
	});

	it("does not match a changed class", () => {
		const other = keyOf(4321, "red", HEAD);
		expect(keyBoundTo(carried(withKey("note", other)), KEY)).toBeNull();
	});

	it("does not match a changed head", () => {
		const other = keyOf(4321, "gated-unshipped", OTHER_HEAD);
		expect(keyBoundTo(carried(withKey("note", other)), KEY)).toBeNull();
	});

	it("answers null on an empty history", () => {
		expect(keyBoundTo([], KEY)).toBeNull();
	});
});

/**
 * The disjointness the whole two-marker design rests on: a `RERUN-QUEUED` note names the same head at
 * the same moment as the rerun marker, so a matcher that read one as the other would refuse every
 * first rerun (`marker.ts`'s docblock) or suppress every note after one.
 */
describe("the two markers cannot read each other", () => {
	const rerun = renderMarker({head: HEAD, run: 9182736450, signature: "preview-warmup"});
	const rerunNote = withKey(
		`heal-ci: RERUN-QUEUED — PR #4321 @ ${HEAD} → nobody\n\nOne transient rerun at this head.`,
		keyOf(4321, "red", HEAD),
	);

	it("the rerun reader does not read a RERUN-QUEUED note as its marker", () => {
		expect(readMarker(rerunNote)).toBeNull();
	});

	it("the note-key reader does not read the rerun marker as a key", () => {
		expect(readKey(rerun)).toBeNull();
	});

	it("each reader still reads its own", () => {
		expect(readMarker(rerun)?.head).toBe(HEAD);
		expect(readKey(rerunNote)).toEqual(keyOf(4321, "red", HEAD));
	});
});
