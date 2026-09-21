import {assert, describe, it} from "@effect/vitest";
import {RelationStore} from "@kampus/authz";
import {Effect, Layer} from "effect";
import {Kunye} from "../kunye/Kunye.ts";
import {Pasaport, type UserRow} from "../pasaport/Pasaport.ts";
import {resolveMeUser} from "../pasaport/trusted-user.ts";
import {bootScriptTag, buildBootPayload} from "./shell-boot.ts";

const freshUser: UserRow = {
	id: "user-42",
	email: "elif@kamp.us",
	name: "Elif </script> Çınar",
	image: null,
	username: "elif",
	tier: "yazar",
};

const identityLayer = (tier: "çaylak" | "yazar", isModerator: boolean) =>
	Layer.mergeAll(
		Layer.succeed(Pasaport, {
			getUserById: () => Effect.succeed(freshUser),
			getEmailDeliveryState: () => Effect.succeed({state: {failing: true}}),
		} as never),
		Layer.succeed(Kunye, {tierOf: () => Effect.succeed(tier)} as never),
		Layer.succeed(RelationStore, {
			has: () => Effect.succeed(isModerator),
			hasSubjects: () => Effect.succeed(new Set<string>()),
			subjectsOf: () => Effect.succeed(new Set<string>()),
		}),
	);

const decode = (tag: string) =>
	JSON.parse(tag.slice("<script>window.__BOOT__=".length, -"</script>".length));

describe("shell __BOOT__.user preserves the shared me identity with no shell flags", () => {
	for (const [tier, isModerator] of [
		["yazar", true],
		["çaylak", false],
	] as const) {
		it.effect(`round-trips the fresh ${tier} identity and trusted standing`, () =>
			Effect.gen(function* () {
				// Both the shell handler and the me query use this resolver, not session fields.
				const me = yield* resolveMeUser({
					id: freshUser.id,
					email: "stale@kamp.us",
					name: "Stale session name",
				}).pipe(Effect.provide(identityLayer(tier, isModerator)));
				const {__typename, ...user} = me;
				assert.strictEqual(__typename, "User");
				assert.deepStrictEqual(user, {...freshUser, tier, isModerator, emailFailing: true});
				const tag = bootScriptTag(buildBootPayload(user, {}));
				assert.deepStrictEqual(decode(tag), {user});
				assert.notInclude(tag, "</script> Çınar");
			}),
		);
	}

	it("preserves explicit null for a signed-out viewer", () => {
		assert.deepStrictEqual(decode(bootScriptTag(buildBootPayload(null, {}))), {user: null});
	});
});
