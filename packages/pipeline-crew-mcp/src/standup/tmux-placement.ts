/**
 * standup/tmux-placement — tmux in its SURVIVING role: window-manager, not transport. The
 * stand-up launcher (epic #3237) coordinates the crew over the channels substrate now, but
 * something must still put each launched session on the operator's screen — that is this layer.
 * It maps the roster session set (C6, #3297: one entry per bridge + one per engine instance) to
 * tmux placement targets, deriving each window name from the session's own role identity.
 *
 * The one non-obvious thing: this layer derives window NAMES only — it does NOT own the tmux SESSION.
 * Placement naming is DERIVED, not config-read: the old config `tmux` dimension (session + per-bridge
 * window names) died with the one-role-map seam (ADR 0189 / #3236) — post-MCP a role's address is a
 * lease, not a configured pane. A bridge's window is its role slug; an engine's window is its per-instance
 * id (an operator could never name N dynamic engines). The SESSION the windows open into is resolved at
 * LAUNCH time to the caller's current tmux session, not named here (founder ruling #3418: stand-up opens
 * windows in the operator's own session, never a hardcoded one) — so there is no session field on a target.
 * The layer stays thin: it does NOT register channels or mint identity (C5/C6 own those), and introduces NO
 * tmux-as-transport path (no pane-title discovery, no buffer-paste, no send-keys). Pure derivation (the
 * `registry-core` idiom).
 */
import {Effect, Schema} from "effect";

/**
 * One session in the roster set (C6, #3297) that must be placed on the operator's screen. A bridge is
 * a singleton role window named by its role slug; an engine is one of N instances whose per-instance
 * identity (#3297 generates it) names its window — both derived from identity, never config.
 */
export type RosterSession =
	| {readonly kind: "bridge"; readonly role: string}
	| {readonly kind: "engine"; readonly id: string};

/** Where one session is placed: a named window (the session it opens into is resolved at launch time). */
export interface PlacementTarget {
	/** The resolved tmux window name — a bridge's role slug or an engine's instance id. */
	readonly window: string;
	/** The roster session this places — a bridge role slug or an engine instance id. */
	readonly sessionRef: string;
	readonly kind: "bridge" | "engine";
}

/**
 * Two sessions resolved to the same window under the tmux session — a placement that would stack
 * them invisibly on one window. The distinctness invariant is enforced here at its result site.
 */
export class TmuxWindowCollisionError extends Schema.TaggedErrorClass<TmuxWindowCollisionError>()(
	"@kampus/pipeline-crew-mcp/standup/TmuxWindowCollisionError",
	{
		window: Schema.String,
		sessionRefs: Schema.Array(Schema.String),
	},
) {}

const placeOne = (session: RosterSession): PlacementTarget =>
	session.kind === "engine"
		? {window: session.id, sessionRef: session.id, kind: "engine"}
		: {window: session.role, sessionRef: session.role, kind: "bridge"};

/**
 * Map the roster session set to tmux placement targets: one window per bridge (named by its role slug)
 * + one per engine instance (named by its id). Fails closed only on two sessions colliding on one window
 * name — the launch-time distinctness guard (the session they open into is resolved at launch, not here).
 */
export const computeTmuxPlacement = (
	sessions: readonly RosterSession[],
): Effect.Effect<readonly PlacementTarget[], TmuxWindowCollisionError> =>
	Effect.sync(() => sessions.map(placeOne)).pipe(
		Effect.flatMap((targets) => {
			const byWindow = new Map<string, string[]>();
			for (const t of targets) {
				const refs = byWindow.get(t.window) ?? [];
				refs.push(t.sessionRef);
				byWindow.set(t.window, refs);
			}
			for (const [window, sessionRefs] of byWindow) {
				if (sessionRefs.length > 1) {
					return Effect.fail(new TmuxWindowCollisionError({window, sessionRefs}));
				}
			}
			return Effect.succeed(targets);
		}),
	);
