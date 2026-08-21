/**
 * What the `/fate` route puts on `requestServices` (ADR 0107 §7).
 *
 * The sandbox-viewer memo (#6457) is the reason this file exists: it is a
 * `Context.Reference`, so a route that stopped installing it would still typecheck and
 * still serve — every read would just go back to paying its own D1 round trips. Nothing
 * but a test can tell those two apart.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentActor, unauthenticated} from "@kampus/authz";
import {Context, Effect} from "effect";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {SandboxViewerMemo} from "../kunye/sandbox.ts";
import {PanoFeedCache} from "../pano/feed-cache.ts";
import {requestServicesFor} from "./route.ts";

const memoStub = Effect.succeed({
	viewerId: null,
	canSeeSandboxed: false,
	seesSandboxedInPlace: false,
});

const services = () =>
	requestServicesFor({
		actor: Context.make(CurrentActor, {actor: unauthenticated}),
		flagOverrides: {cookieHeader: null, overridesAllowed: false},
		feedCache: {purge: () => Effect.void},
		sandboxViewer: memoStub,
	});

describe("the /fate route's per-request context", () => {
	it("installs the request's sandbox-viewer memo, not the per-read default", () => {
		assert.strictEqual(Context.get(services(), SandboxViewerMemo), memoStub);
		assert.notStrictEqual(
			Context.get(Context.empty(), SandboxViewerMemo),
			memoStub,
			"the default is the unmemoized resolution — the assertion above would be vacuous otherwise",
		);
	});

	it("still carries the per-request services registered in layers.ts", () => {
		const context = services();
		assert.deepStrictEqual(Context.get(context, CurrentActor).actor, unauthenticated);
		assert.isFalse(Context.get(context, RequestFlagOverrides).overridesAllowed);
		assert.isFunction(Context.get(context, PanoFeedCache).purge);
	});
});
