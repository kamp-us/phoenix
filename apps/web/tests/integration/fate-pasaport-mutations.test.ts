/**
 * fate pasaport identity — `user.setUsername` write + re-resolve + wire-error
 * parity, and authenticated `me`.
 *
 * Drives the real `user.setUsername` resolver (and the `me` query) through a
 * per-request `FateRuntime` with a session baked into the `Auth` layer — the
 * same runtime the `/fate` route builds — so each test exercises the full
 * `fateMutation → Pasaport.setUsername → re-resolved User / encodeFateError`
 * path against the live `env.PHOENIX_DB`. Users are created through better-auth
 * (`handleAuth`) so the `user` row `setUsername` reads/writes really exists.
 *
 * Asserts:
 *   - `user.setUsername` writes the username and returns the re-resolved `User`.
 *   - `me` returns the full row (with the freshly-set username) once a session
 *     is baked in.
 *   - validation failures surface the same wire codes as the GraphQL
 *     `setUsername` mutation (`TOO_SHORT`, `INVALID_FORMAT`, `TAKEN`,
 *     `ALREADY_SET`, `UNAUTHORIZED`).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {FateRequestError} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import type {FateContext} from "../../worker/fate/context";
import {pasaportMutations} from "../../worker/fate/pasaport-mutations";
import {queries} from "../../worker/fate/queries";
import {FateRuntime, type SessionData} from "../../worker/fate/runtime";
import {Pasaport, PasaportLive} from "../../worker/features/pasaport/Pasaport";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = PasaportLive.pipe(
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

const run = <A, E, R extends Pasaport>(eff: Effect.Effect<A, E, R>) =>
	Effect.runPromise(eff.pipe(Effect.provide(TestLive)) as Effect.Effect<A, E, never>);

async function applyViewMigrations() {
	const statements = baselineMigration
		.split("--> statement-breakpoint")
		.map((s: string) => s.trim())
		.filter(Boolean);
	for (const stmt of statements) {
		try {
			await env.PHOENIX_DB.prepare(stmt).run();
		} catch (err) {
			const msg = String(err);
			if (
				!msg.includes("already exists") &&
				!msg.includes("duplicate column") &&
				!msg.includes("no such table") &&
				!msg.includes("no such index")
			) {
				throw err;
			}
		}
	}
}

async function signUpUser(email: string, password: string, name: string): Promise<string> {
	const req = new Request("https://test.local/api/auth/sign-up/email", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({email, password, name}),
	});
	const response = await run(
		Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			return yield* pasaport.handleAuth(req);
		}),
	);
	if (!response.ok) {
		throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
	}
	const data = (await response.json()) as {user?: {id: string}};
	if (!data.user?.id) throw new Error("sign-up returned no user id");
	return data.user.id;
}

const request = new Request("https://test.local/fate", {method: "POST"});

/** A `FateContext` whose runtime bakes in the given session (or anonymous). */
function makeCtx(user?: {id: string; email: string; name?: string | null}): {
	ctx: FateContext;
	dispose: () => Promise<void>;
} {
	const sessionData: SessionData = user ? {user: user as never} : null;
	const runtime = FateRuntime.make(env, request, sessionData);
	return {ctx: {runtime, request}, dispose: () => runtime.dispose()};
}

function invoke<I, O>(
	def: {resolve: (o: {ctx: FateContext; input: I; select: Array<string>}) => Promise<O>},
	ctx: FateContext,
	input: I,
	select: Array<string> = [],
): Promise<O> {
	return def.resolve({ctx, input, select});
}

