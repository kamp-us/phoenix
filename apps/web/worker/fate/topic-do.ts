/**
 * `TopicDO` — the topic-role half of phoenix's live fan-out (ADR 0023, split out
 * of the former one-class `LiveDO` per ADR 0025).
 *
 * One instance per topic, named `topic:<topicKey>`. It owns the **durable
 * subscriber registry** for that topic, the **publish fan-out**, and the **alarm
 * reap** — nothing about any client's SSE stream. Rows live in DO SQL storage
 * (survive eviction). Each row carries the connection's `generation` at register
 * time; a row is pruned only when a *reachable* connection DO reports a different
 * current generation (its stream lifetime is over) — never on a single
 * transport/deserialize failure. A 60s `alarm()` probes for orphans the same
 * way, and additionally reaps a row whose connection stays unreachable across the
 * prune cycle (a persisted consecutive-miss count, evicted after a few misses,
 * reset on any reachable probe) so a dead connection that never deregistered
 * doesn't bloat the topic. Every cross-DO `deliver`/`probe` fetch is time-bounded
 * so one unreachable connection can't stall the single-threaded DO for minutes.
 *
 * The DO does **no** database work and has **no** Effect runtime: publishes carry
 * the inline-resolved `data`/`node` the mutation already produced, and this DO
 * relays the frame to each subscriber's {@link ConnectionDO} verbatim.
 *
 * Cross-role direction is enforced by the binding: the fan-out resolves
 * connection stubs only through `CONNECTION_DO`, which is typed to
 * {@link ConnectionDO}. There is no binding through which this class can reach a
 * topic instance — a topic→topic call is unrepresentable.
 *
 * Imports `cloudflare:workers`, so only the worker entry (`index.ts`, for the
 * `TOPIC_DO` binding) pulls this in — not the fate codegen graph. The publish
 * side (`liveBus`) lives in `live.ts`; the wire shapes are shared via
 * `live-protocol.ts`.
 */
import {DurableObject} from "cloudflare:workers";
import type {ConnectionDO} from "./connection-do";
import type {DeliverFrame, PublishMessage} from "./live-protocol";

/**
 * A subscriber row: which connection (and which operation on it) wants events for
 * this topic. `generation` captures the connection's stream lifetime at register
 * time; on deliver/probe the connection DO reports its current generation and a
 * row that a *reachable* connection reports as mismatched is pruned. An
 * unreachable connection (transport/parse error) leaves the row — but `misses`
 * counts *consecutive* unreachable `alarm()` probes so a connection that stays
 * dead is eventually reaped (any reachable probe resets it to 0).
 */
interface SubscriberRow {
	connectionId: string;
	subId: string;
	generation: number;
	updatedAt: number;
	misses: number;
	// `sql.exec<T>` requires `T extends Record<string, SqlStorageValue>`; the
	// index signature satisfies that constraint over the named columns above.
	[column: string]: string | number;
}

/**
 * Per-cross-DO-fetch budget for the publish/alarm fan-out. A `deliver`/`probe`
 * fetch to an unreachable connection DO must abort here rather than hang on the
 * runtime's multi-minute subrequest timeout — a stalled best-effort live deliver
 * would block every later publish behind it (a DO is single-threaded). A
 * timed-out fetch lands in the existing `catch` (treated as "couldn't reach").
 */
const FANOUT_TIMEOUT_MS = 2_000;

/**
 * Consecutive unreachable `alarm()` probes before a subscriber row is reaped. The
 * alarm fires every 60s, so a connection must stay unreachable across the whole
 * cycle before its dead row is evicted; a single transient failure only accrues
 * one miss (well under the threshold) and never deletes a live subscription.
 */
const MAX_PROBE_MISSES = 3;

