/**
 * The exit ask's contract (#7044). The load-bearing half is that the audience is read
 * off the declared capability floors, not off a tier literal: every assertion about who
 * is asked is written against `AUTHORSHIP_FLOORS` / `authorshipLadder`, so moving a
 * floor moves the test with the code instead of leaving a stale constant green.
 */
import {describe, expect, it} from "vitest";
import {
	AUTHORSHIP_FLOORS,
	holdsAuthorshipRight,
} from "../../../worker/features/kunye/authorshipFloors";
import {authorshipLadder, type Tier} from "../../../worker/features/kunye/standing";
import {
	dismissFirstContribution,
	firstContributionNudge,
	isFirstContributionDismissed,
	NUDGE_RIGHT,
	SETTLED_RIGHT,
	sozlukTermContext,
} from "./firstContribution";

interface MemoryStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function storageOver(store: Map<string, string>): MemoryStorage {
	return {getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v)};
}

function memoryStorage(): MemoryStorage & {readonly store: Map<string, string>} {
	const store = new Map<string, string>();
	return {...storageOver(store), store};
}

const ask = (tier: Tier | null | undefined, returnTo = "/pano", dismissed = false) =>
	firstContributionNudge({tier, returnTo, dismissed});

describe("firstContributionNudge — the audience, derived from the declared floors", () => {
	it("asks exactly the ranks that clear the add-entry floor without clearing the settled one", () => {
		for (const tier of authorshipLadder.order) {
			const expected =
				holdsAuthorshipRight(tier, NUDGE_RIGHT) && !holdsAuthorshipRight(tier, SETTLED_RIGHT);
			expect(ask(tier) !== null, `tier ${tier}`).toBe(expected);
		}
	});

	it("asks the rank sitting at the add-entry floor — today's çaylak", () => {
		expect(ask(AUTHORSHIP_FLOORS[NUDGE_RIGHT])).not.toBeNull();
	});

	it("never asks a rank at or above the open-term floor — today's yazar", () => {
		for (const tier of authorshipLadder.order) {
			if (!authorshipLadder.gte(tier, AUTHORSHIP_FLOORS[SETTLED_RIGHT])) continue;
			expect(ask(tier), `tier ${tier}`).toBeNull();
		}
	});

	it("never suggests opening a başlık — both branches exercise the add-entry right only", () => {
		const kinds = new Set(
			authorshipLadder.order
				.flatMap((tier) => [ask(tier), ask(tier, "/sozluk/monad")])
				.flatMap((nudge) => (nudge ? [nudge.kind] : [])),
		);
		expect([...kinds].sort()).toEqual(["add-entry", "browse-sozluk"]);
		expect(NUDGE_RIGHT).not.toBe(SETTLED_RIGHT);
	});

	it("has no ask for an unknown tier — an unread standing is not a çaylak", () => {
		expect(ask(null)).toBeNull();
		expect(ask(undefined)).toBeNull();
	});

	it("has no ask once dismissed, whatever the arrival", () => {
		const tier = AUTHORSHIP_FLOORS[NUDGE_RIGHT];
		expect(ask(tier, "/sozluk/monad", true)).toBeNull();
		expect(ask(tier, "/pano", true)).toBeNull();
	});
});

describe("firstContributionNudge — the suggestion the arrival earns", () => {
	const caylak = AUTHORSHIP_FLOORS[NUDGE_RIGHT];

	it("points a başlık arrival at that başlık", () => {
		expect(ask(caylak, "/sozluk/monad")).toEqual({
			kind: "add-entry",
			to: "/sozluk/monad",
			term: "monad",
		});
	});

	it("points an entry arrival at its başlık — entries live on the başlık's page", () => {
		expect(ask(caylak, "/sozluk/monad?definition=d-1#d-1")).toEqual({
			kind: "add-entry",
			to: "/sozluk/monad",
			term: "monad",
		});
	});

	it("renders a multi-word slug the way the başlık page renders its own title", () => {
		expect(ask(caylak, "/sozluk/yan-etki")).toMatchObject({term: "yan etki"});
	});

	it("falls back to sözlük browse-and-add for a cold arrival", () => {
		for (const cold of ["/", "/pano", "/pano/42", "/sozluk", "/bildirimler"]) {
			expect(ask(caylak, cold), cold).toEqual({kind: "browse-sozluk", to: "/sozluk"});
		}
	});

	it("falls back rather than trust an off-site arrival — `safeReturnTo` still guards", () => {
		expect(ask(caylak, "//evil.example/sozluk/monad")).toEqual({
			kind: "browse-sozluk",
			to: "/sozluk",
		});
	});
});

describe("firstContribution dismissal — the per-account marker", () => {
	it("starts undismissed and reads back dismissed", () => {
		const storage = memoryStorage();
		expect(isFirstContributionDismissed(storage, "u-1")).toBe(false);
		dismissFirstContribution(storage, "u-1");
		expect(isFirstContributionDismissed(storage, "u-1")).toBe(true);
	});

	it("survives a fresh handle over the same backing store — a reload re-reads it", () => {
		const before = memoryStorage();
		dismissFirstContribution(before, "u-1");
		expect(isFirstContributionDismissed(storageOver(before.store), "u-1")).toBe(true);
	});

	it("keys by account, so a second account on the same browser is still asked", () => {
		const storage = memoryStorage();
		dismissFirstContribution(storage, "u-1");
		expect(isFirstContributionDismissed(storage, "u-2")).toBe(false);
	});

	it("does not collide with the welcome's own shown-once marker", () => {
		const storage = memoryStorage();
		dismissFirstContribution(storage, "u-1");
		expect([...storage.store.keys()].some((k) => k.startsWith("welcome-seen:"))).toBe(false);
	});

	it("no storage or no account degrades to undismissed, and writing is a no-op", () => {
		expect(isFirstContributionDismissed(null, "u-1")).toBe(false);
		expect(isFirstContributionDismissed(memoryStorage(), null)).toBe(false);
		expect(() => dismissFirstContribution(null, "u-1")).not.toThrow();
	});

	it("a refusing storage degrades instead of throwing through the arrival", () => {
		const refusing: MemoryStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(() => dismissFirstContribution(refusing, "u-1")).not.toThrow();
	});
});

describe("sozlukTermContext", () => {
	it("reads the başlık out of a sözlük path and nothing else", () => {
		expect(sozlukTermContext("/sozluk/monad")).toEqual({to: "/sozluk/monad", term: "monad"});
		expect(sozlukTermContext("/sozluk")).toBeNull();
		expect(sozlukTermContext("/sozluk/")).toBeNull();
		expect(sozlukTermContext("/pano/1")).toBeNull();
	});

	it("keeps the encoded slug in the link while decoding it for the label", () => {
		expect(sozlukTermContext("/sozluk/g%C3%B6z")).toEqual({
			to: "/sozluk/g%C3%B6z",
			term: "göz",
		});
	});
});