function invokeQuery<Args, O>(
	def: {
		resolve: (o: {ctx: FateContext; input: {args?: Args}; select: Array<string>}) => Promise<O>;
	},
	ctx: FateContext,
	args: Args,
	select: Array<string> = [],
): Promise<O> {
	return def.resolve({ctx, input: {args}, select});
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("fate pasaport identity — user.setUsername / me", () => {
	it("user.setUsername writes and returns the re-resolved User", async () => {
		const userId = await signUpUser("setname@test.local", "supersecret123", "Set Name");
		const {ctx, dispose} = makeCtx({id: userId, email: "setname@test.local", name: "Set Name"});
		try {
			const out = await invoke(pasaportMutations["user.setUsername"], ctx, {
				value: "fate-setname",
			});
			expect(out.__typename).toBe("User");
			expect(out.id).toBe(userId);
			expect(out.username).toBe("fate-setname");
			expect(out.email).toBe("setname@test.local");
			expect(out.name).toBe("Set Name");

			// `me` now returns the full row with the freshly-set username.
			const me = await invokeQuery(queries.me, ctx, undefined, ["id", "email", "username"]);
			expect((me as {id: string}).id).toBe(userId);
			expect((me as {username: string | null}).username).toBe("fate-setname");
		} finally {
			await dispose();
		}
	});

	it("a too-short username surfaces TOO_SHORT (same wire code as GraphQL)", async () => {
		const userId = await signUpUser("tooshort@test.local", "supersecret123", "Too Short");
		const {ctx, dispose} = makeCtx({id: userId, email: "tooshort@test.local"});
		try {
			const err = await invoke(pasaportMutations["user.setUsername"], ctx, {value: "ab"}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(FateRequestError);
			expect((err as FateRequestError).code).toBe("TOO_SHORT");
		} finally {
			await dispose();
		}
	});

	it("an illegal-format username surfaces INVALID_FORMAT", async () => {
		const userId = await signUpUser("badformat@test.local", "supersecret123", "Bad Format");
		const {ctx, dispose} = makeCtx({id: userId, email: "badformat@test.local"});
		try {
			await expect(
				invoke(pasaportMutations["user.setUsername"], ctx, {value: "Bad_Name!"}),
			).rejects.toMatchObject({code: "INVALID_FORMAT"});
		} finally {
			await dispose();
		}
	});

	it("a taken username surfaces TAKEN", async () => {
		const owner = await signUpUser("owner@test.local", "supersecret123", "Owner");
		const ownerCtx = makeCtx({id: owner, email: "owner@test.local"});
		try {
			await invoke(pasaportMutations["user.setUsername"], ownerCtx.ctx, {value: "fate-taken"});
		} finally {
			await ownerCtx.dispose();
		}

		const other = await signUpUser("other@test.local", "supersecret123", "Other");
		const {ctx, dispose} = makeCtx({id: other, email: "other@test.local"});
		try {
			await expect(
				invoke(pasaportMutations["user.setUsername"], ctx, {value: "fate-taken"}),
			).rejects.toMatchObject({code: "TAKEN"});
		} finally {
			await dispose();
		}
	});

	it("setting a username twice surfaces ALREADY_SET", async () => {
		const userId = await signUpUser("twice@test.local", "supersecret123", "Twice");
		const {ctx, dispose} = makeCtx({id: userId, email: "twice@test.local"});
		try {
			await invoke(pasaportMutations["user.setUsername"], ctx, {value: "fate-twice"});
			await expect(
				invoke(pasaportMutations["user.setUsername"], ctx, {value: "fate-twice-again"}),
			).rejects.toMatchObject({code: "ALREADY_SET"});
		} finally {
			await dispose();
		}
	});

	it("anonymous setUsername surfaces UNAUTHORIZED", async () => {
		const {ctx, dispose} = makeCtx(); // no session
		try {
			await expect(
				invoke(pasaportMutations["user.setUsername"], ctx, {value: "fate-anon"}),
			).rejects.toMatchObject({code: "UNAUTHORIZED"});
		} finally {
			await dispose();
		}
	});

	it("anonymous me surfaces UNAUTHORIZED", async () => {
		const {ctx, dispose} = makeCtx(); // no session
		try {
			await expect(invokeQuery(queries.me, ctx, undefined, ["id"])).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		} finally {
			await dispose();
		}
	});
});
