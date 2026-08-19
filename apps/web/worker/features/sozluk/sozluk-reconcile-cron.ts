/**
 * The sözlük backstop-reconciliation cron wiring (#2558) — a Cloudflare Cron Trigger that
 * periodically re-runs the recomputable-cache refresh for every sözlük term, so a term/stat
 * left stale by a SWALLOWED last-write refresh is eventually re-converged.
 *
 * The gap it closes: `swallowRefresh` (#2012) makes the convergence contract "heals on the
 * NEXT write", so a low-traffic term whose LAST write's refresh died stayed stale forever —
 * and invisibly, since the failure was swallowed.
 *
 * The sweep is deliberately FULL, not sampled or failure-flagged: there is no persisted
 * "refresh failed" flag to target, and adding one would put a write back on the swallow
 * path #2012 keeps clean. `persistTermSummary` is a convergent fold, so re-running it on a
 * fresh term rewrites the identical row — idempotent, with no failure bookkeeping.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import {Sozluk} from "./Sozluk.ts";

/** Every 6 hours (standard 5-field cron). */
export const SOZLUK_RECONCILE_CRON = "0 */6 * * *";

/**
 * The pass's clock is the controller's scheduled instant, not a fresh `Date.now()`.
 * Registering a listener does no async/timer work, so this is init-safe.
 */
export const subscribeSozlukReconcile = (fateLayer: Layer.Layer<Sozluk>) =>
	Cloudflare.cron(SOZLUK_RECONCILE_CRON, (controller) =>
		Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.reconcileCaches(new Date(controller.scheduledTime));
		}).pipe(Effect.provide(fateLayer)),
	);
