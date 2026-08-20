/**
 * Domain-boundary error pins — infra failures never escape a feature service
 * (`.patterns/feature-services.md`, `.patterns/effect-errors.md`). Two pins per service:
 * a sweep proving no method's `E` channel contains `DrizzleError`, and an exact-union pin
 * catching a silently widened or narrowed domain union.
 *
 * Uses `expectTypeOf`, NOT `@ts-expect-error` — the effect LSP plugin's TS377003 escapes
 * the directive.
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
import type {ReportTargetNotFound} from "./report/errors.ts";
import type {Report} from "./report/Report.ts";
import type {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "./sozluk/errors.ts";
import type {Sozluk} from "./sozluk/Sozluk.ts";
import type {Stats} from "./stats/Stats.ts";
import type {VoterNotEligible, VoteTargetNotFound, VoteTargetSandboxed} from "./vote/errors.ts";
import type {Vote} from "./vote/Vote.ts";

type ErrorsOf<F> = F extends (...args: never[]) => Effect.Effect<infer _A, infer E, infer _R>
	? E
	: never;

// Resolves to `never` when leak-free, else to the offending method name(s), so a re-leak
// fails the pin AND names the culprit.
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
	// `castOnSandboxed` permits both rejections `cast` raises, so its only domain error is
	// the not-found race.
	expectTypeOf<ErrorsOf<Svc["cast"]>>().toEqualTypeOf<
		VoteTargetNotFound | VoteTargetSandboxed | VoterNotEligible
	>();
	expectTypeOf<ErrorsOf<Svc["castOnSandboxed"]>>().toEqualTypeOf<VoteTargetNotFound>();
	expectTypeOf<ErrorsOf<Svc["readMine"]>>().toEqualTypeOf<never>();
});

it("Report: no method leaks DrizzleError; exact domain unions hold", () => {
	type Svc = typeof Report.Service;
	expectTypeOf<InfraLeaks<Svc>>().toEqualTypeOf<never>();
	expectTypeOf<ErrorsOf<Svc["submit"]>>().toEqualTypeOf<ReportTargetNotFound>();
	expectTypeOf<ErrorsOf<Svc["readByReporter"]>>().toEqualTypeOf<never>();
});
