/**
 * Domain-boundary error pins — infra failures never escape a feature service.
 *
 * The boundary rule (`.patterns/feature-services.md`, `.patterns/effect-errors.md`):
 * a domain service dies on infrastructure failures INSIDE its implementation —
 * every internal Drizzle call site collapses `DrizzleError` into the defect
 * channel (`orDieAccess` over `run`/`batch` at layer build) — so the public
 * method signatures carry DOMAIN errors only. The fate layer
 * (sources/queries/lists/mutations) consequently never names Drizzle: there is
 * nothing left to `orDie` at the transport edge, and the loader contract's
 * "infra failures are defects" holds by the service type alone.
 *
 * Type-level pins only (expectTypeOf, not `@ts-expect-error` — the effect LSP
 * plugin's TS377003 escapes the directive, recurring finding):
 *
 *   1. a per-service SWEEP proving no method's `E` channel contains
 *      `DrizzleError` (a re-leak on any method is a compile error here);
 *   2. one exact-union pin per service, so a signature that silently widens
 *      or narrows its domain union is also a compile error.
 *
 * T0 per ADR 0040: type-only assertions, zero storage, zero layers.
 */

import type {Effect} from "effect";
import {expectTypeOf, it} from "vitest";
import type {DrizzleError} from "../db/Drizzle.ts";
import type {
	CommentNotFound,
	CommentValidation,
	PostNotFound,
	PostValidation,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
} from "./pano/errors.ts";
import type {Pano} from "./pano/Pano.ts";
import type {
	UserNotFound,
	UsernameAlreadySet,
	UsernameInvalid,
	UsernameTaken,
} from "./pasaport/errors.ts";
import type {Pasaport} from "./pasaport/Pasaport.ts";
import type {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./sozluk/errors.ts";
import type {Sozluk} from "./sozluk/Sozluk.ts";
import type {Stats} from "./stats/Stats.ts";
import type {VoteTargetNotFound} from "./vote/errors.ts";
import type {Vote} from "./vote/Vote.ts";

/** The `E` channel of one service method. */
type ErrorsOf<F> = F extends (...args: never[]) => Effect.Effect<infer _A, infer E, infer _R>
	? E
	: never;

/**
 * The keys of every method whose `E` channel contains `DrizzleError` — the
 * sweep resolves to `never` exactly when the whole service is leak-free, and
 * to the offending method name(s) otherwise (so the failing pin names the
 * culprit).
 */
type InfraLeaks<S> = {
	[K in keyof S]: [Extract<ErrorsOf<S[K]>, DrizzleError>] extends [never] ? never : K;
}[keyof S];

it("Sozluk: no method leaks DrizzleError; exact domain unions hold", () => {
	type Svc = typeof Sozluk.Service;
	expectTypeOf<InfraLeaks<Svc>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["getTerm"]>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["editDefinition"]>>().toEqualTypeOf<
		BodyRequired | BodyTooLong | DefinitionNotFound | UnauthorizedDefinitionMutation
	>();
});

it("Pano: no method leaks DrizzleError; exact domain unions hold", () => {
	type Svc = typeof Pano.Service;
	expectTypeOf<InfraLeaks<Svc>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["getPost"]>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["editPost"]>>().toEqualTypeOf<
		PostValidation | PostNotFound | UnauthorizedPostMutation
	>();
	expectTypeOf<ErrorsOf<Svc["editComment"]>>().toEqualTypeOf<
		CommentValidation | CommentNotFound | UnauthorizedCommentMutation
	>();
});

it("Pasaport: no method leaks DrizzleError; exact domain unions hold", () => {
	type Svc = typeof Pasaport.Service;
	expectTypeOf<InfraLeaks<Svc>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["lookupProfile"]>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["setUsername"]>>().toEqualTypeOf<
		UsernameInvalid | UsernameTaken | UsernameAlreadySet | UserNotFound
	>();
});

it("Stats: no method leaks DrizzleError", () => {
	type Svc = typeof Stats.Service;
	expectTypeOf<InfraLeaks<Svc>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["getLandingStats"]>>().toEqualTypeOf<never>();
});

it("Vote: no method leaks DrizzleError; exact domain unions hold", () => {
	type Svc = typeof Vote.Service;
	expectTypeOf<InfraLeaks<Svc>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["cast"]>>().toEqualTypeOf<VoteTargetNotFound>();
	expectTypeOf<ErrorsOf<Svc["readMine"]>>().toEqualTypeOf<never>();
});
