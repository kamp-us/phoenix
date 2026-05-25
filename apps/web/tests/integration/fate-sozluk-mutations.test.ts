/**
 * fate sozluk mutations — write + re-resolve + wire-error parity.
 *
 * Drives the real mutation resolvers from `mutations.ts` through a per-request
 * `FateRuntime` (the same runtime the `/fate` route builds), with a session
 * baked into the `Auth` layer — so each test exercises the full
 * `fateMutation → Sozluk service → re-resolved entity / encodeFateError` path
 * against the live `env.PHOENIX_DB` inside workerd. This is the mutation analog
 * of the read-path integration test; the HTTP `/fate` route adds only session
 * validation on top, which the seam test already covers.
 *
 * Asserts:
 *   - `definition.add` writes and returns the re-resolved `Definition`.
 *   - `definition.vote` / `retractVote` return the entity with `myVote` stamped.
 *   - `definition.edit` returns the edited entity.
 *   - `definition.delete` returns the re-resolved **parent** `Term`.
 *   - domain failures surface the same wire codes as GraphQL
 *     (`BODY_REQUIRED`, `DEFINITION_NOT_FOUND`, `UNAUTHORIZED`).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {FateRequestError} from "@nkzw/fate/server";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import type {FateContext} from "../../worker/fate/context";
import {mutations} from "../../worker/fate/mutations";
import {queries} from "../../worker/fate/queries";
import {FateRuntime, type SessionData} from "../../worker/fate/runtime";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

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

/** Invoke a mutation definition the way the fate server would. */
function invoke<I, O>(
	def: {resolve: (o: {ctx: FateContext; input: I; select: Array<string>}) => Promise<O>},
	ctx: FateContext,
	input: I,
	select: Array<string> = [],
): Promise<O> {
	return def.resolve({ctx, input, select});
}

/** Invoke a query definition (args are nested under `input.args`). */
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

const USER = {id: "author-1", email: "author@test.local", name: "yazar"};

beforeAll(async () => {
	await applyViewMigrations();
});

describe("fate sozluk mutations", () => {
	it("definition.add writes and returns the re-resolved Definition", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const def = await invoke(mutations["definition.add"], ctx, {
				termSlug: "fate-mut-add",
				termTitle: "Fate Mut Add",
				body: "an added definition",
			});
			expect(def.__typename).toBe("Definition");
			expect(def.id).toBeTruthy();
			expect(def.body).toBe("an added definition");
			expect(def.author).toBe("yazar");
			expect(def.authorId).toBe(USER.id);
			expect(def.score).toBe(0);
			expect(def.myVote).toBeNull();

			// The row really landed (a read-back through the term query sees it).
			const term = await invokeQuery(
				queries.term,
				ctx,
				{slug: "fate-mut-add", definitions: {first: 10}},
				["definitions.id", "definitions.body"],
			);
			const conn = (term as unknown as {definitions: {items: Array<{node: {id: string}}>}})
				.definitions;
			expect(conn.items.some((e) => e.node.id === def.id)).toBe(true);
		} finally {
			await dispose();
		}
	});

	it("definition.vote then retractVote return the entity with myVote stamped", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const added = await invoke(mutations["definition.add"], ctx, {
				termSlug: "fate-mut-vote",
				body: "a votable definition",
			});

			const voted = await invoke(mutations["definition.vote"], ctx, {id: added.id});
			expect(voted.score).toBe(1);
			expect(voted.myVote).toBe(1);

			const retracted = await invoke(mutations["definition.retractVote"], ctx, {id: added.id});
			expect(retracted.score).toBe(0);
			expect(retracted.myVote).toBeNull();
		} finally {
			await dispose();
		}
	});

	it("definition.edit returns the edited entity", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const added = await invoke(mutations["definition.add"], ctx, {
				termSlug: "fate-mut-edit",
				body: "before edit",
			});
			const edited = await invoke(mutations["definition.edit"], ctx, {
				id: added.id,
				body: "after edit",
			});
			expect(edited.id).toBe(added.id);
			expect(edited.body).toBe("after edit");
		} finally {
			await dispose();
		}
	});

	it("definition.delete returns the re-resolved parent Term", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const a = await invoke(mutations["definition.add"], ctx, {
				termSlug: "fate-mut-del",
				body: "to be deleted",
			});
			await invoke(mutations["definition.add"], ctx, {
				termSlug: "fate-mut-del",
				body: "the survivor",
			});

			const term = await invoke(mutations["definition.delete"], ctx, {id: a.id});
			expect(term).not.toBeNull();
			expect(term!.__typename).toBe("Term");
			expect(term!.slug).toBe("fate-mut-del");
			// One definition remains after the soft delete.
			expect(term!.count).toBe(1);
		} finally {
			await dispose();
		}
	});

	it("empty body surfaces BODY_REQUIRED (same wire code as GraphQL)", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const err = await invoke(mutations["definition.add"], ctx, {
				termSlug: "fate-mut-err",
				body: "   ",
			}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(FateRequestError);
			expect((err as FateRequestError).code).toBe("BODY_REQUIRED");
		} finally {
			await dispose();
		}
	});

	it("voting a missing definition surfaces DEFINITION_NOT_FOUND", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			await expect(
				invoke(mutations["definition.vote"], ctx, {id: "def_does_not_exist"}),
			).rejects.toMatchObject({code: "DEFINITION_NOT_FOUND"});
		} finally {
			await dispose();
		}
	});

	it("anonymous writes surface UNAUTHORIZED", async () => {
		const {ctx, dispose} = makeCtx(); // no session
		try {
			await expect(
				invoke(mutations["definition.add"], ctx, {termSlug: "fate-mut-anon", body: "nope"}),
			).rejects.toMatchObject({code: "UNAUTHORIZED"});
		} finally {
			await dispose();
		}
	});
});
