/**
 * The shared `Pasaport` test double. Fail-on-contact, not silently-succeed: an
 * un-overridden method dies if reached, which is what proves the path under test touched
 * only the methods it was scripted with. A factory, not a shared instance
 * (`.patterns/effect-testing.md`).
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
	setRole: die("setRole"),
	getEmailDeliveryState: die("getEmailDeliveryState"),
	markEmailFailing: die("markEmailFailing"),
	clearEmailFailing: die("clearEmailFailing"),
	listFailingAddresses: die("listFailingAddresses"),
	listUsersForAdmin: die("listUsersForAdmin"),
	banStatesForAdmin: die("banStatesForAdmin"),
};

export const makePasaportStub = (overrides: Partial<PasaportShape> = {}): Layer.Layer<Pasaport> =>
	Layer.succeed(Pasaport, {...failOnContact, ...overrides});

/**
 * The double for tests that build `PanoLive` / `SozlukLive` over a substituted `Drizzle`
 * seam, which need `Pasaport` only for the author-identity stamp. Returning `[]` leaves
 * the identity fields null and the client label degraded, which those tests do not assert.
 */
export const PasaportIdentityStub: Layer.Layer<Pasaport> = makePasaportStub({
	getProfileIdentitiesByIds: () => Effect.succeed([]),
});
