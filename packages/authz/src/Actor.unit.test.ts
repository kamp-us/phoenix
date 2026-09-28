import {describe, expect, it} from "vitest";
import {agent, human, matchActor, unauthenticated} from "./Actor.ts";

const tag = (actor: Parameters<typeof matchActor<string>>[0]): string =>
	matchActor(actor, {
		onUnauthenticated: () => "anon",
		onHuman: (h) => `human:${h.id}`,
		onAgent: (a) => `agent:${a.id}@${a.root}`,
	});

describe("Actor", () => {
	it("constructs the three arms", () => {
		expect(unauthenticated).toEqual({_tag: "Unauthenticated"});
		expect(human("u1")).toEqual({_tag: "Authenticated", principal: {_tag: "Human", id: "u1"}});
		expect(agent("a1", "u1")).toEqual({
			_tag: "Authenticated",
			principal: {_tag: "Agent", id: "a1", root: "u1"},
		});
	});

	it("matchActor dispatches exhaustively over every arm", () => {
		expect(tag(unauthenticated)).toBe("anon");
		expect(tag(human("u1"))).toBe("human:u1");
		expect(tag(agent("a1", "u1"))).toBe("agent:a1@u1");
	});
});
