/**
 * Live bildirim delivery over SSE (#1700, epic #1666): a recipient subscribed to their
 * own `NotificationChannel` gets the fresh unread count live, and a subscription to
 * ANOTHER user's channel is refused at the topic-authorization seam.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027) — shared-safe because
 * the publish is an ENTITY `update` on `NotificationChannel:<recipientId>` and the
 * per-file NS-unique recipient makes that topic unique to this file.
 *
 * FLAG GATING. The bildirim surface ships dark behind the default-off
 * `phoenix-bildirim` flag: with it off nothing records and nothing publishes. The
 * integration stage runs `ENVIRONMENT=development`, so the dev-only override wrapper
 * (#622) is installed and this test flips the flag on for its own requests via the
 * `phoenix_flag_overrides` cookie. The default-off gate is proven at the unit tier.
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
	author = await h.signUpYazar(`${NS}-author-${Date.now()}@test.local`, "hunter2hunter2", "yazar");
	commenter = await h.signUpYazar(
		`${NS}-commenter-${Date.now()}@test.local`,
		"hunter2hunter2",
		"yorumcu",
	);
});

describe("live views — /fate/live (bildirim delivery)", () => {
	it("subscribe(channel) → a reply to my post → the unread count arrives live", async () => {
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
		// See ADR 0154.
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

		// Drain until our own channel frame arrives, racing a 10s deadline so a lost
		// publish fails here rather than eating the full test budget.
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
		expect(subResult.results[0]?.ok).toBe(false);

		await reader.cancel();
	});
});
