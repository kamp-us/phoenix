/**
 * The shared vote/save-toggle seam, lifted ABOVE {@link useToggleAction} so the
 * three vote sites (`PanoPost`, `CommentTreeNode`, `DefinitionCard`) and the pano
 * save toggle no longer hand-copy the same interaction body. `useToggleAction`
 * owns the serialize-and-supersede race (#818/#825); this owns the *semantics*
 * that used to be duplicated at every call site:
 *
 *  - the signed-out gate (a click with no session redirects to auth, never fires
 *    the mutation);
 *  - the `UNAUTHORIZED` → auth-redirect classification on the dispatch error
 *    channel (the mutations have no inline error slot, so every other code stays
 *    silent — see `.patterns/fate-mutations-client.md`);
 *  - for votes, the optimistic `score`/`myVote` delta with the `Math.max(0, …)`
 *    floor (a retract never renders a negative score).
 *
 * Any future correction to those (the #818 race class, the score floor, the
 * auth-redirect) is now a one-site edit here, not an N-site shotgun edit.
 */
import {useCallback} from "react";
import {useNavigate} from "react-router";
import {useSession} from "../../auth/client";
import {codeOf} from "../../fate/wire";
import {authRedirectPath} from "../../lib/returnTo";
import {type ToggleAction, useToggleAction} from "./useToggleAction";

/**
 * Returns the auth-redirect navigation for the current `returnTo`. `returnTo` is
 * a thunk so a site that derives it from `window.location` reads the live value
 * at click time, not at render.
 */
function useRedirectToAuth(returnTo: () => string): () => void {
	const navigate = useNavigate();
	return useCallback(() => navigate(authRedirectPath(returnTo())), [navigate, returnTo]);
}

/**
 * What a gated toggle drives: the current on-state plus the underlying fate
 * mutation pair. `dispatch` fires the `set`/`unset` mutation; this seam wraps it
 * with the `UNAUTHORIZED`→redirect catch, so call sites pass the bare mutation.
 */
export interface GatedToggleArgs {
	/** Current on-state at click time — the source of truth the loop reconciles against. */
	readonly on: boolean;
	/** The path a signed-out (or `UNAUTHORIZED`) interaction returns to after auth. */
	readonly returnTo: () => string;
	/**
	 * Fire the underlying fate mutation; may throw — `UNAUTHORIZED` is caught here.
	 * The resolved value (the mutation's `{error, result}`) is ignored: these
	 * sites have no inline error slot and lean on the boundary-class throw.
	 */
	readonly dispatch: (action: ToggleAction) => Promise<unknown>;
}

/**
 * The serialize-and-supersede toggle (via {@link useToggleAction}) wrapped with
 * the signed-out gate and the `UNAUTHORIZED`→auth-redirect classification. The
 * returned `onToggle` is the click handler: it redirects a signed-out click and
 * otherwise drives the mutation loop.
 */
export function useGatedToggle(args: GatedToggleArgs): () => void {
	const session = useSession();
	const redirectToAuth = useRedirectToAuth(args.returnTo);

	const drive = useToggleAction(() => ({
		on: args.on,
		dispatch: async (action) => {
			try {
				await args.dispatch(action);
			} catch (error) {
				if (codeOf(error) === "UNAUTHORIZED") redirectToAuth();
			}
		},
	}));

	return useCallback(() => {
		if (!session.data?.user) {
			redirectToAuth();
			return;
		}
		drive();
	}, [session.data?.user, redirectToAuth, drive]);
}

/** The fate mutation pair a vote site supplies — set upvotes, unset retracts. */
export interface VoteMutations {
	/** Cast an upvote with the supplied optimistic `{score, myVote}`. */
	readonly vote: (optimistic: {score: number; myVote: 1}) => Promise<unknown>;
	/** Retract the upvote with the supplied optimistic `{score, myVote}`. */
	readonly retractVote: (optimistic: {score: number; myVote: null}) => Promise<unknown>;
}

/**
 * Vote specialization of {@link useGatedToggle}: owns the optimistic vote delta
 * (score ±1, `myVote` 1/null) and the `Math.max(0, score - 1)` floor, so a site
 * supplies only its current `{voted, score}` and the mutation pair. Returns the
 * vote-button click handler.
 */
export function useVoteToggle(args: {
	readonly voted: boolean;
	readonly score: number;
	readonly returnTo: () => string;
	readonly mutations: VoteMutations;
}): () => void {
	const {voted, score, returnTo, mutations} = args;
	return useGatedToggle({
		on: voted,
		returnTo,
		dispatch: async (action) => {
			if (action === "unset") {
				await mutations.retractVote({score: Math.max(0, score - 1), myVote: null});
			} else {
				await mutations.vote({score: score + 1, myVote: 1});
			}
		},
	});
}

/** The current-location `returnTo` thunk for sites that return to where they are. */
export function currentLocationReturnTo(): string {
	return `${window.location.pathname}${window.location.search}`;
}
