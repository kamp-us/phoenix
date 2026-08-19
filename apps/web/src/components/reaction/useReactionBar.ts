// A palette (6-way choice + retract) rather than a boolean toggle, so this cannot reuse
// `useVoteToggle`'s serialize-and-supersede loop. The optimistic write and its rollback
// are fate's — see `.patterns/fate-mutations-client.md`.
import {useCallback} from "react";
import {useNavigate} from "react-router";
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import {useSession} from "../../auth/client";
import {authRedirectPath} from "../../lib/returnTo";
import {isAuthRedirectError} from "../pano/useVoteToggle";
import {nextReaction, type OptimisticReactionAggregate, reactionOptimistic} from "./reactionModel";

// `null` emoji retracts. May throw the boundary-class `UNAUTHORIZED` the hook catches.
export type ReactDispatch = (args: {
	readonly emoji: ReactionEmoji | null;
	readonly optimistic: OptimisticReactionAggregate;
}) => Promise<unknown>;

export interface ReactionBarArgs {
	readonly aggregate: ReactionAggregate | undefined | null;
	/** The path a signed-out (or `UNAUTHORIZED`) tap returns to after auth. */
	readonly returnTo: () => string;
	readonly dispatch: ReactDispatch;
}

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
