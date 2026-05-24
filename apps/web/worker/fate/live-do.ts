/**
 * `LiveDO` — the one Durable Object in phoenix (ADR 0023): cross-isolate live
 * view fan-out over SSE.
 *
 * One class, two roles, selected by the path of the `fetch` it receives:
 *   - **connection role** (instance named `connection:<connectionId>`) — owns one
 *     client's open SSE stream (the `ReadableStream` controller) and that
 *     connection's subscription list. Holds the validated owner so a control
 *     message cannot subscribe on another user's behalf.
 *   - **topic role** (instance named `topic:<topicKey>`) — owns the durable
 *     subscriber registry for one topic. Rows live in DO SQL storage (survive
 *     eviction); a `generation`/`revision` pair + a 60s `alarm()` prune stale
 *     rows.
 *
 * The DO does **no** database work and has **no** Effect runtime: publishes
 * carry the inline-resolved `data`/`node` the mutation already produced, and the
 * connection DO writes the fate-protocol frame to its held stream verbatim.
 *
 * Imports `cloudflare:workers`, so only the worker entry (`index.ts`, for the
 * `LIVE_DO` binding) pulls this in — not the fate codegen graph. The publish
 * side (`liveBus`) lives in `live.ts`; the wire shapes are shared via
 * `live-protocol.ts`.
 */
import {DurableObject} from "cloudflare:workers";
import type {DeliverFrame, PublishMessage, SubscribeControl} from "./live-protocol";
import {encodeFrame, SSE_HEADERS, topicsForSubscribe} from "./live-protocol";

/**
 * A topic-DO subscriber row: which connection (and which operation on it) wants
 * events for a topic. `generation`/`revision` capture the connection +
 * subscription identity at register time; on deliver the connection DO reports
 * its current generation and a mismatched row is pruned.
 */
interface SubscriberRow {
	connectionId: string;
	subId: string;
	generation: number;
	revision: number;
	updatedAt: number;
	// `sql.exec<T>` requires `T extends Record<string, SqlStorageValue>`; the
	// index signature satisfies that constraint over the named columns above.
	[column: string]: string | number;
}

