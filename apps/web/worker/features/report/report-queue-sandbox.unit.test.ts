/**
 * The moderation queue reads its reported targets AS the moderator (#6472). Before this,
 * all six by-id reads passed no viewer, so `resolveSandboxViewer({})` yielded the
 * anonymous viewer and `sandboxVisibleWhere` masked every still-sandboxed row — the
 * çaylak reports the sandbox exists to make reviewable rendered blank.
 *
 * The Pano/Sozluk doubles here MODEL that mask rather than ignoring it: a sandboxed row
 * comes back only for a viewer carrying `canSeeSandboxed`. A double that returned the row
 * unconditionally would pass against the anonymous read too, which is exactly why the bug
 * survived the existing fan-out coverage.
 */

import {assert, describe, it} from "@effect/vitest";
import {type Actor, AgentAuthority, CurrentActor, human, RelationStore} from "@kampus/authz";
import {LivePublisher} from "@kampus/fate-effect";
import {liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {TargetId} from "../../lib/ids.ts";
import {noopPanoFeedCache, resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {makeKunyeStub} from "../kunye/Kunye.testing.ts";
import type {Tier} from "../kunye/standing.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {Pano} from "../pano/Pano.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {makeReportStub} from "./Report.testing.ts";
import type {OpenReportGroup} from "./Report.ts";

const MOD = "u-mod";
const CAYLAK = "u-caylak";
const SANDBOXED_AT = new Date("2026-02-01T00:00:00Z");
const AT = new Date("2026-01-01T00:00:00Z");

/** The one axis under test: does the read carry a viewer the mask yields to? */
const lifted = (opts?: {sandboxViewer?: SandboxViewer | undefined}): boolean =>
	opts?.sandboxViewer?.canSeeSandboxed === true;

const postRow = {
	id: "p1",
	slug: "caylak-gonderi",
	title: "çaylak gönderisi",
	url: null,
	host: null,
	body: "gövde",
	author: "caylak",
	authorId: CAYLAK,
	score: 0,
	commentCount: 0,
	createdAt: AT,
	myVote: null,
	isSaved: null,
	tags: [] as never[],
};

const commentRow = {
	id: "c1",
	parentId: null,
	author: "caylak",
	authorId: CAYLAK,
	body: "çaylak yorumu",
	score: 0,
	createdAt: AT,
	updatedAt: AT,
	deletedAt: null,
	myVote: null,
};

const definitionRow = {
	id: "d1",
	body: "çaylak tanımı",
	score: 0,
	author: "caylak",
	authorId: CAYLAK,
	createdAt: AT,
	updatedAt: AT,
	myVote: null,
};

const proxyOver = <T extends object>(service: string, impl: Partial<T>): T =>
	new Proxy(impl, {
		get(t, prop) {
			if (prop in t) return (t as Record<string, unknown>)[prop as string];
			return () => Effect.die(`${service}.${String(prop)} not exercised`);
		},
	}) as T;

const relationStoreOf = (holders: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: (tuple) =>
			Effect.succeed(tuple.relation === "moderates" && holders.includes(tuple.subject)),
		hasSubjects: ({subjects, relation}) =>
			Effect.succeed(
				new Set(relation === "moderates" ? subjects.filter((s) => holders.includes(s)) : []),
			),
		subjectsOf: ({relation}) => Effect.succeed(new Set(relation === "moderates" ? holders : [])),
	});

const moderatorContext = (actor: Actor = human(MOD)) =>
	Layer.mergeAll(
		relationStoreOf([MOD]),
		Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Layer.succeed(CurrentActor, {actor}),
	);

const group = (targetKind: OpenReportGroup["targetKind"], targetId: string): OpenReportGroup => ({
	targetKind,
	targetId,
	reportCount: 1,
	reason: "spam",
	firstReportedAt: AT,
});

// Every author-standing read answers uniformly — the reputation cluster is not what this
// file pins, so it stays out of the way of the context assertions.
const standingStubs = Layer.mergeAll(
	makeKunyeStub({
		tierOf: () => Effect.succeed<Tier>("çaylak"),
		karmaOf: () => Effect.succeed(0),
	}),
	makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(false)}),
);

const reportStubForOpen = (groups: ReadonlyArray<OpenReportGroup>) =>
	makeReportStub({
		listOpen: () => Effect.succeed(groups),
		countRemovalsByAuthors: () => Effect.succeed(new Map()),
		productionCountsByAuthors: () => Effect.succeed(new Map()),
		countOpenReportedTargetsByAuthors: () => Effect.succeed(new Map()),
		reporterDiversity: () => Effect.succeed(new Map()),
	});

// Each read yields the sandboxed row ONLY to a viewer whose mask is lifted, mirroring
// `sandboxVisibleWhere`'s `canSeeSandboxed` short-circuit.
const maskedPano = Layer.succeed(
	Pano,
	proxyOver<typeof Pano.Service>("Pano", {
		getPostsByIds: (_ids, opts) => Effect.succeed(lifted(opts) ? [postRow] : []),
		getCommentsByIds: (_ids, opts) => Effect.succeed(lifted(opts) ? [commentRow] : []),
		lookupCommentPostId: () => Effect.succeed("p-parent"),
	} as Partial<typeof Pano.Service>),
);

const maskedSozluk = Layer.succeed(
	Sozluk,
	proxyOver<typeof Sozluk.Service>("Sozluk", {
		getDefinitionsByIds: (_ids, opts) => Effect.succeed(lifted(opts) ? [definitionRow] : []),
		lookupDefinitionTermSlug: () => Effect.succeed("kelime"),
	} as Partial<typeof Sozluk.Service>),
);

