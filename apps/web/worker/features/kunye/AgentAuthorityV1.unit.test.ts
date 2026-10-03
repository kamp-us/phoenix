/**
 * `AgentAuthorityV1` is fail-closed: `admits` denies every agent input. The same seam
 * through the real rights is `Authorship.unit.test.ts`'s agent-arm case.
 */
import {type Agent, AgentAuthority} from "@kampus/authz";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {AgentAuthorityV1} from "./AgentAuthorityV1.ts";

const admitsVia = (request: {readonly agent: Agent; readonly capability: string}): boolean =>
	Effect.runSync(
		Effect.gen(function* () {
			const authority = yield* AgentAuthority;
			return yield* authority.admits(request);
		}).pipe(Effect.provide(AgentAuthorityV1)),
	);

describe("AgentAuthorityV1 — fail-closed admits", () => {
	it("denies every agent input, regardless of agent, root, or capability", () => {
		expect(
			admitsVia({agent: {_tag: "Agent", id: "bot", root: "yzr"}, capability: "kunye/OpenTerm"}),
		).toBe(false);
		expect(admitsVia({agent: {_tag: "Agent", id: "x", root: "vis"}, capability: "anything"})).toBe(
			false,
		);
	});
});
