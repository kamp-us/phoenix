/**
 * The sözlük backstop-reconciliation cron wiring (#2558) — a Cloudflare Cron Trigger that
 * periodically re-runs the recomputable-cache refresh for every sözlük term, so a term/stat
 * left stale by a SWALLOWED last-write refresh is eventually re-converged.
 *
 * The gap it closes (#2558): the remove/restore + create ceremony swallows-and-logs a
 * cache-refresh die (`swallowRefresh`, #2012/#1639 — the substrate write already committed,
 * so a recomputable-cache die must not 500 the request). That swallow is correct and stays.
 * But the convergence contract is only "heals on the NEXT write", and no reconciliation job
 * existed — so a low-traffic term whose LAST write's refresh died stayed stale indefinitely
 * (wrong count/excerpt, stale `term_search` FTS row), on exactly the corners nobody revisits
 * and invisible to Sentry (the failure was swallowed). This backstop is ADDITIVE: the request
 * path is untouched.
 *
 * The mechanism is alchemy's idiomatic scheduled-worker seam (`Cloudflare.cron(expr, handler)`,
 * beta.59), the SAME substrate the sıcak/hot decay refresh rides (`hot-score-decay-cron.ts`) —
 * not a new bespoke scheduler. Two crons coexist cleanly: each `cron()` attaches its own
 * `Cron(<expr>)` binding, and the runtime `scheduled` listener dispatches by
 * `controller.cron === expression`, so the 15-minute decay tick runs only the decay and this
 * 6-hourly tick runs only the reconcile (`CronEventSource.ts`).
 *
 * Cadence + strategy (#2558 AC4): every 6 hours, a FULL sweep — `Sozluk.reconcileCaches`
 * re-runs `persistTermSummary` for every `term_record` row (slug-keyset chunked, bounded scan)
 * plus one `recomputeSozlukStats`. A full re-run (not sampled, not failure-flagged) is the
 * simplest correct backstop: there is no persisted "refresh failed" flag to target — adding one
 * would put a write back on the swallow path the #2012 trade deliberately keeps clean — and
 * `persistTermSummary` is a pure convergent fold, so re-running it on an already-fresh term
 * rewrites the identical row. A full sweep is therefore idempotent and self-correcting with no
 * failure bookkeeping. Six hours is far coarser than hot-decay's 15 minutes because staleness
 * here is a rare long-tail event (a refresh die on a term's LAST write), not a continuous drift,
 * and each pass rewrites every term row.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import {Sozluk} from "./Sozluk.ts";

/** Every 6 hours (standard 5-field cron). */
export const SOZLUK_RECONCILE_CRON = "0 */6 * * *";

/**
 * The worker-init effect that subscribes the reconciliation sweep to the cron trigger.
 * `fateLayer` is the built worker context (`makeFateRuntime`'s `contextLayer`) carrying
 * `Sozluk`; the handler runs `Sozluk.reconcileCaches` at the controller's scheduled instant (so
 * the pass's clock is the trigger's, not a fresh `Date.now()`). `CronEventSource` already
 * swallows handler failures (`Effect.catchCause`), so a bad pass never crashes the scheduled
 * invocation. `subscribe` only registers a listener (no async/timer work), so it is init-safe.
 */
export const subscribeSozlukReconcile = (fateLayer: Layer.Layer<Sozluk>) =>
	Cloudflare.cron(SOZLUK_RECONCILE_CRON, (controller) =>
		Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.reconcileCaches(new Date(controller.scheduledTime));
		}).pipe(Effect.provide(fateLayer)),
	);
