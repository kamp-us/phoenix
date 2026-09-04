/**
 * The shared vote/save-toggle seam for every vote site. Error codes other than
 * `UNAUTHORIZED` / `VOTE_REQUIRES_YAZAR` stay silent: these sites have no inline
 * error slot — see `.patterns/fate-mutations-client.md`.
 */

import {useToast} from "@kampus/design";
import {useCallback} from "react";
import {useNavigate} from "react-router";
import {useSession} from "../../auth/client";
import {codeOf} from "../../fate/wire";
import {messageForCode} from "../../fate/wireMessages";
import {type Translate, useT} from "../../i18n/LocaleProvider";
import {authRedirectPath} from "../../lib/returnTo";
import {type ToggleAction, useToggleAction} from "./useToggleAction";

/**
 * `returnTo` is a thunk so a site deriving it from `window.location` reads the
 * live value at click time, not at render.
 */
function useRedirectToAuth(returnTo: () => string): () => void {
	const navigate = useNavigate();
	return useCallback(() => navigate(authRedirectPath(returnTo())), [navigate, returnTo]);
}

export interface GatedToggleArgs {
	readonly on: boolean;
	readonly returnTo: () => string;
	/** The resolved value is ignored — only the thrown code is classified. */
	readonly dispatch: (action: ToggleAction) => Promise<unknown>;
}

export function isAuthRedirectError(error: unknown): boolean {
	return codeOf(error) === "UNAUTHORIZED";
}

export function voteGateMessage(t: Translate, error: unknown): string | null {
	return codeOf(error) === "VOTE_REQUIRES_YAZAR" ? messageForCode(t, "VOTE_REQUIRES_YAZAR") : null;
}

export function useGatedToggle(args: GatedToggleArgs): () => void {
	const session = useSession();
	const redirectToAuth = useRedirectToAuth(args.returnTo);
	const {show} = useToast();
	const t = useT();

	const drive = useToggleAction(() => ({
		on: args.on,
		dispatch: async (action) => {
			try {
				await args.dispatch(action);
			} catch (error) {
				if (isAuthRedirectError(error)) {
					redirectToAuth();
					return;
				}
				// Same toast id per gate so N failed taps replace rather than stack (#1879).
				const message = voteGateMessage(t, error);
				if (message) show({id: "vote-gate", message, testId: "vote-gate"});
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

export interface VoteMutations {
	readonly vote: (optimistic: {score: number; myVote: true}) => Promise<unknown>;
	readonly retractVote: (optimistic: {score: number; myVote: false}) => Promise<unknown>;
}

export type VoteOptimistic =
	| {readonly score: number; readonly myVote: true}
	| {readonly score: number; readonly myVote: false};

/** The `Math.max(0, …)` floor is deliberate: a retract never renders a negative score. */
export function voteOptimistic(action: ToggleAction, score: number): VoteOptimistic {
	return action === "unset"
		? {score: Math.max(0, score - 1), myVote: false}
		: {score: score + 1, myVote: true};
}

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
			const optimistic = voteOptimistic(action, score);
			if (optimistic.myVote) {
				await mutations.vote(optimistic);
			} else {
				await mutations.retractVote(optimistic);
			}
		},
	});
}

export function currentLocationReturnTo(): string {
	return `${window.location.pathname}${window.location.search}`;
}
