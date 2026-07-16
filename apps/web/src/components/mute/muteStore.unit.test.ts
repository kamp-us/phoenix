/**
 * The client muted-member overlay (#3117), tested off its pure reducer + the external-store
 * contract — no DOM (`apps/web/src` has no jsdom). Covers the immutable set transforms and
 * the subscribe/snapshot/notify behavior `useSyncExternalStore` relies on: a real change
 * swaps the snapshot reference and notifies; a no-op keeps it stable and stays silent.
 */
import {afterEach, assert, describe, it} from "@effect/vitest";
import {
	muteStoreSnapshot,
	resetMuteStore,
	setMemberMuted,
	subscribeMuteStore,
	withMember,
	withoutMember,
} from "./muteStore";

afterEach(() => resetMuteStore());

describe("muteStore pure set transforms", () => {
	it("withMember adds an id, returning a new set", () => {
		const base: ReadonlySet<string> = new Set(["a"]);
		const next = withMember(base, "b");
		assert.notStrictEqual(next, base);
		assert.deepStrictEqual([...next].sort(), ["a", "b"]);
		assert.deepStrictEqual([...base], ["a"]); // input untouched
	});

	it("withMember is identity when the id is already present", () => {
		const base: ReadonlySet<string> = new Set(["a"]);
		assert.strictEqual(withMember(base, "a"), base);
	});

	it("withoutMember removes an id, returning a new set", () => {
		const base: ReadonlySet<string> = new Set(["a", "b"]);
		const next = withoutMember(base, "a");
		assert.notStrictEqual(next, base);
		assert.deepStrictEqual([...next], ["b"]);
	});

	it("withoutMember is identity when the id is absent", () => {
		const base: ReadonlySet<string> = new Set(["a"]);
		assert.strictEqual(withoutMember(base, "z"), base);
	});
});

describe("muteStore external-store contract", () => {
	it("starts empty", () => {
		assert.strictEqual(muteStoreSnapshot().size, 0);
	});

	it("muting swaps the snapshot reference and notifies subscribers", () => {
		let notified = 0;
		const before = muteStoreSnapshot();
		const unsubscribe = subscribeMuteStore(() => {
			notified += 1;
		});

		setMemberMuted("user-1", true);

		assert.strictEqual(notified, 1);
		assert.notStrictEqual(muteStoreSnapshot(), before);
		assert.isTrue(muteStoreSnapshot().has("user-1"));
		unsubscribe();
	});

	it("a no-op mute (already muted) keeps the snapshot stable and stays silent", () => {
		setMemberMuted("user-1", true);
		let notified = 0;
		const unsubscribe = subscribeMuteStore(() => {
			notified += 1;
		});
		const snapshot = muteStoreSnapshot();

		setMemberMuted("user-1", true);

		assert.strictEqual(notified, 0);
		assert.strictEqual(muteStoreSnapshot(), snapshot);
		unsubscribe();
	});

	it("unmuting removes the id and notifies", () => {
		setMemberMuted("user-1", true);
		let notified = 0;
		const unsubscribe = subscribeMuteStore(() => {
			notified += 1;
		});

		setMemberMuted("user-1", false);

		assert.strictEqual(notified, 1);
		assert.isFalse(muteStoreSnapshot().has("user-1"));
		unsubscribe();
	});

	it("a stopped subscriber receives no further notifications", () => {
		let notified = 0;
		const unsubscribe = subscribeMuteStore(() => {
			notified += 1;
		});
		unsubscribe();

		setMemberMuted("user-2", true);

		assert.strictEqual(notified, 0);
	});
});
