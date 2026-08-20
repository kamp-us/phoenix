/**
 * Regression coverage for #2213: voting an already-saved post must not clobber its
 * saved state or author identity, in the client cache or the fanned live frame.
 *
 * The defect was that both resolvers shaped their return from the write result, which
 * carries neither `isSaved` nor resolved author identity, so the client cache-merge
 * overwrote the real values with nulls. The fix re-resolves the post through the same
 * batched read `post.save`/`post.unsave` use.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import type {PublishMessage} from "../fate-live/protocol.ts";
import {sandboxViewerLayer} from "../kunye/sandbox.testing.ts";
import {Mute} from "../mute/Mute.ts";
import {mutations} from "./mutations.ts";
import {Pano, type PostSummaryRow, type VoteOnPostResult} from "./Pano.ts";

const VOTER = {id: "u-voter", email: "voter@example.com", name: "voter"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "test",
	id: "test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// Deliberately carries neither `isSaved` nor resolved author identity: this is the
// exact shape that used to leak nulls into the cache.
const writeResult = (overrides: Partial<VoteOnPostResult> = {}): VoteOnPostResult => ({
	postId: "post_1",
	title: "başlık",
	url: null,
	host: null,
	body: "gövde",
	authorId: "u-author",
	authorName: "yaz-adı",
	score: 1,
	hotScore: 1,
	commentCount: 0,
	tags: [],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	myVote: true,
	changed: true,
	...overrides,
});

// The projection the fix must echo back on both the return and the publish.
const savedRow = (): PostSummaryRow => ({
	id: "post_1",
	slug: "post-1",
	title: "başlık",
	url: null,
	host: null,
	body: "gövde",
	author: "yaz-adı",
	authorId: "u-author",
	authorUsername: "elif",
	authorDisplayName: "Elif Yılmaz",
	score: 1,
	commentCount: 0,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	tags: [],
	myVote: true,
	isSaved: true,
	isDraft: null,
});

// Every unscripted method dies loudly, pinning the vote path to `voteOnPost` /
// `retractPostVote` then `getPostsByIds`.
const panoStub = (methods: Partial<typeof Pano.Service>): Layer.Layer<Pano> =>
	Layer.succeed(
		Pano,
		new Proxy(methods, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Pano.${String(prop)} not exercised in vote-preserves-saved-state`);
			},
		}) as typeof Pano.Service,
	);

// Pushing inside the `publish` builder body captures synchronously, before
// `waitUntil` detaches the work.
const recordingLive = (frames: PublishMessage[]): Layer.Layer<LivePublisher> =>
	Layer.succeed(LivePublisher)(
		livePublisherFor({
			publish: (_topicKey, message) => {
				frames.push(message);
				return Effect.void;
			},
			waitUntil: () => {},
		}),
	);

const publishedData = (frames: PublishMessage[]): Record<string, unknown> | undefined => {
	const entity = frames.find((m) => m.kind === "entity");
	if (!entity || entity.kind !== "entity" || "delete" in entity.frame) return undefined;
	return entity.frame.data as Record<string, unknown> | undefined;
};

// The vote path fires the flag-gated `notifyContentVote` emitter and re-resolves the
// post through the real sandbox viewer (#6424), so the residual context carries every
// service both read. `flagOn: true` exercises the notification emit (the recording stub
// swallows it — the wiring is proven in `bildirim/vote-emitters.unit.test.ts`); the
// voter is a plain not-opted-in, non-moderator yazar, so the re-read's mask is today's.
const viewerAxes = sandboxViewerLayer({
	flagOn: true,
	tier: "yazar",
	preference: {optedIn: false},
	viewerId: VOTER.id,
	isModerator: false,
});

const notificationStub = makeNotificationStub({
	recordAggregate: () => Effect.succeed({aggregated: false}),
});

// An empty-set `Mute` stub means nobody is muted, so the deliver path is unchanged.
const noMutes = Layer.succeed(Mute, {
	set: () => Effect.die("Mute.set not exercised"),
	listMine: () => Effect.die("Mute.listMine not exercised"),
	readMutedIds: () => Effect.succeed(new Set<string>()),
});

const drive = (
	op: (typeof mutations)["post.vote" | "post.retractVote"],
	pano: Layer.Layer<Pano>,
	frames: PublishMessage[],
) =>
	resolveWire(op, {
		input: {id: "post_1"},
		select: ["id", "isSaved", "authorUsername", "authorDisplayName", "myVote", "score"],
	}).pipe(
		Effect.provide(
			Layer.mergeAll(pano, recordingLive(frames), viewerAxes, notificationStub, noMutes),
		),
		Effect.provideService(CurrentUser, {user: VOTER}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

describe("post.vote — voting a saved post preserves isSaved + author identity (#2213)", () => {
	it.effect("the returned projection carries isSaved:true and real identity, not null", () =>
		Effect.gen(function* () {
			const frames: PublishMessage[] = [];
			const post = (yield* drive(
				mutations["post.vote"],
				panoStub({
					voteOnPost: () => Effect.succeed(writeResult()),
					getPostsByIds: () => Effect.succeed([savedRow()]),
				}),
				frames,
			)) as Record<string, unknown>;
			assert.strictEqual(post.isSaved, true, "returned isSaved is the real server state, not null");
			assert.strictEqual(post.authorUsername, "elif", "returned authorUsername is resolved");
			assert.strictEqual(
				post.authorDisplayName,
				"Elif Yılmaz",
				"returned authorDisplayName is resolved",
			);
			assert.strictEqual(post.myVote, true);
			assert.strictEqual(post.score, 1);
		}),
	);

	it.effect(
		"the published /fate/live frame carries the same resolved projection (no null leak)",
		() =>
			Effect.gen(function* () {
				const frames: PublishMessage[] = [];
				yield* drive(
					mutations["post.vote"],
					panoStub({
						voteOnPost: () => Effect.succeed(writeResult()),
						getPostsByIds: () => Effect.succeed([savedRow()]),
					}),
					frames,
				);
				const data = publishedData(frames);
				assert.isDefined(data, "an entity update frame was published");
				assert.strictEqual(data?.isSaved, true, "the fanned frame keeps isSaved, not null");
				assert.strictEqual(data?.authorUsername, "elif", "the fanned frame keeps author identity");
				assert.strictEqual(data?.authorDisplayName, "Elif Yılmaz");
			}),
	);
});

describe("post.retractVote — shares the fix (#2213)", () => {
	it.effect("returned + published projection both keep isSaved:true and identity", () =>
		Effect.gen(function* () {
			const frames: PublishMessage[] = [];
			const post = (yield* drive(
				mutations["post.retractVote"],
				panoStub({
					retractPostVote: () => Effect.succeed(writeResult({myVote: false, score: 0})),
					getPostsByIds: () => Effect.succeed([{...savedRow(), myVote: false, score: 0}]),
				}),
				frames,
			)) as Record<string, unknown>;
			assert.strictEqual(post.isSaved, true, "retractVote also preserves isSaved");
			assert.strictEqual(post.authorUsername, "elif");
			const data = publishedData(frames);
			assert.strictEqual(data?.isSaved, true, "the fanned retract frame keeps isSaved too");
			assert.strictEqual(data?.authorDisplayName, "Elif Yılmaz");
		}),
	);
});
