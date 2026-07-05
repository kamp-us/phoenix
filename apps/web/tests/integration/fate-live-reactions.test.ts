/**
 * Live reaction-count reconcile over SSE (#1868, epic #1840) — the reaction twin of
 * the vote-score fan-out, proven end-to-end at the integration tier: a subscriber on a
 * target's live topic receives the fresh per-emoji aggregate the moment another user
 * reacts, so a reader watching an item sees the count move (AC2/AC4).
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027) — shared-safe like the
 * `definition.add → appendNode` case in `fate-live-scoped.test.ts`. The reaction publish
 * is an ENTITY `update` frame keyed by the definition's id (`live.definition.update`,
 * `sozluk/live.ts`): a per-entity topic (`Definition:<id>`), not a global connection. An
 * `NS`-unique seeded definition makes that entity topic unique to this file, so a
 * concurrent file's reaction can't land a frame on this subscription.
 *
 * FLAG GATING (AC3). `definition.react` ships dark behind the default-off
 * `phoenix-reactions` flag: with it off the react is inert and nothing publishes. The
 * integration stage deploys with `ENVIRONMENT=development` (`_integration.ts`
 * `ensureIntegrationEnv`), so the dev-only override wrapper (`FlagsDevOverrideLive`,
 * #622) is installed — this test flips the flag on for its own request by sending the
 * `phoenix_flag_overrides` cookie alongside the session cookie. The default-off gate is
 * proven separately at the unit tier (`definition-reaction-mutation.unit.test.ts`); here
 * we drive the flag-ON live path the override unlocks.
 *
 * See the package seam (`fate-live/cold-start-retry.ts`, #842) for why there is no
 * harness warm-retry wrapper here — the production worker retries a cold-DO transport
 * failure itself.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {frameData, readEvent, readFrame} from "./_harness.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

// The dev-override cookie that forces `phoenix-reactions` on for a single request
// (#622 — `phoenix_flag_overrides`, a URL-encoded JSON `{key: boolean}` map). Only ever
// honored because the integration stage runs `ENVIRONMENT=development`.
const REACTIONS_ON_COOKIE = `phoenix_flag_overrides=${encodeURIComponent(
	JSON.stringify({"phoenix-reactions": true}),
)}`;

let user: {userId: string; cookie: string};

beforeAll(async () => {
	user = await h.signUp(`${NS}-${Date.now()}@test.local`, "hunter2hunter2", "canlı");
});

describe("live views — /fate/live (reaction-count reconcile)", () => {
	it("subscribe(definition) → definition.react → update frame carries the fresh aggregate", async () => {
		// Seed an NS-unique definition so its entity topic (`Definition:<id>`) is unique
		// to this file on the shared stage.
		const slug = `${NS}-tepki-${Date.now()}`;
		const seeded = await h.seedTerm({
			slug,
			title: "tepki terimi",
			definitions: [{authorName: "yazar", body: "canlı tepki tanımı"}],
		});
		const definitionId = seeded.definitions[0]!.id;

		const connectionId = `${NS}-react-${Date.now()}`;
		const connect = await h.openSse(connectionId, user.cookie);
		expect(connect.status).toBe(200);

		const reader = connect.body!.getReader();
		const decoder = new TextDecoder();
		const buffer = {value: ""};
		const connected = await readFrame(reader, decoder, buffer);
		expect(connected).toContain("connected");

		// Subscribe to the single definition ENTITY — the exact topic
		// `live.definition.update(id, …)` publishes the reaction-count delta to.
		const sub = await h.liveControl(
			connectionId,
			[
				{
					kind: "subscribe",
					id: "sub-def",
					type: "Definition",
					entityId: definitionId,
					select: ["id", "reactions"],
				},
			],
			user.cookie,
		);
		expect(sub.status).toBe(200);
		// Assert the DO ACCEPTED the entity subscription — a 200 envelope can still
		// carry `results: [{ok: false}]` when the connection DO rejects the register
		// (e.g. its held-stream queue isn't bound yet), which would silently drop the
		// publish and time out the read below. Registering the row is the precondition
		// for delivery, so gate on it, mirroring `fate-live-scoped`'s proven flow.
		const subResult = (await sub.json()) as {results: Array<{id: string; ok: boolean}>};
		expect(subResult.results[0]?.ok).toBe(true);

		// React on the definition — the flag-override cookie unlocks the dark-shipped
		// write + live-publish path; the mutation publishes an entity `update` frame
		// carrying the fresh per-emoji aggregate to the subscribed connection.
		const reacted = await h.fate(
			{
				kind: "mutation",
				name: "definition.react",
				input: {id: definitionId, emoji: "👍"},
				select: ["id", "reactions"],
			},
			{cookie: `${user.cookie}; ${REACTIONS_ON_COOKIE}`},
		);
		expect(reacted.ok).toBe(true);

		// CAUSE-1 DISCRIMINATOR (fail fast, before the SSE read). The DIRECT mutation
		// return — not a streamed frame — carries the fresh aggregate ONLY on the flag-ON
		// path: flag-ON returns `toDefinition(reactToDefinition(...))` with the reactor's
		// own emoji stamped (`myReaction === "👍"`), while the dark-ship OFF branch returns
		// the inert pre-reaction re-resolve (`toDefinition(current)`) whose `myReaction` is
		// `null` — yet BOTH return `ok: true`, so the `ok` check above cannot tell them
		// apart. Asserting the reactor's emoji on the direct response makes a silently
		// ineffective flag override fail HERE in milliseconds instead of hanging the SSE
		// read for the full test budget. `reacted.data` is the mutation's returned
		// DefinitionView (`select: ["id", "reactions"]`).
		const directReaction = (reacted.ok ? reacted.data : undefined) as
			| {reactions?: {myReaction: string | null}}
			| undefined;
		expect(
			directReaction?.reactions?.myReaction,
			`expected direct react response myReaction=👍 (flag ON), got ${JSON.stringify(
				directReaction?.reactions?.myReaction ?? null,
			)} — phoenix-reactions flag did not take effect on the deployed stage`,
		).toBe("👍");

		// The subscribed stream delivers the reaction-count delta as an entity `next`
		// frame whose `event.data` is the re-resolved definition with its updated
		// aggregate (the `myReaction` + per-emoji `counts` the reaction bar reconciles to).
		//
		// Drain until THIS reaction's own frame arrives, mirroring the proven
		// `fate-live-posts` drain-until-own-frame flow: on a `NO_DESTROY` re-run the
		// entity topic's replay buffer can hold a prior run's `next` frame for the same
		// seeded id, which would be the next frame ahead of ours. Match on our own
		// `myReaction === "👍"` rather than asserting the very next frame. Bounded: a
		// stream that never delivers our frame still fails (the 10s deadline below).
		type ReactionNext = {
			kind: string;
			event: {
				data: {
					id: string;
					reactions: {counts: Array<{emoji: string; count: number}>; myReaction: string | null};
				};
			};
		};
		//
		// CAUSE-2 DISCRIMINATOR (fail at ~10s, not the 120s test budget). The direct
		// response above proved the flag is ON and the mutation published, so a missing
		// frame now means the publish was LOST in delivery, not that the flag is off. The
		// held stream never closes, so `readEvent` would otherwise block on `reader.read()`
		// until the whole test times out with no signal — race every read against a shared
		// 10s deadline (a working delivery lands the frame in well under that). The read
		// stays non-vacuous: it still requires OUR own `myReaction === "👍"` frame to pass.
		const READ_DEADLINE_MS = 10_000;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			deadlineTimer = setTimeout(
				() =>
					reject(
						new Error(
							"no reaction update frame received within 10s (flag ON, publish fired) — frame lost in delivery",
						),
					),
				READ_DEADLINE_MS,
			);
		});
		let payload: ReactionNext | undefined;
		try {
			for (let i = 0; i < 10 && payload?.event.data.reactions.myReaction !== "👍"; i++) {
				const frame = await Promise.race([readEvent(reader, decoder, buffer), deadline]);
				expect(frame).toContain("event: next");
				payload = frameData<ReactionNext>(frame);
			}
		} finally {
			clearTimeout(deadlineTimer);
		}
		expect(payload?.kind).toBe("next");
		expect(payload?.event.data.id).toBe(definitionId);
		expect(payload?.event.data.reactions.myReaction).toBe("👍");
		expect(payload?.event.data.reactions.counts).toContainEqual({emoji: "👍", count: 1});

		await reader.cancel();
	});
});
