/**
 * crew/heartbeat — the presence keepalive sender: a background fiber that re-sends `Heartbeat`
 * on an interval safely under `DEFAULT_TTL_SECONDS`, so a live session's presence + role lease
 * never ages out. Without it the substrate only functions for the first ~30s window (#3218).
 *
 * The beat only ever REFRESHES an existing lease — it cannot manufacture presence (a beat for a peer
 * with no lease is a registry-core no-op). Presence is created solely by the inbox-gated announce
 * (`crew/session.ts`, #3628), so a channel-deaf session — one whose inbox never attached, so it never
 * announced — holds no live presence no matter how its keepalive beats.
 *
 * Presence-only by construction: each tick sends exactly one `Heartbeat {peer, ttlSeconds}` and
 * nothing else — it never refreshes or iterates a resource claim. A finished claim is freed by
 * `Release`; a crashed holder's claims are reaped when its presence ages out. Keeping the sender
 * presence-only is what stops a live session's beats from holding a stale claim alive (#3228).
 * The tracker-side keyspace split that makes the registry's own refresh presence-only is #3281,
 * layered on after this.
 */
import {Duration, Effect, Layer, Schedule} from "effect";
import {DEFAULT_TTL_SECONDS} from "../tracker/index.ts";
import {CrewTracker} from "./tracker.ts";

/** The TTL window each heartbeat requests — the tracker's default, so a beat renews the full lease. */
export const HEARTBEAT_TTL_SECONDS = DEFAULT_TTL_SECONDS;

/**
 * The send interval, a third of the TTL: a live session refreshes ~3× per window, so even a dropped
 * beat still lands the next refresh under the TTL before the lease ages out. The interval-under-TTL
 * relationship is the load-bearing invariant (`heartbeat.test.ts`).
 */
export const HEARTBEAT_INTERVAL_SECONDS = DEFAULT_TTL_SECONDS / 3;

const heartbeatInterval = Duration.seconds(HEARTBEAT_INTERVAL_SECONDS);

/**
 * The keepalive loop as a background-task layer (the `Layer.effectDiscard` + `forkScoped` idiom):
 * on build it forks a scoped fiber that sends a `Heartbeat` for `peer` immediately and then every
 * `HEARTBEAT_INTERVAL_SECONDS`, refreshing this session's presence + role lease. The fiber is
 * interrupted when the session scope closes, leaving the lease to TTL-age. Share this layer's
 * `CrewTracker` with the rest of the session (by memoization) so the beats reach the same registry
 * the presence was announced on.
 */
export const crewHeartbeatLayer = (peer: string): Layer.Layer<never, never, CrewTracker> =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const tracker = yield* CrewTracker;
			yield* tracker
				.heartbeat({peer, ttlSeconds: HEARTBEAT_TTL_SECONDS})
				.pipe(Effect.repeat(Schedule.spaced(heartbeatInterval)), Effect.forkScoped);
		}),
	);
