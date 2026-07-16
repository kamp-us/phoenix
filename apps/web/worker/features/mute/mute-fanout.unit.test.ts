/**
 * The live-invalidation classification for the member-mute mutations (#3112, ADR
 * 0155). A mute masks only the muter's OWN reads (the read-mask is a sibling), so it
 * writes no Post/Comment/Definition in a subscribed cross-client connection — it is
 * `fanned: false`, the `post.save` per-viewer-private-relation precedent. This pins
 * two things the classification asserts:
 *
 *   1. `mute.set` / `mute.remove` are declared in the manifest as `fanned: false`,
 *      each with a rationale — so `fanout-guard`'s drift invariant passes and the
 *      conscious not-fanned decision is recorded (`fanned-mutations.ts`).
 *   2. The write path carries NO cross-viewer publish: the resolved mutation depends
 *      on no `LivePublisher`, so muting/unmuting can never fan an invalidation to
 *      another viewer's live view — exactly "the muter's own affected views, not a
 *      cross-viewer fan". The muter's own live views re-mask once the read-mask
 *      sibling lands; there is no subscribed connection to invalidate in this slice.
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
