/**
 * `Pasaport.promoteToYazar` backlog-sweep coverage — the tier flip and the sandbox sweep
 * are ONE atomic D1 batch (ADR 0014) and every statement is conditional, which is what
 * makes a re-promote idempotent and a mixed backlog land consistent. Proven by rendering
 * the batch's `.toSQL()` over a no-op D1, so no engine runs and this stays unit tier.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	DrizzleError,
	relations,
	type Stmt,
} from "../../db/Drizzle.ts";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import type {Notification, NotificationRecordInput} from "../bildirim/Notification.ts";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import type {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";
import {NO_SANDBOX_SWEEP, type SandboxSweep, sweptEntryCount} from "./sandbox-sweep.ts";

// A real drizzle client over a no-op D1, used ONLY to render `.toSQL()`; nothing executes.
// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; nothing here executes against it.
const noopD1 = {
	prepare: () => ({
		bind() {
			return this;
		},
		async all() {
			return {results: []};
		},
		async first() {
			return null;
		},
		async run() {
			return {};
		},
		async raw() {
			return [];
		},
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {relations});

const inertAuth = {} as BetterAuthInstance;

// The backlog-release emit (#7061) rides per-request services, so every case below carries
// the same request-context stubs the bildirim emitter tests use.
const runtimeContextStub: BaseRuntimeContext = {
	Type: "promotion-sweep-test",
	id: "promotion-sweep-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised here.
		{
			getBoolean: () => Effect.succeed(on),
			getString: () => Effect.die(new Error("unused")),
			getNumber: () => Effect.die(new Error("unused")),
			getObject: () => Effect.die(new Error("unused")),
		} as unknown as typeof Flags.Service,
	);

// The stub `record` never publishes, so a do-nothing publisher just satisfies the requirement.
const noopLivePublisher = Layer.succeed(LivePublisher)({
	update: () => Effect.void,
	delete: () => Effect.void,
	invalidate: () => Effect.void,
	topic: () => {
		throw new Error("noopLivePublisher.topic unused");
	},
} as typeof LivePublisher.Service);

const emitContext = (
	on: boolean,
	onRecord?: (input: NotificationRecordInput) => void,
): Layer.Layer<
	Flags | CurrentUser | RuntimeContext | RequestFlagOverrides | LivePublisher | Notification
> =>
	Layer.mergeAll(
		flagsStub(on),
		Layer.succeed(CurrentUser, {user: undefined}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
		noRequestFlagOverrides,
		noopLivePublisher,
		makeNotificationStub({
			record: (input) => {
				onRecord?.(input);
				return Effect.succeed({id: "n1"});
			},
		}),
	);

// The first result's `meta.changes` is what drives `promoted`; `events` records the batch's
// commit so a test can pin what runs after it.
function capturingBatch(
	tierChanges: number,
	events?: string[],
): {
	access: DrizzleAccess;
	statements: () => {sql: string; params: unknown[]}[];
} {
	const captured: {sql: string; params: unknown[]}[] = [];
	const access: DrizzleAccess = {
		// The one permitted single statement is the pre-batch READ that captures which live
		// topics the sweep is about to un-hide content on (#6462) — it must precede the batch,
		// because afterwards `sandboxed_at` is null. The WRITES are still all-or-nothing, which
		// is what every case below asserts by counting `statements()`.
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) =>
			Effect.tryPromise({
				try: () => fn(renderDb),
				catch: (cause) => new DrizzleError({cause}),
			}),
		batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(fn: (db: DrizzleDb) => T) => {
			const stmts = fn(renderDb);
			for (const s of stmts) {
				// biome-ignore lint/plugin: drizzle's `BatchItem`/`Stmt` carries `.toSQL()` at runtime but doesn't expose it on the type; render it to assert the built SQL.
				const renderable = s as unknown as {toSQL: () => {sql: string; params: unknown[]}};
				captured.push(renderable.toSQL());
			}
			if (events) events.push("batch");
			// The method reads only `.meta.changes`; the real `BatchResult` shape is not
			// reconstructable in a no-engine double.
			const result = stmts.map((_, i) => ({meta: {changes: i === 0 ? tierChanges : 0}}));
			return Effect.succeed(result as never);
		},
	};
	return {access, statements: () => captured};
}

const pasaportOver = (
	access: DrizzleAccess,
	emit: Layer.Layer<
		Flags | CurrentUser | RuntimeContext | RequestFlagOverrides | LivePublisher | Notification
	> = emitContext(true),
) =>
	// The emit services ride the AMBIENT context — like production, where the fate
	// layer merges every domain service flat — not the layer build's inputs.
	Layer.mergeAll(
		makePasaportLive(inertAuth).pipe(Layer.provide(Layer.succeed(Drizzle, access))),
		emit,
	);

describe("Pasaport.promoteToYazar — atomic, idempotent backlog sweep", () => {
	it.effect("emits ONE batch of four statements: the tier flip + the three content sweeps", () => {
		const cap = capturingBatch(1);
		return Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.promoteToYazar({userId: "u-caylak"});
			assert.strictEqual(cap.statements().length, 4, "tier UPDATE + def/post/comment sweeps");
		}).pipe(Effect.provide(pasaportOver(cap.access)));
	});

	it.effect(
		"the tier UPDATE is guarded `tier = çaylak` (idempotent — promote-twice no-ops)",
		() => {
			const cap = capturingBatch(1);
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				yield* pasaport.promoteToYazar({userId: "u-caylak"});

				const tier = cap.statements()[0];
				assert.isTrue(tier !== undefined);
				if (tier === undefined) return;
				const sql = tier.sql.toLowerCase();
				assert.match(sql, /update\s+"user"/);
				assert.match(sql, /"tier"\s*=/); // sets tier
				assert.match(sql, /where[\s\S]*"id"[\s\S]*"tier"/); // guarded on BOTH id and current tier
				assert.includeMembers(tier.params as unknown[], ["yazar", "u-caylak", "çaylak"]);
			}).pipe(Effect.provide(pasaportOver(cap.access)));
		},
	);

	it.effect(
		"the SAME guarded UPDATE stamps promoted_at (#1590) — both promotion paths funnel through `promoteToYazar`, so this is the single stamp site for mod-direct AND vouch-tandem",
		() => {
			const cap = capturingBatch(1);
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				yield* pasaport.promoteToYazar({userId: "u-caylak"});

				const tier = cap.statements()[0];
				assert.isTrue(tier !== undefined);
				if (tier === undefined) return;
				const sql = tier.sql.toLowerCase();
				assert.match(sql, /set[\s\S]*"promoted_at"\s*=\s*\?/); // stamps promoted_at…
				assert.match(sql, /where[\s\S]*"tier"/); // …only when the tier actually flips (guarded)

				// It must also be the ONLY statement touching promoted_at, or an unconditional
				// write would stamp on a non-promoting call.
				const stmtsTouchingPromotedAt = cap
					.statements()
					.filter((s) => s.sql.toLowerCase().includes("promoted_at"));
				assert.strictEqual(stmtsTouchingPromotedAt.length, 1);
			}).pipe(Effect.provide(pasaportOver(cap.access)));
		},
	);

	it.effect(
		"a non-promoting call (already-yazar / unknown) leaves promoted_at null — the only promoted_at write is the guarded UPDATE that matched 0 rows",
		() => {
			// 0 = the guarded tier UPDATE matched no rows (already yazar).
			const cap = capturingBatch(0);
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				const {promoted} = yield* pasaport.promoteToYazar({userId: "u-yazar-already"});
				assert.isFalse(promoted);

				const promotedAtWrites = cap
					.statements()
					.filter((s) => s.sql.toLowerCase().includes("promoted_at"));
				assert.strictEqual(promotedAtWrites.length, 1); // exactly one write site…
				assert.match(promotedAtWrites[0]?.sql.toLowerCase() ?? "", /where[\s\S]*"tier"/); // …and it is tier-guarded, so 0-row matches stamp nothing
			}).pipe(Effect.provide(pasaportOver(cap.access)));
		},
	);

	it.effect(
		"each content sweep clears sandboxed_at only for sandboxed, not-removed, owned rows",
		() => {
			const cap = capturingBatch(1);
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				yield* pasaport.promoteToYazar({userId: "u-caylak"});

				// Statements 1..3 are the definition/post/comment sweeps.
				const sweeps = cap.statements().slice(1);
				assert.strictEqual(sweeps.length, 3);
				for (const sweep of sweeps) {
					const sql = sweep.sql.toLowerCase();
					assert.match(sql, /set[\s\S]*"sandboxed_at"\s*=\s*\?/); // assigns sandboxed_at…
					assert.include(sweep.params as unknown[], null); // …to null (flips to live)
					assert.match(sql, /"sandboxed_at"\s+is not null/); // only currently-sandboxed
					assert.match(sql, /"removed_at"\s+is null/); // never resurrect removed content
					assert.match(sql, /"author_id"\s*=/); // scoped to this author's backlog
					assert.include(sweep.params as unknown[], "u-caylak");
				}
			}).pipe(Effect.provide(pasaportOver(cap.access)));
		},
	);

	it.effect("promoted reflects the tier-flip changes count — true when a çaylak flips", () =>
		Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			const {promoted} = yield* pasaport.promoteToYazar({userId: "u-caylak"});
			assert.isTrue(promoted);
		}).pipe(Effect.provide(pasaportOver(capturingBatch(1).access))),
	);

	it.effect(
		"promoted is false on a re-run / already-yazar (the guarded UPDATE matches 0 rows)",
		() =>
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				const {promoted} = yield* pasaport.promoteToYazar({userId: "u-yazar-already"});
				assert.isFalse(promoted);
			}).pipe(Effect.provide(pasaportOver(capturingBatch(0).access))),
	);

	it.effect(
		"the backlog-release emit fires exactly once, AFTER the tier-flip batch commits (#7061)",
		() => {
			const events: string[] = [];
			const cap = capturingBatch(1, events);
			const emitted: NotificationRecordInput[] = [];
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				const {promoted} = yield* pasaport.promoteToYazar({userId: "u-caylak"});
				assert.isTrue(promoted);
				assert.strictEqual(emitted.length, 1, "one emit per promotion, never per caller");
				assert.deepStrictEqual(events, ["batch", "notify"]);
			}).pipe(
				Effect.provide(
					pasaportOver(
						cap.access,
						emitContext(true, (input) => {
							emitted.push(input);
							events.push("notify");
						}),
					),
				),
			);
		},
	);

	it.effect("a non-promoting re-fire notifies nothing", () => {
		const cap = capturingBatch(0);
		const emitted: NotificationRecordInput[] = [];
		return Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.promoteToYazar({userId: "u-yazar-already"});
			assert.strictEqual(emitted.length, 0);
		}).pipe(
			Effect.provide(
				pasaportOver(
					cap.access,
					emitContext(true, (input) => emitted.push(input)),
				),
			),
		);
	});

	it.effect("with the bildirim flag OFF nothing emits even on a real flip (dark ship)", () => {
		const cap = capturingBatch(1);
		const emitted: NotificationRecordInput[] = [];
		return Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			const {promoted} = yield* pasaport.promoteToYazar({userId: "u-caylak"});
			assert.isTrue(promoted);
			assert.strictEqual(emitted.length, 0);
		}).pipe(
			Effect.provide(
				pasaportOver(
					cap.access,
					emitContext(false, (input) => emitted.push(input)),
				),
			),
		);
	});
});

describe("sweptEntryCount — the rows the sweep un-hid, together (#7061)", () => {
	it("sums the swept posts, comments and definitions", () => {
		const sweep: SandboxSweep = {
			feed: true,
			commentThreads: ["p1"],
			definitionTerms: ["t1"],
			postIds: ["p1", "p2"],
			commentIds: ["c1"],
			definitionIds: ["d1", "d2", "d3"],
		};
		assert.strictEqual(sweptEntryCount(sweep), 6);
	});

	it("an empty sweep counts zero — the copy's zero arm renders this", () => {
		assert.strictEqual(sweptEntryCount(NO_SANDBOX_SWEEP), 0);
	});
});
