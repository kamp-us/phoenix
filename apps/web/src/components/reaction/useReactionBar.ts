/**
 * The gated dispatch seam for the reaction bar — the reaction analog of
 * `useVoteToggle`/`useGatedToggle`, but over a curated palette (6-way choice +
 * retract) rather than a boolean toggle, so it can't reuse the boolean
 * serialize-and-supersede loop. It owns the same interaction semantics the vote
 * seam owns: the signed-out gate (a tap with no session redirects to auth, never
 * fires the mutation) and the `UNAUTHORIZED` → auth-redirect classification on the
 * dispatch error channel (reusing the shared `isAuthRedirectError`). The
 * optimistic write + reconcile-on-failure is fate's (`optimistic: {reactions}`
 * applies instantly and rolls back on a rejected mutation — see
 * `.patterns/fate-mutations-client.md`); this hook only computes the payload and
 * routes the tap.
 */
import {useCallback} from "react";
import {useNavigate} from "react-router";
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import {useSession} from "../../auth/client";
import {authRedirectPath} from "../../lib/returnTo";
import {isAuthRedirectError} from "../pano/useVoteToggle";
import {nextReaction, type OptimisticReactionAggregate, reactionOptimistic} from "./reactionModel";

/**
 * Fire the underlying `*.react` fate mutation for the resolved emoji (a palette
 * member sets/changes, `null` retracts), carrying the supplied optimistic
 * aggregate. Resolves when the mutation settles; may throw the boundary-class
 * `UNAUTHORIZED` the hook catches and redirects on. The `{result, error}` value is
 * ignored — the bar has no inline error slot and leans on fate's optimistic
 * rollback + the boundary throw.
 */
export type ReactDispatch = (args: {
	readonly emoji: ReactionEmoji | null;
	readonly optimistic: OptimisticReactionAggregate;
}) => Promise<unknown>;

export interface ReactionBarArgs {
	/** The target's current reaction aggregate (from the view), or empty when the view supplies none. */
	readonly aggregate: ReactionAggregate | undefined | null;
	/** The path a signed-out (or `UNAUTHORIZED`) tap returns to after auth. */
	readonly returnTo: () => string;
	/** Fire the `*.react` mutation for the resolved emoji + optimistic aggregate. */
	readonly dispatch: ReactDispatch;
}

/**
 * Returns `onReact(tapped)`, the palette-button click handler: it redirects a
 * signed-out tap to auth, otherwise resolves the cardinality-one next reaction
 * ({@link nextReaction}) + the optimistic aggregate ({@link reactionOptimistic})
 * and fires the mutation, catching only `UNAUTHORIZED` (→ auth redirect) and
 * staying silent on every other code (no inline error slot).
 */
export function useReactionBar(args: ReactionBarArgs): (tapped: ReactionEmoji) => void {
	const {aggregate, returnTo, dispatch} = args;
	const session = useSession();
	const navigate = useNavigate();

	return useCallback(
		(tapped: ReactionEmoji) => {
			if (!session.data?.user) {
				navigate(authRedirectPath(returnTo()));
				return;
			}
			const current = aggregate?.myReaction ?? null;
			const emoji = nextReaction(current, tapped);
			const optimistic = reactionOptimistic(aggregate, tapped);
			void (async () => {
				try {
					await dispatch({emoji, optimistic});
				} catch (error) {
					if (isAuthRedirectError(error)) {
						navigate(authRedirectPath(returnTo()));
					}
					// Every other code stays silent — no inline error slot; fate rolls the
					// optimistic aggregate back on the boundary-class throw.
				}
			})();
		},
		[session.data?.user, navigate, returnTo, aggregate, dispatch],
	);
}