const listOpen = (groups: ReadonlyArray<OpenReportGroup>) =>
	resolveWire(lists["report.listOpen"], {
		args: {},
		select: ["id", "targetKind", "targetExcerpt", "targetAuthor", "targetRef"],
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				reportStubForOpen(groups),
				maskedPano,
				maskedSozluk,
				standingStubs,
				moderatorContext(),
			),
		),
	);

describe("report.listOpen — a still-sandboxed target hydrates for the moderator (#6472)", () => {
	it.effect("a reported sandboxed post renders its excerpt, author and target link", () =>
		Effect.gen(function* () {
			const result = yield* listOpen([group("post", "p1")]);
			const node = result.items[0]?.node;
			assert.deepStrictEqual(
				{
					excerpt: node?.targetExcerpt,
					author: node?.targetAuthor,
					ref: node?.targetRef,
					authorId: node?.authorId,
				},
				{excerpt: "çaylak gönderisi", author: "caylak", ref: "p1", authorId: CAYLAK},
			);
		}),
	);

	it.effect("a reported sandboxed comment renders and routes to its parent post", () =>
		Effect.gen(function* () {
			const result = yield* listOpen([group("comment", "c1")]);
			const node = result.items[0]?.node;
			assert.deepStrictEqual(
				{excerpt: node?.targetExcerpt, author: node?.targetAuthor, ref: node?.targetRef},
				{excerpt: "çaylak yorumu", author: "caylak", ref: "p-parent"},
			);
		}),
	);

	it.effect("a reported sandboxed definition renders and routes to its term slug", () =>
		Effect.gen(function* () {
			const result = yield* listOpen([group("definition", "d1")]);
			const node = result.items[0]?.node;
			assert.deepStrictEqual(
				{excerpt: node?.targetExcerpt, author: node?.targetAuthor, ref: node?.targetRef},
				{excerpt: "çaylak tanımı", author: "caylak", ref: "kelime"},
			);
		}),
	);

	it.effect("all three kinds hydrate in one queue read", () =>
		Effect.gen(function* () {
			const result = yield* listOpen([
				group("post", "p1"),
				group("comment", "c1"),
				group("definition", "d1"),
			]);
			assert.deepStrictEqual(
				result.items.map((i) => i.node.targetExcerpt),
				["çaylak gönderisi", "çaylak yorumu", "çaylak tanımı"],
			);
		}),
	);
});

const recordingPublisher = () => {
	const recorded: Array<string> = [];
	const scheduled: Array<Promise<unknown>> = [];
	const layer = Layer.mergeAll(
		Layer.succeed(LivePublisher)(
			livePublisherFor({
				publish: (topicKey) =>
					Effect.sync(() => {
						recorded.push(topicKey);
					}),
				waitUntil: (promise) => {
					scheduled.push(promise);
				},
			}),
		),
		noopPanoFeedCache,
	);
	return {recorded, scheduled, layer};
};

class DrainRejected extends Schema.TaggedErrorClass<DrainRejected>()("test/DrainRejected", {
	cause: Schema.Unknown,
}) {}

const restorePost = (sandboxedAt: Date | null, seen: Array<SandboxViewer | undefined>) => {
	const {recorded, scheduled, layer} = recordingPublisher();
	const pano = Layer.succeed(
		Pano,
		proxyOver<typeof Pano.Service>("Pano", {
			moderateRestorePost: () => Effect.succeed({restored: true, sandboxedAt}),
			getPostsByIds: (_ids, opts) =>
				Effect.sync(() => {
					seen.push(opts?.sandboxViewer);
					return lifted(opts) ? [postRow] : [];
				}),
		} as Partial<typeof Pano.Service>),
	);
	const run = Effect.gen(function* () {
		yield* mutations["report.restore"].handler({
			input: {targetKind: "post", targetId: TargetId.make("p1")},
			select: ["id"],
		});
		yield* Effect.tryPromise({
			try: () => Promise.allSettled(scheduled),
			catch: (cause) => new DrainRejected({cause}),
		}).pipe(Effect.orDie);
		return recorded;
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				makeReportStub({
					lookupReportTarget: () => Effect.succeed({targetKind: "post", targetId: "p1"}),
					firstOpenReportId: () => Effect.succeed("r1"),
					reopenForTarget: () => Effect.succeed({reopened: 1}),
				}),
				pano,
				Layer.succeed(Sozluk, proxyOver<typeof Sozluk.Service>("Sozluk", {})),
				layer,
				moderatorContext(),
			),
		),
	);
	return run;
};

describe("report.publishRestored — the re-read reaches the publish gate (#6472)", () => {
	it.effect("a still-sandboxed restore re-reads as the moderator, not anonymously", () =>
		Effect.gen(function* () {
			const seen: Array<SandboxViewer | undefined> = [];
			const recorded = yield* restorePost(SANDBOXED_AT, seen);
			assert.deepStrictEqual(seen, [
				{viewerId: MOD, canSeeSandboxed: true, seesSandboxedInPlace: false},
			]);
			// The row now comes back, and `decidePublish` — not a masked read — is what holds
			// the broadcast off the viewer-blind public feed (#1205/#1280).
			assert.deepStrictEqual(recorded, []);
		}),
	);

	it.effect("a restore that lands LIVE still re-appends to the public feed", () =>
		Effect.gen(function* () {
			const seen: Array<SandboxViewer | undefined> = [];
			const recorded = yield* restorePost(null, seen);
			assert.deepStrictEqual(recorded, [liveGlobalConnectionTopic("posts")]);
		}),
	);
});
