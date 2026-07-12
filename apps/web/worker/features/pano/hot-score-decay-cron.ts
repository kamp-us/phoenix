/**
 * The sıcak/hot decay-refresh cron wiring (#2027) — a Cloudflare Cron Trigger that
 * periodically re-decays the stored `post_record.hot_score` so the hot feed keeps
 * decaying with age WITHOUT a read-time recompute (the keyset-cursor contract + the
 * no-`POW` SQLite constraint both need `hot_score` to stay a stored, indexed column).
 *
 * The mechanism is alchemy's idiomatic scheduled-worker seam
 * (`Cloudflare.cron(expr, handler)`, `alchemy/Cloudflare/Workers/CronEventSource`, beta.59):
 * it registers a runtime `scheduled` listener AND attaches the cron expression to the
 * deployed worker at deploy time. The DO-alarm alternative (the fate-live prune alarm)
 * is per-instance and event-driven — wrong for a table-wide periodic sweep that must run
 * with no live DO pinned in memory — so a Cron Trigger is the established fit here.
 *
 * Cadence: every 15 minutes (`HOT_SCORE_DECAY_CRON`). The decay is gradual — the gravity
 * formula moves a young post's floored score by a meaningful step only over tens of
 * minutes — so a 15-minute pass keeps the visible feed fresh without over-writing the
 * `hot_score` column. Each pass re-decays ALL live non-draft posts (windowless since
 * #2133), so an aged squatter keeps decaying at any age; the sweep reads in ascending-id
 * keyset chunks (#2559) so no single tick materializes the whole table at once — see
 * `Pano.refreshHotScores`.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import {Pano} from "./Pano.ts";

/** Every 15 minutes (standard 5-field cron). */
export const HOT_SCORE_DECAY_CRON = "*/15 * * * *";

/**
 * The worker-init effect that subscribes the decay refresh to the cron trigger. `fateLayer`
 * is the built worker context (`makeFateRuntime`'s `contextLayer`) carrying `Pano`; the
 * handler runs `Pano.refreshHotScores` provided by it, at the controller's scheduled instant
 * (so the pass's clock is the trigger's, not a fresh `Date.now()`). Failures are already
 * swallowed by `CronEventSource` (`Effect.catchCause`), so a bad pass never crashes the
 * scheduled invocation.
 */
export const subscribeHotScoreDecay = (fateLayer: Layer.Layer<Pano>) =>
	Cloudflare.cron(HOT_SCORE_DECAY_CRON, (controller) =>
		Effect.gen(function* () {
			const pano = yield* Pano;
			yield* pano.refreshHotScores(new Date(controller.scheduledTime));
		}).pipe(Effect.provide(fateLayer)),
	);