export class TopicDO extends DurableObject<Env> {
	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		state.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS subscribers (
				connectionId TEXT NOT NULL,
				subId TEXT NOT NULL,
				generation INTEGER NOT NULL,
				updatedAt INTEGER NOT NULL,
				misses INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (connectionId, subId)
			)`,
		);
		// `CREATE TABLE IF NOT EXISTS` is a no-op against a `subscribers` table
		// created before the `misses` column existed (any DO whose storage predates
		// the fan-out reap), so its INSERT/SELECT of `misses` would throw
		// SQLITE_ERROR. Add the column in place when an older table lacks it —
		// idempotent, runs once per DO instantiation, preserves existing rows.
		const hasMisses = state.storage.sql
			.exec<{name: string}>(`PRAGMA table_info(subscribers)`)
			.toArray()
			.some((column) => column.name === "misses");
		if (!hasMisses) {
			state.storage.sql.exec(
				`ALTER TABLE subscribers ADD COLUMN misses INTEGER NOT NULL DEFAULT 0`,
			);
		}
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
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

	/** Upsert a subscriber row. */
	private async register(request: Request): Promise<Response> {
		const row = (await request.json()) as Omit<SubscriberRow, "updatedAt" | "misses">;
		// A fresh register means the connection is alive, so `misses` starts (and on
		// re-register resets) at 0 — a re-subscribe clears any accrued miss count.
		this.ctx.storage.sql.exec(
			`INSERT INTO subscribers (connectionId, subId, generation, updatedAt, misses)
				VALUES (?, ?, ?, ?, 0)
				ON CONFLICT(connectionId, subId) DO UPDATE SET
					generation = excluded.generation,
					updatedAt = excluded.updatedAt,
					misses = 0`,
			row.connectionId,
			row.subId,
			row.generation,
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
		this.deleteRow(connectionId, subId);
		return Response.json({ok: true});
	}

	/** Fan a frame out to every subscriber's connection DO; prune stale rows. */
	private async publish(request: Request): Promise<Response> {
		const message = (await request.json()) as PublishMessage;
		const rows = this.loadSubscriberRows();
		let delivered = 0;
		await Promise.all(
			rows.map(async (row) => {
				const frame: DeliverFrame = {
					kind: message.kind === "entity" ? "next" : "connection",
					id: row.subId,
					event: message.frame,
					...(message.eventId !== undefined ? {eventId: message.eventId} : {}),
				};
				const connStub = this.connStub(row.connectionId);
				// `undefined` = couldn't reach/parse the connection (leave the row);
				// a number = the connection's reported current generation.
				let reported: number | undefined;
				let didDeliver = false;
				try {
					const res = await connStub.fetch("https://live/deliver", {
						method: "POST",
						body: JSON.stringify({frame, generation: row.generation}),
						// Bound the fan-out: an unreachable connection aborts here instead
						// of stalling the (single-threaded) topic DO on the runtime's
						// multi-minute subrequest timeout. A timeout lands in the catch.
						signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS),
					});
					const result = (await res.json()) as {delivered: boolean; generation: number};
					didDeliver = result.delivered;
					reported = result.generation;
				} catch {
					// Transport/deserialize failure — the connection is unreachable, not
					// confirmed stale. Leave the row; the 60s alarm retries.
					reported = undefined;
				}
				if (didDeliver) {
					delivered += 1;
				} else if (reported !== undefined && reported !== row.generation) {
					// A *reachable* connection reported a different current generation:
					// the stream this row was registered for is gone. Prune it.
					this.deleteRow(row.connectionId, row.subId);
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
	 * 60s prune. Three outcomes per row:
	 *   - **reachable, generation mismatch** → the stream this row was registered
	 *     for is gone; prune immediately (same as `publish`).
	 *   - **reachable, generation matches** → live; reset the miss count to 0.
	 *   - **unreachable** (transport/parse error or {@link FANOUT_TIMEOUT_MS}
	 *     timeout) → a single failure never deletes a live subscription (Task 4's
	 *     invariant), so increment the consecutive-miss count and only reap once it
	 *     reaches {@link MAX_PROBE_MISSES}. A genuinely-dead connection that never
	 *     deregistered (eviction, crash) is thus eventually evicted instead of
	 *     bloating the topic and slowing every publish behind it.
	 * Reschedules while rows remain.
	 */
	override async alarm(): Promise<void> {
		const rows = this.loadSubscriberRows();
		await Promise.all(
			rows.map(async (row) => {
				const connStub = this.connStub(row.connectionId);
				// `undefined` = couldn't reach/parse the connection.
				let reported: number | undefined;
				try {
					// `/probe` reports the connection's current generation without
					// enqueueing anything onto its stream. Bounded so a dead connection
					// aborts fast instead of stalling the prune.
					const res = await connStub.fetch("https://live/probe", {
						method: "POST",
						signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS),
					});
					const result = (await res.json()) as {generation: number};
					reported = result.generation;
				} catch {
					reported = undefined;
				}
				if (reported === undefined) {
					// Unreachable: accrue a miss; reap only after enough consecutive ones.
					const misses = row.misses + 1;
					if (misses >= MAX_PROBE_MISSES) {
						this.deleteRow(row.connectionId, row.subId);
					} else {
						this.ctx.storage.sql.exec(
							`UPDATE subscribers SET misses = ? WHERE connectionId = ? AND subId = ?`,
							misses,
							row.connectionId,
							row.subId,
						);
					}
				} else if (reported !== row.generation) {
					this.deleteRow(row.connectionId, row.subId);
				} else if (row.misses !== 0) {
					// Reachable and current: clear any accrued misses so a transient blip
					// never accumulates toward eviction across reachable intervals.
					this.ctx.storage.sql.exec(
						`UPDATE subscribers SET misses = 0 WHERE connectionId = ? AND subId = ?`,
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

	/** Load every subscriber row (all columns both `publish` and `alarm` read). */
	private loadSubscriberRows(): SubscriberRow[] {
		return this.ctx.storage.sql
			.exec<SubscriberRow>(
				`SELECT connectionId, subId, generation, updatedAt, misses FROM subscribers`,
			)
			.toArray();
	}

	/** Delete one subscriber row by its primary key. */
	private deleteRow(connectionId: string, subId: string): void {
		this.ctx.storage.sql.exec(
			`DELETE FROM subscribers WHERE connectionId = ? AND subId = ?`,
			connectionId,
			subId,
		);
	}

	/**
	 * The connection-role DO stub for a subscriber row's connection. Resolved
	 * through `CONNECTION_DO` (typed to {@link ConnectionDO}), so the fan-out can
	 * only ever reach a connection instance — a topic→topic call has no binding.
	 */
	private connStub(connectionId: string): DurableObjectStub<ConnectionDO> {
		return this.env.CONNECTION_DO.get(this.env.CONNECTION_DO.idFromString(connectionId));
	}
}
