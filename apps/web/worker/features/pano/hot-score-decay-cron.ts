/**
 * The sıcak/hot decay-refresh cron (#2027): a Cron Trigger that periodically re-decays the stored
 * `post_record.hot_score`, because the keyset-cursor contract and SQLite's missing `POW` both
 * need `hot_score` to stay a stored, indexed column rather than a read-time recompute.
 *
 * A Cron Trigger, not a DO alarm: the alarm seam is per-instance and event-driven, wrong for a
 * table-wide periodic sweep that must run with no live DO pinned in memory.
 *
 * Every 15 minutes: the gravity formula moves a young post's floored score by a meaningful step
 * only over tens of minutes. Each pass re-decays ALL live non-draft posts (windowless since
 * #2133) in ascending-id keyset chunks (#2559), so no tick materializes the whole table.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import {Pano} from "./Pano.ts";

export const HOT_SCORE_DECAY_CRON = "*/15 * * * *";

/**
 * `fateLayer` is the built worker context carrying `Pano`. The pass runs at the controller's
 * scheduled instant, not a fresh `Date.now()`. `CronEventSource` already swallows failures, so a
 * bad pass never crashes the scheduled invocation.
 */
export const subscribeHotScoreDecay = (fateLayer: Layer.Layer<Pano>) =>
	Cloudflare.cron(HOT_SCORE_DECAY_CRON, (controller) =>
		Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.refreshHotScores(new Date(controller.scheduledTime));
		}).pipe(Effect.provide(fateLayer)),
	);
