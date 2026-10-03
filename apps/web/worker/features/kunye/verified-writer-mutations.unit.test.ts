/**
 * Every mutation ADR 0434 lists as in-scope wears the çaylak write gate, driven through its real
 * wire interface (`resolveWire`) with `phoenix-email-verified-writes` ON.
 *
 * An unverified çaylak must come back `EMAIL_UNVERIFIED` with the domain service untouched: every
 * `Pano`/`Sozluk` method dies on contact. A verified çaylak must get past the gate to the write:
 * the one scripted write method records the call and fails with the domain's own typed error,
 * so its wire code proves the write was reached without standing up the whole success path.
 */
import {assert, describe, it} from "@effect/vitest";
import {AgentAuthority, CurrentActor, human, RelationStore} from "@kampus/authz";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer, Option} from "effect";
import {PHOENIX_EMAIL_VERIFIED_WRITES} from "../../../src/flags/keys.ts";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import {Divan} from "../divan/Divan.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Flags} from "../flagship/Flags.ts";
import {CommentNotFound, PostNotFound, TitleRequired} from "../pano/errors.ts";
import {mutations as panoMutations} from "../pano/mutations.ts";
import {Pano} from "../pano/Pano.ts";
import {BodyRequired, DefinitionNotFound} from "../sozluk/errors.ts";
import {mutations as sozlukMutations} from "../sozluk/mutations.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {Kunye} from "./Kunye.ts";

const CAYLAK = {id: "u-caylak", email: "yeni@example.com", name: "yeni"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// Only the write gate's flag is on, so the karma floor stays inert and reads no karma.
const flagsStub = Layer.succeed(Flags, {
	getBoolean: (key: string) => Effect.succeed(key === PHOENIX_EMAIL_VERIFIED_WRITES),
	getString: () => Effect.die("getString not exercised"),
	getNumber: () => Effect.die("getNumber not exercised"),
	getObject: () => Effect.die("getObject not exercised"),
} as typeof Flags.Service);

const kunyeCaylak = (verified: boolean) =>
	Layer.succeed(Kunye, {
		tierOf: () => Effect.succeed("çaylak" as const),
		emailVerifiedOf: () => Effect.succeed(verified),
		karmaOf: () => Effect.die(new Error("karma floor is off in this file")),
		rootOf: (id: string) => Effect.succeed(id),
	});

const liveStub = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

const divanStub = Layer.succeed(Divan, {
	roster: () => Effect.die("Divan not exercised"),
	backlogOf: () => Effect.die("Divan not exercised"),
	pendingCountOf: () => Effect.die("Divan not exercised"),
	pendingTotal: () => Effect.die("Divan not exercised"),
});

const relationStoreStub = Layer.succeed(RelationStore, {
	has: () => Effect.succeed(false),
	hasSubjects: () => Effect.succeed(new Set<string>()),
	subjectsOf: () => Effect.die("RelationStore.subjectsOf not exercised"),
});

/** A service whose scripted methods answer and whose every other method dies on contact. */
const proxied = <S extends object>(name: string, methods: Partial<S>): S =>
	new Proxy(methods, {
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop as string];
			return () => Effect.die(`${name}.${String(prop)} reached — the gate let the write through`);
		},
	}) as S;

type Services = Layer.Layer<unknown, never, never>;

interface Case {
	readonly key: string;
	readonly run: (services: Services) => Effect.Effect<unknown, unknown, unknown>;
	/** The write method a verified çaylak reaches, and the typed failure it answers with. */
	readonly write: {service: "Pano" | "Sozluk"; method: string; fail: () => unknown};
	/** The wire code that failure encodes to. */
	readonly reachedCode: string;
}

const op = (m: unknown, input: Record<string, unknown>) => (services: Services) =>
	resolveWire(m as Parameters<typeof resolveWire>[0], {input, select: ["id"]} as never).pipe(
		Effect.provide(services),
	) as Effect.Effect<unknown, unknown, unknown>;

