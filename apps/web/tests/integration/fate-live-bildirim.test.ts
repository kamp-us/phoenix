/**
 * Live bildirim delivery over SSE (#1700, epic #1666) — the notification twin of the
 * reaction-count fan-out (`fate-live-reactions.test.ts`), proven end-to-end: a
 * recipient subscribed to their own `NotificationChannel` entity receives the fresh
 * unread count the moment another user's action records a notification, so the badge +
 * center reconcile without a refresh (AC1/AC2/AC4). The cross-user case proves the
 * recipient-scoping AC (AC3): a subscription to ANOTHER user's channel is rejected at
 * the topic-authorization seam (`fate-live/route.ts`), so no user watches another's
 * notification stream.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027) — shared-safe like the
 * reactions case: the notification publish is an ENTITY `update` on the recipient's
 * `NotificationChannel:<recipientId>` topic, and a per-file NS-unique recipient makes
 * that entity topic unique to this file, so a concurrent file's write can't land a
 * frame on this subscription.
 *
 * FLAG GATING. The whole bildirim surface (including this live path) ships dark behind
 * the default-off `phoenix-bildirim` flag: with it off nothing records and nothing
 * publishes. The integration stage runs `ENVIRONMENT=development`, so the dev-only
 * override wrapper (#622) is installed — this test flips the flag on for its own
 * requests via the `phoenix_flag_overrides` cookie. The default-off gate is proven at
 * the unit tier; here we drive the flag-ON live path the override unlocks.
 *
 * The notification is triggered through the PUBLIC seam — a `comment.add` reply to a
 * post notifies the post's author (`notifyCommentReply`) — the same seam the app uses.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {frameData, readEvent, readFrame} from "./_harness.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

// Forces `phoenix-bildirim` on for a single request (#622 — `phoenix_flag_overrides`,
// a URL-encoded JSON `{key: boolean}` map). Only honored because the integration stage
// runs `ENVIRONMENT=development`.
const BILDIRIM_ON_COOKIE = `phoenix_flag_overrides=${encodeURIComponent(
	JSON.stringify({"phoenix-bildirim": true}),
)}`;

let author: {userId: string; cookie: string};
let commenter: {userId: string; cookie: string};

beforeAll(async () => {
	author = await h.signUp(`${NS}-author-${Date.now()}@test.local`, "hunter2hunter2", "yazar");
	commenter = await h.signUp(
		`${NS}-commenter-${Date.now()}@test.local`,
		"hunter2hunter2",
		"yorumcu",
	);
});

describe("live views — /fate/live (bildirim delivery)", () => {
	it("subscribe(channel) → a reply to my post → the unread count arrives live", async () => {
		// The author submits a post; a reply to it records a notification for the author.
		// `post.submit`'s wire input requires a non-empty `tags` array (`SubmitPostInput`,
		// `pano/mutations.ts`) and the service rejects an empty tag list with `TagsRequired`
		// before any DB call (`normalizeSubmitTags`, `pano/post-operations.ts`) — so a
		// tagless submit returns `ok:false` and never creates the post to reply to. Supply a
		// real tag kind (`soru`, from the fixed `POST_TAG_KINDS` enum).
		const posted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `${NS} canlı bildirim`,
					url: "https://example.com/1700",
					tags: [{kind: "soru"}],
				},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		// SETUP DISCRIMINATOR (fail fast, before the SSE read). The post is the precondition
		// for the reply that records the notification; assert its id on the DIRECT response so
		// a rejected submit (missing/invalid tags, unauth) fails HERE with a named cause in
		// milliseconds instead of masquerading as a lost-frame delivery timeout downstream.
		// See ADR: integration-tier-is-ci-only.
		const postId = (posted.ok ? (posted.data as {id: string}).id : "") as string;
		expect(
			postId,
			`post.submit setup failed (ok=${posted.ok}${
				posted.ok ? "" : ` code=${posted.error.code}`
			}) — no post created to reply to; the live-delivery path never runs`,
		).toBeTruthy();

		const connectionId = `${NS}-bildirim-${Date.now()}`;
		const connect = await h.openSse(connectionId, author.cookie);
		expect(connect.status).toBe(200);

		const reader = connect.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		const connected = await readFrame(reader, decoder, buffer);
		expect(connected).toContain("connected");

		// Subscribe to the author's OWN NotificationChannel entity — the exact topic
		// `Notification.record → live.update("NotificationChannel", recipientId, …)`
		// republishes the unread count to. The id is the author's own user id (the
		// recipient-scoping the route enforces).
		const sub = await h.liveControl(
			connectionId,
			[
				{
					kind: "subscribe",
					id: "sub-channel",
					type: "NotificationChannel",
					entityId: author.userId,
					select: ["id", "unreadCount"],
				},
			],
			author.cookie,
		);
		expect(sub.status).toBe(200);
		const subResult = (await sub.json()) as {results: Array<{id: string; ok: boolean}>};
		expect(subResult.results[0]?.ok).toBe(true);

		// The commenter replies to the author's post — the flag-override cookie unlocks
		// the dark-shipped record + live-publish path; recording the notification
		// republishes the author's channel with the fresh unread count.
		const replied = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "canlı yanıt"},
				select: ["id"],
			},
			{cookie: `${commenter.cookie}; ${BILDIRIM_ON_COOKIE}`},
		);
		expect(replied.ok).toBe(true);

		// The subscribed stream delivers the channel update as an entity `next` frame
		// whose `event.data` carries the author's fresh unread count. Drain until our
		// own channel frame (unreadCount >= 1) arrives, racing a 10s deadline so a lost
		// publish fails here in ~10s rather than the full test budget.
		type ChannelNext = {kind: string; event: {data: {id: string; unreadCount: number}}};
		const READ_DEADLINE_MS = 10_000;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			deadlineTimer = setTimeout(
				() => reject(new Error("no NotificationChannel frame within 10s — frame lost in delivery")),
				READ_DEADLINE_MS,
			);
		});
		let payload: ChannelNext | undefined;
		try {
			for (let i = 0; i < 10 && (payload?.event.data.unreadCount ?? 0) < 1; i++) {
				const frame = await Promise.race([readEvent(reader, decoder, buffer), deadline]);
				expect(frame).toContain("event: next");
				payload = frameData<ChannelNext>(frame);
			}
		} finally {
			clearTimeout(deadlineTimer);
		}
		expect(payload?.kind).toBe("next");
		expect(payload?.event.data.id).toBe(author.userId);
		expect(payload?.event.data.unreadCount).toBeGreaterThanOrEqual(1);

		await reader.cancel();
	});

	it("rejects a subscription to ANOTHER user's NotificationChannel (recipient-scoped, AC3)", async () => {
		// The commenter opens their own connection and tries to subscribe to the
		// AUTHOR's channel. The topic id is client-supplied, and the DO's owner check
		// only guards the connection owner — the route's recipient-scoping gate is what
		// refuses the cross-user subscribe (`ok: false`), so no frame ever reaches a
		// foreign watcher.
		const connectionId = `${NS}-foreign-${Date.now()}`;
		const connect = await h.openSse(connectionId, commenter.cookie);
		expect(connect.status).toBe(200);
		const reader = connect.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		expect(await readFrame(reader, decoder, buffer)).toContain("connected");

		const sub = await h.liveControl(
			connectionId,
			[
				{
					kind: "subscribe",
					id: "sub-foreign",
					type: "NotificationChannel",
					entityId: author.userId,
					select: ["id", "unreadCount"],
				},
			],
			commenter.cookie,
		);
		expect(sub.status).toBe(200);
		const subResult = (await sub.json()) as {results: Array<{id: string; ok: boolean}>};
		// The cross-user subscribe is refused at the topic-authorization seam.
		expect(subResult.results[0]?.ok).toBe(false);

		await reader.cancel();
	});
});
