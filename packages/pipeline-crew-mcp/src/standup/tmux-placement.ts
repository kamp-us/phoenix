/**
 * standup/tmux-placement — tmux in its SURVIVING role: window-manager, not transport. The
 * stand-up launcher (epic #3237) coordinates the crew over the channels substrate now, but
 * something must still put each launched session on the operator's screen — that is this layer.
 * It maps the roster session set (C6, #3297: one entry per bridge + one per engine instance) to
 * tmux placement targets under the operator-configured tmux session, resolving each window name
 * from the operator's tmux naming.
 *
 * The layer is deliberately thin: it maps sessions to placement targets and nothing else. It does
 * NOT register channels or mint identity (C5/C6 own those), it does NOT read the config file (the
 * `tmux` dimension reader/validator is #3293; here we consume the already-resolved `TmuxNaming`),
 * and it introduces NO tmux-as-transport path — no pane-title discovery, no buffer-paste, no
 * send-keys. Pure derivation over plain data (the `registry-core` idiom); the launcher (#3299)
 * issues the actual window/pane creation from the targets this returns.
 */
import {Effect, Schema} from "effect";

/**
 * The operator-configured tmux naming this layer consumes — the `tmux` dimension of the crew
 * config personalization seam (ADR 0062: operator data lives in the operator's config, never the
 * distributable plugin). Loaded and validated by #3293's reader; here we take the resolved shape.
 */
export interface TmuxNaming {
	/** The tmux session every crew window is created under — operator-configured, never hardcoded. */
	readonly session: string;
	/** Operator-configured window names, keyed by a bridge's window key. */
	readonly windows: Readonly<Record<string, string>>;
}

/**
 * One session in the roster set (C6, #3297) that must be placed on the operator's screen. A bridge
 * is a singleton role window whose name the operator configures; an engine is one of N instances
 * whose per-instance identity (#3297 generates it) already names its window — the operator cannot
 * name N dynamic engines, so the generated id is the (non-operator, non-hardcoded) window name.
 */
export type RosterSession =
	| {readonly kind: "bridge"; readonly role: string; readonly windowKey: string}
	| {readonly kind: "engine"; readonly id: string};

/** Where one session is placed: a named window under the operator-configured tmux session. */
export interface PlacementTarget {
	/** The tmux session this window is created under (from `TmuxNaming.session`). */
	readonly session: string;
	/** The resolved tmux window name. */
	readonly window: string;
	/** The roster session this places — a bridge role slug or an engine instance id. */
	readonly sessionRef: string;
	readonly kind: "bridge" | "engine";
}

/**
 * A bridge names a window key the operator's tmux config does not define — fail loud rather than
 * invent a name, because the window name MUST come from operator config (no hardcoded operator
 * data). A REJECTION, not a value (the `crew/errors` idiom).
 */
export class TmuxWindowUnnamedError extends Schema.TaggedErrorClass<TmuxWindowUnnamedError>()(
	"@kampus/pipeline-crew-mcp/standup/TmuxWindowUnnamedError",
	{
		role: Schema.String,
		windowKey: Schema.String,
	},
) {}

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

const placeOne = (
	naming: TmuxNaming,
	session: RosterSession,
): Effect.Effect<PlacementTarget, TmuxWindowUnnamedError> => {
	if (session.kind === "engine") {
		return Effect.succeed({
			session: naming.session,
			window: session.id,
			sessionRef: session.id,
			kind: "engine",
		});
	}
	const window = naming.windows[session.windowKey];
	if (window === undefined) {
		return Effect.fail(
			new TmuxWindowUnnamedError({role: session.role, windowKey: session.windowKey}),
		);
	}
	return Effect.succeed({
		session: naming.session,
		window,
		sessionRef: session.role,
		kind: "bridge",
	});
};

/**
 * Map the roster session set to tmux placement targets: one window per bridge + one per engine
 * instance, all under the operator-configured tmux session. Fails closed on a bridge whose window
 * key the operator config omits, or on two sessions colliding on one window.
 */
export const computeTmuxPlacement = (
	naming: TmuxNaming,
	sessions: readonly RosterSession[],
): Effect.Effect<readonly PlacementTarget[], TmuxWindowUnnamedError | TmuxWindowCollisionError> =>
	Effect.forEach(sessions, (session) => placeOne(naming, session)).pipe(
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
