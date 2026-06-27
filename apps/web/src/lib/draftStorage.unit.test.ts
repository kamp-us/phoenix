import {describe, expect, it} from "vitest";
import {clearDraft, draftKey, readDraft, writeDraft} from "./draftStorage";

function fakeStorage(initial?: Record<string, string>): Storage {
	const map = new Map<string, string>(Object.entries(initial ?? {}));
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (k) => map.get(k) ?? null,
		key: (i) => [...map.keys()][i] ?? null,
		removeItem: (k) => void map.delete(k),
		setItem: (k, v) => void map.set(k, v),
	};
}

interface PanoDraft {
	mode: "link" | "text";
	url: string;
	title: string;
	body: string;
	tags: string[];
}

function isPanoDraft(value: unknown): value is PanoDraft {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		(v.mode === "link" || v.mode === "text") &&
		typeof v.url === "string" &&
		typeof v.title === "string" &&
		typeof v.body === "string" &&
		Array.isArray(v.tags) &&
		v.tags.every((t) => typeof t === "string")
	);
}

describe("draftStorage", () => {
	it("keys drafts by route so two surfaces never collide", () => {
		expect(draftKey("/pano/yeni")).not.toBe(draftKey("/sozluk/effect"));
		expect(draftKey("/pano/yeni")).toContain("/pano/yeni");
	});

	it("survives the signed-out → auth-redirect → return round-trip, then clears on submit (AC1+AC2)", () => {
		// One Storage stands in for localStorage across the whole journey: it persists
		// while the form unmounts during the auth redirect and remounts on return.
		const storage = fakeStorage();
		const route = "/sozluk/effect";

		// 1. The signed-out user types a definition. Autosave persists it as they write.
		const typed: PanoDraft = {
			mode: "text",
			url: "",
			title: "",
			body: "effect, kuru tanımın ötesinde bir deneyim.",
			tags: [],
		};
		writeDraft(storage, route, typed);

		// 2. They hit submit, are bounced to /auth, sign in, and are returned — the form
		//    component fully remounts. The persisted draft is still there to OFFER.
		const offered = readDraft(storage, route, isPanoDraft);
		expect(offered).toEqual(typed); // restorable — NOT lost across the round-trip

		// 3. They restore it and submit successfully → the draft clears.
		clearDraft(storage, route);
		expect(readDraft(storage, route, isPanoDraft)).toBeNull();
	});

	it("offers nothing when storage is empty", () => {
		expect(readDraft(fakeStorage(), "/pano/yeni", isPanoDraft)).toBeNull();
	});

	it("offers nothing for a draft saved under a different route", () => {
		const storage = fakeStorage();
		writeDraft(storage, "/sozluk/effect", {mode: "text", url: "", title: "", body: "x", tags: []});
		expect(readDraft(storage, "/pano/yeni", isPanoDraft)).toBeNull();
	});

	it("rejects a garbage / shape-mismatched stored value rather than offering it", () => {
		const storage = fakeStorage({[draftKey("/pano/yeni")]: "{not json"});
		expect(readDraft(storage, "/pano/yeni", isPanoDraft)).toBeNull();
		const bad = fakeStorage({[draftKey("/pano/yeni")]: JSON.stringify({mode: "carrier"})});
		expect(readDraft(bad, "/pano/yeni", isPanoDraft)).toBeNull();
	});

	it("falls back (never throws) when storage is unavailable", () => {
		expect(readDraft(undefined, "/pano/yeni", isPanoDraft)).toBeNull();
		expect(() => writeDraft(undefined, "/pano/yeni", {mode: "link"})).not.toThrow();
		expect(() => clearDraft(undefined, "/pano/yeni")).not.toThrow();
	});

	it("swallows a throwing storage rather than losing the in-memory draft", () => {
		const broken: Storage = {
			...fakeStorage(),
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		expect(readDraft(broken, "/pano/yeni", isPanoDraft)).toBeNull();
		expect(() => writeDraft(broken, "/pano/yeni", {mode: "link"})).not.toThrow();
		expect(() => clearDraft(broken, "/pano/yeni")).not.toThrow();
	});
});
