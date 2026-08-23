/**
 * The two divan review reads in ONE place (#7036). Both are plain one-shot reads of
 * gated private roots — the divan deliberately has no `/fate/live` topic — so nothing
 * reconciles them after a mutation; the promote handler re-pulls them itself. The
 * mounted reads and that refresh share these builders, so the re-driven request can
 * only land on exactly the cache keys the rendered roster/backlog hold.
 */
import {type useFateClient, view} from "react-fate";
import type {DivanBacklogItem, DivanCaylak} from "../../../worker/features/fate/views";

export const BACKLOG_PAGE_SIZE = 50;
export const ROSTER_PAGE_SIZE = 50;

export const BacklogItemView = view<DivanBacklogItem>()({
	id: true,
	kind: true,
	authorId: true,
	createdAt: true,
	preview: true,
});

export const BacklogConnectionView = {items: {node: BacklogItemView}} as const;

export const RosterRowView = view<DivanCaylak>()({
	id: true,
	authorId: true,
	username: true,
	displayName: true,
	totalKarma: true,
	definitionCount: true,
	postCount: true,
	commentCount: true,
	totalCount: true,
});

export const RosterConnectionView = {items: {node: RosterRowView}} as const;

export const divanRosterRequest = () => ({
	"divan.roster": {list: RosterConnectionView, args: {first: ROSTER_PAGE_SIZE}},
});

export const divanBacklogRequest = (authorId: string) => ({
	"divan.backlog": {list: BacklogConnectionView, args: {authorId, first: BACKLOG_PAGE_SIZE}},
});

/**
 * Re-pull both review roots over ONE network-only request, so a committed promote is
 * reflected without a reload: the promoted çaylak leaves the roster and their pending
 * items leave the backlog (fate derives each root list's key from root name + args +
 * view, and a fresh fetch replaces that list state in place).
 */
export function refreshDivanReview(
	client: ReturnType<typeof useFateClient>,
	authorId: string,
): Promise<unknown> {
	return client.request(
		{...divanRosterRequest(), ...divanBacklogRequest(authorId)},
		{mode: "network-only"},
	);
}
