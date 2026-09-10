/**
 * `withoutLocalEchoes` on its own: which stored rows are the same turn as one the core already
 * recorded, and — the half that matters more — which are not.
 */

import {describe, expect, it} from "vitest";
import {assistantItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import type {TranscriptItem} from "../ports/index.ts";
import {withoutLocalEchoes} from "./local-turns.ts";

const local = (id: string, text: string): TranscriptItem => ({...userItem(id, text), local: true});
const ids = (items: ReadonlyArray<TranscriptItem>) => items.map((item) => item.id);

describe("withoutLocalEchoes", () => {
	it("drops the stored copy of a turn the tail holds locally", () => {
		const page = [userItem("store-1", "hello"), assistantItem("store-2", "hi")];
		expect(ids(withoutLocalEchoes(page, [local("local:k1", "hello")]))).toEqual(["store-2"]);
	});

	it("keeps a stored turn no local row names, which is every turn past the tail", () => {
		const page = [userItem("store-1", "older"), userItem("store-2", "hello")];
		expect(ids(withoutLocalEchoes(page, [local("local:k1", "hello")]))).toEqual(["store-1"]);
	});

	it("drops one stored row per local row, so a prompt sent twice stays two turns", () => {
		const page = [userItem("store-1", "again"), userItem("store-2", "again")];
		expect(ids(withoutLocalEchoes(page, [local("local:k2", "again")]))).toEqual(["store-1"]);
		expect(
			ids(withoutLocalEchoes(page, [local("local:k2", "again"), local("local:k3", "again")])),
		).toEqual([]);
	});

	it("drops the newest match first, so the oldest stored copy is the one that survives", () => {
		const page = [
			userItem("older", "again"),
			assistantItem("a1", "ok"),
			userItem("newer", "again"),
		];
		expect(ids(withoutLocalEchoes(page, [local("local:k2", "again")]))).toEqual(["older", "a1"]);
	});

	it("leaves a turn a layer already confirmed alone, since its local mark is gone", () => {
		const page = [userItem("store-1", "hello")];
		expect(ids(withoutLocalEchoes(page, [userItem("echoed-1", "hello")]))).toEqual(["store-1"]);
	});

	it("answers the page unchanged when the tail records nothing locally", () => {
		const page = [userItem("store-1", "hello"), assistantItem("store-2", "hi")];
		expect(withoutLocalEchoes(page, [assistantItem("live-1", "hi")])).toBe(page);
	});
});
