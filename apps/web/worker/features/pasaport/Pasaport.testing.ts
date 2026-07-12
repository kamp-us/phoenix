/**
 * `makePasaportStub` — the shared `Pasaport` test double. Defaults every one of
 * the `Pasaport` methods to fail-on-contact (`Effect.die`) and takes a partial
 * override of the method(s) under test, returning the `Layer.succeed(Pasaport, …)`
 * layer. One place the interface shape lives — adding a method to `Pasaport` is a
 * single edit here, not shotgun surgery across every hand-rolled stub.
 *
 * A `layerStub` (fail-on-contact), not a `layerNoop` (silently-succeed): an
 * un-overridden method, if reached, dies and fails the test — the discipline that
 * proves the path under test touched only the method(s) it was scripted with.
 *
 * A **factory, not a shared instance** (`.patterns/effect-testing.md`).
 */
import {Effect, Layer} from "effect";
import {Pasaport} from "./Pasaport.ts";

type PasaportShape = typeof Pasaport.Service;

const die =
	(method: string) =>
	(..._args: ReadonlyArray<unknown>): Effect.Effect<never, never, never> =>
		Effect.die(new Error(`Pasaport.${method} touched an unexpected method`));

const failOnContact: PasaportShape = {
	validateSession: die("validateSession"),
	getUserById: die("getUserById"),
	getUsersByIds: die("getUsersByIds"),
	getProfileIdentitiesByIds: die("getProfileIdentitiesByIds"),
	setUsername: die("setUsername"),
	setDisplayName: die("setDisplayName"),
	lookupProfile: die("lookupProfile"),
	lookupProfileById: die("lookupProfileById"),
	countInReview: die("countInReview"),
	listContributions: die("listContributions"),
	anonymizeAccount: die("anonymizeAccount"),
	promoteToYazar: die("promoteToYazar"),
	getBanState: die("getBanState"),
	banUser: die("banUser"),
	unbanUser: die("unbanUser"),
	getEmailDeliveryState: die("getEmailDeliveryState"),
	markEmailFailing: die("markEmailFailing"),
	clearEmailFailing: die("clearEmailFailing"),
	listFailingAddresses: die("listFailingAddresses"),
	readEmailFailing: die("readEmailFailing"),
};

export const makePasaportStub = (overrides: Partial<PasaportShape> = {}): Layer.Layer<Pasaport> =>
	Layer.succeed(Pasaport, {...failOnContact, ...overrides});

/**
 * `PasaportIdentityStub` — the `Pasaport` double for unit tests that build
 * `PanoLive` / `SozlukLive` over a substituted `Drizzle` seam. Those services now
 * stamp the live author identity on their reads (`getProfileIdentitiesByIds`, #2139,
 * mirroring the `ReactionStub` shape for `Reaction.readAggregate`, #1862), so a test
 * that provides only `Vote`/`Bookmark`/`Reaction`/`Drizzle` leaves `Pasaport`
 * unsatisfied in `R`. This stub discharges it: `getProfileIdentitiesByIds` returns
 * `[]`, so the stamp leaves `authorUsername`/`authorDisplayName` null and the client
 * `actorLabel` degrades. Every other method dies if reached — the resolve/identity
 * write paths are the pasaport domain tests' concern, not these connection tests.
 */
export const PasaportIdentityStub: Layer.Layer<Pasaport> = makePasaportStub({
	getProfileIdentitiesByIds: () => Effect.succeed([]),
});
