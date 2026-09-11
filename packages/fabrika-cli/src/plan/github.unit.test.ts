/**
 * `listSubIssues` — the class each child link carries, off the same payload the states come from.
 *
 * Its own file because nothing tested this read before, and the class is the field with no symptom
 * when it goes missing: an unclassed child routes to the shells it always routed to, so a decode
 * that silently dropped `labels` would read as working.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply} from "../fakes.test-support.ts";
import {listSubIssues} from "./github.ts";

const ENV = {GITHUB_TOKEN: "t"} as Record<string, string | undefined>;
const SUB_ISSUES = /\/repos\/o\/r\/issues\/4300\/sub_issues/;

const page = (...children: ReadonlyArray<Record<string, unknown>>): HttpReply => ({
	status: 200,
	body: JSON.stringify(children),
});

const read = (reply: HttpReply) =>
	Effect.runPromise(
		Effect.provide(listSubIssues("o/r", 4300, ENV), fakeSeams([[SUB_ISSUES, reply]]).layer),
	);

const child = (number: number, labels: ReadonlyArray<string>): Record<string, unknown> => ({
	number,
	state: "open",
	state_reason: null,
	labels: labels.map((name) => ({name})),
});

describe("listSubIssues", () => {
	it("carries each child's class off the labels the payload already answers with", async () => {
		const links = await read(page(child(4301, ["type:bug", "class:ui"]), child(4302, ["p1"])));

		expect(links).toMatchObject({
			_tag: "Ok",
			value: [
				{number: 4301, classes: ["ui"]},
				{number: 4302, classes: []},
			],
		});
	});

	it("reads a payload with no labels key as unclassed rather than failing the whole list", async () => {
		const links = await read(page({number: 4301, state: "open", state_reason: null}));

		expect(links).toMatchObject({_tag: "Ok", value: [{number: 4301, classes: []}]});
	});
});