export class LiveDO extends DurableObject<Env> {
	// Connection-role in-memory state. The open SSE stream pins this DO in memory
	// (no hibernation — see ADR 0023's escape-hatch note), so the controller +
	// subscription list live in memory, not storage.
	private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	private encoder = new TextEncoder();
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private ownerId: string | undefined;
	private generation = 0;
	/** subId → topics this connection's subscription is registered under. */
	private subscriptions = new Map<string, {topics: ReadonlyArray<string>}>();

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		state.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS subscribers (
				connectionId TEXT NOT NULL,
				subId TEXT NOT NULL,
				generation INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				updatedAt INTEGER NOT NULL,
				PRIMARY KEY (connectionId, subId)
			)`,
		);
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			// Connection role.
			case "/connect":
				return this.openStream(request);
			case "/subscribe":
				return this.subscribe(request);
			case "/unsubscribe":
				return this.unsubscribe(request);
			case "/deliver":
				return this.deliver(request);
			// Topic role.
			case "/register":
				return this.register(request);
			case "/deregister":
				return this.deregister(request);
			case "/publish":
				return this.publish(request);
			default:
				return new Response("Not found", {status: 404});
		}
	}

	// ── Connection role ──────────────────────────────────────────────────────

	/** Open the SSE stream. `ownerId` is the validated session user, passed by the route. */
	private openStream(request: Request): Response {
		const ownerId = new URL(request.url).searchParams.get("ownerId") ?? undefined;
		// A reconnect on the same connection name bumps the generation so the topic
		// DOs' rows from the prior stream are detected stale on next deliver.
		this.generation += 1;
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
		const revision = Date.now();
		await Promise.all(
			topics.map((topic) =>
				this.topicStub(topic).fetch("https://live/register", {
					method: "POST",
					body: JSON.stringify({
						connectionId,
						subId: control.subId,
						generation: this.generation,
						revision,
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
		// Stale: the row was registered by an earlier stream generation, or this
		// connection has no open stream. Report the current generation so the topic
		// DO can prune the row.
		if (generation !== this.generation || !this.controller) {
			return Response.json({delivered: false, generation: this.generation});
		}
		// Only deliver if the subscription is still active on this connection.
		if (!this.subscriptions.has(frame.id)) {
			return Response.json({delivered: false, generation: this.generation});
		}
		try {
			this.controller.enqueue(this.encoder.encode(encodeFrame(frame)));
		} catch {
			this.closeStream();
			return Response.json({delivered: false, generation: this.generation});
		}
		return Response.json({delivered: true, generation: this.generation});
	}

	// ── Topic role ───────────────────────────────────────────────────────────

	/** Upsert a subscriber row. */
	private async register(request: Request): Promise<Response> {
		const row = (await request.json()) as Omit<SubscriberRow, "updatedAt">;
		this.ctx.storage.sql.exec(
			`INSERT INTO subscribers (connectionId, subId, generation, revision, updatedAt)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(connectionId, subId) DO UPDATE SET
					generation = excluded.generation,
					revision = excluded.revision,
					updatedAt = excluded.updatedAt`,
			row.connectionId,
			row.subId,
			row.generation,
			row.revision,
			Date.now(),
		);
		// Keep one alarm running to prune rows whose connection DO has gone away
		// without deregistering (eviction, crash).
		await this.ensureAlarm();
		return Response.json({ok: true});
	}

	/** Drop a subscriber row. */
	private async deregister(request: Request): Promise<Response> {
		const {connectionId, subId} = (await request.json()) as {
			connectionId: string;
			subId: string;
		};
		this.ctx.storage.sql.exec(
			`DELETE FROM subscribers WHERE connectionId = ? AND subId = ?`,
			connectionId,
			subId,
		);
		return Response.json({ok: true});
	}

	/** Fan a frame out to every subscriber's connection DO; prune stale rows. */
	private async publish(request: Request): Promise<Response> {
		const message = (await request.json()) as PublishMessage;
		const rows = this.ctx.storage.sql
			.exec<SubscriberRow>(
				`SELECT connectionId, subId, generation, revision, updatedAt FROM subscribers`,
			)
			.toArray();
		let delivered = 0;
		await Promise.all(
			rows.map(async (row) => {
				const frame: DeliverFrame = {
					kind: message.kind === "entity" ? "next" : "connection",
					id: row.subId,
					event: message.frame,
					...(message.eventId !== undefined ? {eventId: message.eventId} : {}),
				};
				const connStub = this.env.LIVE_DO.get(this.env.LIVE_DO.idFromString(row.connectionId));
				let result: {delivered: boolean; generation: number};
				try {
					const res = await connStub.fetch("https://live/deliver", {
						method: "POST",
						body: JSON.stringify({frame, generation: row.generation}),
					});
					result = (await res.json()) as {delivered: boolean; generation: number};
				} catch {
					result = {delivered: false, generation: -1};
				}
				if (result.delivered) {
					delivered += 1;
				} else if (result.generation !== row.generation) {
					// The connection's current generation no longer matches the row's:
					// the stream this row was registered for is gone. Prune it.
					this.ctx.storage.sql.exec(
						`DELETE FROM subscribers WHERE connectionId = ? AND subId = ?`,
						row.connectionId,
						row.subId,
					);
				}
			}),
		);
		return Response.json({delivered});
	}

	private async ensureAlarm(): Promise<void> {
		const existing = await this.ctx.storage.getAlarm();
		if (existing == null) {
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
		}
	}

	/**
	 * 60s prune: drop subscriber rows whose connection DO reports a different
	 * current generation (its stream is gone). Reschedules while rows remain.
	 */
	override async alarm(): Promise<void> {
		const rows = this.ctx.storage.sql
			.exec<SubscriberRow>(
				`SELECT connectionId, subId, generation, revision, updatedAt FROM subscribers`,
			)
			.toArray();
		await Promise.all(
			rows.map(async (row) => {
				const connStub = this.env.LIVE_DO.get(this.env.LIVE_DO.idFromString(row.connectionId));
				let generation = -1;
				try {
					const res = await connStub.fetch("https://live/deliver", {
						method: "POST",
						// A probe frame the connection rejects (unknown subId / closed
						// stream) — we only read back the reported generation.
						body: JSON.stringify({
							frame: {kind: "next", id: "__probe__", event: {data: null}},
							generation: row.generation,
						}),
					});
					const result = (await res.json()) as {generation: number};
					generation = result.generation;
				} catch {
					generation = -1;
				}
				if (generation !== row.generation) {
					this.ctx.storage.sql.exec(
						`DELETE FROM subscribers WHERE connectionId = ? AND subId = ?`,
						row.connectionId,
						row.subId,
					);
				}
			}),
		);
		const remaining = this.ctx.storage.sql
			.exec<{n: number}>(`SELECT COUNT(*) AS n FROM subscribers`)
			.one().n;
		if (remaining > 0) {
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
		}
	}

	private topicStub(topicKey: string): DurableObjectStub<LiveDO> {
		return this.env.LIVE_DO.get(this.env.LIVE_DO.idFromName(`topic:${topicKey}`));
	}
}
