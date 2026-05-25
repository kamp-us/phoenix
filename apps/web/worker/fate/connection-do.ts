/**
 * `ConnectionDO` — the connection-role half of phoenix's live fan-out (ADR 0023,
 * split out of the former one-class `LiveDO` per ADR 0025).
 *
 * One instance per client connection, named `connection:<connectionId>`. It owns
 * one client's **open SSE stream** (the `ReadableStream` controller), that
 * connection's **subscription list**, and the persisted **`generation`**. Holds
 * the validated owner so a control message cannot subscribe on another user's
 * behalf. The open stream pins this DO in memory (no hibernation — see ADR 0023's
 * escape-hatch note), so the controller + subscription list live in memory, not
 * storage; only `generation` is persisted (so it survives eviction and uniquely
 * identifies one stream lifetime — a reconnect after eviction always lands on a
 * higher generation than any stale subscriber row a topic DO still holds).
 *
 * The DO does **no** database work and has **no** Effect runtime: it writes the
 * fate-protocol frame a {@link TopicDO} hands it to its held stream verbatim.
 *
 * Cross-role direction is enforced by the binding: subscribe/unsubscribe resolve
 * topic stubs only through `TOPIC_DO`, which is typed to {@link TopicDO}. There
 * is no binding through which this class can reach a connection instance — a
 * connection→connection call is unrepresentable.
 *
 * Imports `cloudflare:workers`, so only the worker entry (`index.ts`, for the
 * `CONNECTION_DO` binding) pulls this in — not the fate codegen graph. The wire
 * shapes are shared via `live-protocol.ts`.
 */
import {DurableObject} from "cloudflare:workers";
import type {DeliverFrame, SubscribeControl} from "./live-protocol.ts";
import {encodeFrame, SSE_HEADERS, topicsForSubscribe} from "./live-protocol.ts";
import type {TopicDO} from "./topic-do.ts";

/** Storage key for the persisted generation counter (survives eviction). */
const GENERATION_KEY = "generation";

