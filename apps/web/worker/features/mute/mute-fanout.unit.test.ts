/**
 * The live-invalidation classification for the member-mute mutations (ADR 0155). A mute
 * masks only the muter's OWN reads, so it writes no fanned entity — `fanned: false`, on
 * the `post.save` per-viewer-private-relation precedent.
 */
import {assert, describe, it} from "@effect/vitest";
import {FANNED_MUTATIONS} from "../fate-live/fanned-mutations.ts";
import {mutations} from "./mutations.ts";

const rowFor = (key: string) => FANNED_MUTATIONS.find((entry) => entry.key === key);

describe("mute mutations — fanned classification (ADR 0155)", () => {
	for (const key of ["mute.set", "mute.remove"] as const) {
		it(`${key} is classified fanned: false with a rationale`, () => {
			const row = rowFor(key);
			assert.isDefined(row, `${key} must appear in the fanned-mutations manifest`);
			assert.strictEqual(
				row?.fanned,
				false,
				`${key} masks only the muter's own reads — not fanned`,
			);
			assert.isUndefined(row?.topics, `${key} declares no /fate/live topics (not fanned)`);
			assert.isTrue((row?.rationale.length ?? 0) > 0, `${key} carries a rationale`);
		});
	}

	it("every discovered mute mutation key has a manifest row (no drift)", () => {
		for (const key of Object.keys(mutations)) {
			assert.isDefined(rowFor(key), `mutation ${key} must be classified in fanned-mutations.ts`);
		}
	});
});
