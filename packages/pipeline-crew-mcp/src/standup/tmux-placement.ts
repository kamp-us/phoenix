/**
 * standup/tmux-placement — tmux in its SURVIVING role: window-manager, not transport. The
 * stand-up launcher (epic #3237) coordinates the crew over the channels substrate now, but
 * something must still put each launched session on the operator's screen — that is this layer.
 * It maps the roster session set (C6, #3297: one entry per bridge + one per engine instance) to
 * tmux placement targets, deriving each pane label from the session's own role identity.
 *
 * The one non-obvious thing: the whole crew lands as PANES of ONE tiled window, not a window per
 * role (founder ruling #3424, refining #3418). So this layer derives per-pane LABELS only — never a
 * window name, never the tmux SESSION. Placement naming is DERIVED, not config-read: the old config
 * `tmux` dimension died with the one-role-map seam (ADR 0189 / #3236). A bridge's label is its role
 * slug; an engine's is its per-instance id (an operator could never name N dynamic engines). The
 * single crew window the panes open into is named at LAUNCH time (orchestrate's `CREW_WINDOW`), and
 * the SESSION that window opens under is resolved at launch to the caller's current tmux session
 * (founder ruling #3418) — so neither is a field on a target. The layer stays thin: no channel
 * registration, no identity minting (C5/C6 own those), and NO tmux-as-transport path. Pure
 * derivation (the `registry-core` idiom).
 */
import {Effect, Schema} from "effect";

/**
 * One session in the roster set (C6, #3297) that must be placed on the operator's screen. A bridge is
 * a singleton role pane labelled by its role slug; an engine is one of N instances whose per-instance
 * identity (#3297 generates it) labels its pane — both derived from identity, never config.
 */
export type RosterSession =
	| {readonly kind: "bridge"; readonly role: string}
	| {readonly kind: "engine"; readonly id: string};

/** Where one session is placed: its pane label inside the single crew window (the window + session are resolved at launch). */
export interface PlacementTarget {
	/** The resolved pane label — a bridge's role slug or an engine's instance id — identifying its pane in the crew window. */
	readonly paneLabel: string;
	/** The roster session this places — a bridge role slug or an engine instance id. */
	readonly sessionRef: string;
	readonly kind: "bridge" | "engine";
}

/**
 * Two sessions resolved to the same pane label under the crew window — a placement that would render
 * two roles indistinguishable in the tiled layout. The distinctness invariant is enforced here at its
 * result site.
 */
export class TmuxPaneCollisionError extends Schema.TaggedErrorClass<TmuxPaneCollisionError>()(
	"@kampus/pipeline-crew-mcp/standup/TmuxPaneCollisionError",
	{
		paneLabel: Schema.String,
		sessionRefs: Schema.Array(Schema.String),
	},
) {}

const placeOne = (session: RosterSession): PlacementTarget =>
	session.kind === "engine"
		? {paneLabel: session.id, sessionRef: session.id, kind: "engine"}
		: {paneLabel: session.role, sessionRef: session.role, kind: "bridge"};

/**
 * Map the roster session set to tmux placement targets: one pane per bridge (labelled by its role slug)
 * + one per engine instance (labelled by its id), all destined for the single tiled crew window. Fails
 * closed only on two sessions colliding on one pane label — the distinctness guard (the window they open
 * into is named at launch, the session it opens under is resolved at launch, neither here).
 */
export const computeTmuxPlacement = (
	sessions: readonly RosterSession[],
): Effect.Effect<readonly PlacementTarget[], TmuxPaneCollisionError> =>
	Effect.sync(() => sessions.map(placeOne)).pipe(
		Effect.flatMap((targets) => {
			const byLabel = new Map<string, string[]>();
			for (const t of targets) {
				const refs = byLabel.get(t.paneLabel) ?? [];
				refs.push(t.sessionRef);
				byLabel.set(t.paneLabel, refs);
			}
			for (const [paneLabel, sessionRefs] of byLabel) {
				if (sessionRefs.length > 1) {
					return Effect.fail(new TmuxPaneCollisionError({paneLabel, sessionRefs}));
				}
			}
			return Effect.succeed(targets);
		}),
	);