export class ConnectionDO extends DurableObject<Env> {
	// In-memory state. The open SSE stream pins this DO in memory (no hibernation
	// — see ADR 0023's escape-hatch note), so the controller + subscription list
	// live in memory, not storage.
	private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	private encoder = new TextEncoder();
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private ownerId: string | undefined;
	/**
	 * Current generation, cached in memory. `undefined` until first read from
	 * storage. Persisted under {@link GENERATION_KEY} so it survives DO eviction —
	 * an in-memory-only counter would reset to 0 on eviction and let a reconnect
	 * collide with a stale subscriber row.
	 */
	private generation: number | undefined;
	/** subId → topics this connection's subscription is registered under. */
	private subscriptions = new Map<string, {topics: ReadonlyArray<string>}>();

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/connect":
				return this.openStream(request);
			case "/subscribe":
				return this.subscribe(request);
			case "/unsubscribe":
				return this.unsubscribe(request);
			case "/deliver":
				return this.deliver(request);
			case "/probe":
				return this.probe();
			default:
				return new Response("Not found", {status: 404});
		}
	}

	/**
	 * Read the persisted generation into the in-memory cache, defaulting to 0 the
	 * first time. Persisted in DO storage so it survives eviction.
	 */
	private async loadGeneration(): Promise<number> {
		if (this.generation === undefined) {
			this.generation = (await this.ctx.storage.get<number>(GENERATION_KEY)) ?? 0;
		}
		return this.generation;
	}

	/** Open the SSE stream. `ownerId` is the validated session user, passed by the route. */
	private async openStream(request: Request): Promise<Response> {
		const ownerId = new URL(request.url).searchParams.get("ownerId") ?? undefined;
		// A reconnect on the same connection name bumps the generation so the topic
		// DOs' rows from the prior stream are detected stale on next deliver. The
		// counter is persisted, so a reconnect after eviction still lands on a
		// higher generation than any stale row (no collision/cross-talk).
		const next = (await this.loadGeneration()) + 1;
		this.generation = next;
		await this.ctx.storage.put(GENERATION_KEY, next);
		this.ownerId = ownerId;
		this.subscriptions.clear();
		this.closeStream();

		const stream = new ReadableStream<Uint8Array>({
			cancel: () => this.closeStream(),
			start: (controller) => {
				this.controller = controller;
				controller.enqueue(this.encoder.encode(": connected\n\n"));
				this.heartbeat = setInterval(() => {
					if (!this.controller) {
						return;
					}
					try {
						this.controller.enqueue(this.encoder.encode(": heartbeat\n\n"));
					} catch {
						this.closeStream();
					}
				}, 25_000);
			},
		});
		return new Response(stream, {headers: SSE_HEADERS});
	}

	private closeStream(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		if (this.controller) {
			try {
				this.controller.close();
			} catch {
				// Already closed.
			}
			this.controller = undefined;
		}
	}

	/** Record a subscription on this connection + register it on its topic DOs. */
	private async subscribe(request: Request): Promise<Response> {
		const {control, ownerId} = (await request.json()) as {
			control: SubscribeControl;
			ownerId: string | undefined;
		};
		// A control message cannot subscribe on another user's behalf.
		if ((this.ownerId ?? undefined) !== (ownerId ?? undefined)) {
			return new Response("Forbidden", {status: 403});
		}
		const connectionId = this.ctx.id.toString();
		const topics = topicsForSubscribe(control);
		this.subscriptions.set(control.subId, {topics});
		const generation = await this.loadGeneration();
		await Promise.all(
			topics.map((topic) =>
				this.topicStub(topic).fetch("https://live/register", {
					method: "POST",
					body: JSON.stringify({
						connectionId,
						subId: control.subId,
						generation,
					}),
				}),
			),
		);
		return Response.json({ok: true});
	}

	/** Drop a subscription + deregister it from its topic DOs. */
	private async unsubscribe(request: Request): Promise<Response> {
		const {subId} = (await request.json()) as {subId: string};
		const sub = this.subscriptions.get(subId);
		if (!sub) {
			return Response.json({ok: true});
		}
		this.subscriptions.delete(subId);
		const connectionId = this.ctx.id.toString();
		await Promise.all(
			sub.topics.map((topic) =>
				this.topicStub(topic).fetch("https://live/deregister", {
					method: "POST",
					body: JSON.stringify({connectionId, subId}),
				}),
			),
		);
		return Response.json({ok: true});
	}

	/** Write a frame to the held SSE stream. Called by a topic DO on publish. */
	private async deliver(request: Request): Promise<Response> {
		const {frame, generation} = (await request.json()) as {
			frame: DeliverFrame;
			generation: number;
		};
		const current = await this.loadGeneration();
		// Stale: the row was registered by an earlier stream generation, or this
		// connection has no open stream. Report the current generation so the topic
		// DO can prune the row.
		if (generation !== current || !this.controller) {
			return Response.json({delivered: false, generation: current});
		}
		// Only deliver if the subscription is still active on this connection.
		if (!this.subscriptions.has(frame.id)) {
			return Response.json({delivered: false, generation: current});
		}
		try {
			this.controller.enqueue(this.encoder.encode(encodeFrame(frame)));
		} catch {
			this.closeStream();
			return Response.json({delivered: false, generation: current});
		}
		return Response.json({delivered: true, generation: current});
	}

	/**
	 * Report this connection's current generation without touching the stream.
	 * Used by a topic DO's `alarm()` to detect orphaned subscriber rows (a row
	 * whose connection has reconnected to a higher generation, or whose DO was
	 * evicted) without enqueueing a probe frame onto the controller.
	 */
	private async probe(): Promise<Response> {
		return Response.json({generation: await this.loadGeneration()});
	}

	/**
	 * The topic-role DO stub for a topic key. Resolved through `TOPIC_DO` (typed
	 * to {@link TopicDO}), so register/deregister can only ever reach a topic
	 * instance — a connection→connection call has no binding.
	 */
	private topicStub(topicKey: string): DurableObjectStub<TopicDO> {
		return this.env.TOPIC_DO.get(this.env.TOPIC_DO.idFromName(`topic:${topicKey}`));
	}
}