const CASES: ReadonlyArray<Case> = [
	{
		key: "post.submit",
		run: op(panoMutations["post.submit"], {title: "başlık", tags: [{kind: "soru"}]}),
		write: {service: "Pano", method: "submitPost", fail: () => new TitleRequired({message: "x"})},
		reachedCode: "TITLE_REQUIRED",
	},
	{
		key: "post.edit",
		run: op(panoMutations["post.edit"], {id: "post_1", body: "yeni gövde"}),
		write: {
			service: "Pano",
			method: "editPost",
			fail: () => new PostNotFound({postId: "post_1", message: "x"}),
		},
		reachedCode: "POST_NOT_FOUND",
	},
	{
		key: "comment.add",
		run: op(panoMutations["comment.add"], {postId: "post_1", body: "bir yorum"}),
		write: {
			service: "Pano",
			method: "addComment",
			fail: () => new PostNotFound({postId: "post_1", message: "x"}),
		},
		reachedCode: "POST_NOT_FOUND",
	},
	{
		key: "comment.edit",
		run: op(panoMutations["comment.edit"], {id: "comment_1", body: "düzeltilmiş yorum"}),
		write: {
			service: "Pano",
			method: "editComment",
			fail: () => new CommentNotFound({commentId: "comment_1", message: "x"}),
		},
		reachedCode: "COMMENT_NOT_FOUND",
	},
	{
		key: "definition.add",
		run: op(sozlukMutations["definition.add"], {termSlug: "terim", body: "bir tanım"}),
		write: {
			service: "Sozluk",
			method: "addDefinition",
			fail: () => new BodyRequired({message: "x"}),
		},
		reachedCode: "BODY_REQUIRED",
	},
	{
		key: "definition.edit",
		run: op(sozlukMutations["definition.edit"], {id: "def_1", body: "düzeltilmiş tanım"}),
		write: {
			service: "Sozluk",
			method: "editDefinition",
			fail: () => new DefinitionNotFound({definitionId: "def_1", message: "x"}),
		},
		reachedCode: "DEFINITION_NOT_FOUND",
	},
];

const wireCodeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
	if (!Exit.isFailure(exit)) return "<success>";
	const found = Cause.findErrorOption(exit.cause);
	return Option.isSome(found) ? (found.value as {code?: unknown}).code : "<defect>";
};

const drive = (c: Case, verified: boolean, calls: Array<string>) => {
	const scripted = {
		[c.write.method]: () =>
			Effect.suspend(() => {
				calls.push(c.write.method);
				return Effect.fail(c.write.fail());
			}),
	};
	const services = Layer.mergeAll(
		Layer.succeed(
			Pano,
			proxied<typeof Pano.Service>("Pano", c.write.service === "Pano" ? scripted : {}),
		),
		Layer.succeed(
			Sozluk,
			proxied<typeof Sozluk.Service>("Sozluk", c.write.service === "Sozluk" ? scripted : {}),
		),
		kunyeCaylak(verified),
		Layer.succeed(CurrentActor, {actor: human(CAYLAK.id)}),
		Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(true)}),
		liveStub,
		divanStub,
		relationStoreStub,
		flagsStub,
		makeNotificationStub(),
	) as Services;
	return c
		.run(services)
		.pipe(
			Effect.provideService(CurrentUser, {user: CAYLAK}),
			Effect.provideService(RuntimeContext, runtimeContextStub),
			Effect.exit,
		) as Effect.Effect<Exit.Exit<unknown, unknown>>;
};

describe("ADR 0434 in-scope mutations wear the çaylak write gate", () => {
	for (const c of CASES) {
		it.effect(`${c.key}: an unverified çaylak is refused EMAIL_UNVERIFIED before any write`, () =>
			Effect.gen(function* () {
				const calls: Array<string> = [];
				const exit = yield* drive(c, false, calls);
				assert.strictEqual(wireCodeOf(exit), "EMAIL_UNVERIFIED");
				assert.deepStrictEqual(calls, []);
			}),
		);

		it.effect(`${c.key}: a verified çaylak passes the gate and reaches the write`, () =>
			Effect.gen(function* () {
				const calls: Array<string> = [];
				const exit = yield* drive(c, true, calls);
				assert.deepStrictEqual(calls, [c.write.method]);
				assert.strictEqual(wireCodeOf(exit), c.reachedCode);
			}),
		);
	}
});
