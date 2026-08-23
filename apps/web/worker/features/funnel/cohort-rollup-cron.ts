/**
 * The weekly cohort-rollup cron (#7030, epic #6767): a Cloudflare Cron Trigger that
 * recomputes the `cohort_week_rollup` table from live queries, so per-signup-cohort
 * week-1 survival survives beyond live reads (ADR 0153's roll-up-into-D1 path).
 *
 * The pass is deliberately FULL, not sampled or failure-flagged: it is an idempotent
 * fold, so re-running it on unchanged source data writes identical rows. Silence
 * detection rides the same pass — sessions inside the trailing weekly window with
 * zero new `user_activity_day` rows means capture died silently, and that is raised
 * into the worker error pipeline so it is visible at the weekly cadence (founder
 * ruling R1.2 on #7028).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import {Funnel} from "./Funnel.ts";

/** Mondays 06:00 UTC (standard 5-field cron) — the week's activity has landed, before the workday. */
export const COHORT_ROLLUP_CRON = "0 6 * * 1";

/**
 * The pass's clock is the controller's scheduled instant, not a fresh `Date.now()`.
 * Registering a listener does no async/timer work, so this is init-safe.
 */
export const subscribeCohortRollup = (fateLayer: Layer.Layer<Funnel>) =>
	Cloudflare.cron(COHORT_ROLLUP_CRON, (controller) =>
		Effect.gen(function* () {
			const funnel = yield* Funnel;
			yield* funnel.rollupWeeklyCohorts(new Date(controller.scheduledTime));
		}).pipe(Effect.provide(fateLayer)),
	);
