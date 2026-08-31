/**
 * The divan fate views — both private, gated surfaces with NO source fetch path: each is
 * delivered inline by its `divan.*` list resolver, so its source is a capability-less
 * `Fate.syntheticSource`.
 *
 * A roster row's identity is resolved IN-BATCH by the `divan.roster` resolver, so the client
 * never fires a per-row by-id `Profile` read (ADR 0021's no-waterfalls contract). A backlog
 * item's `id` is `<kind>:<itemId>` so the three kinds never collide in one connection.
 */
import {FateDataView, type WorkerEntity} from "@kampus/fate-effect";
import type {ViewRow} from "../fate/view-types.ts";
import type {CaylakIdentityFields, DivanItemKind} from "./roster.ts";

// Only the handle + karma the roster renders; never a widening of `Profile` onto this
// mod-gated surface.
const caylakIdentityFields = {
	username: true,
	displayName: true,
	totalKarma: true,
} as const satisfies {[K in keyof CaylakIdentityFields]: true};

export type DivanCaylakViewRow = ViewRow<
	CaylakIdentityFields & {
		id: string;
		authorId: string;
		definitionCount: number;
		postCount: number;
		commentCount: number;
		totalCount: number;
		/**
		 * Viewer-scoped, like `DivanVoteReceipt.myVote`: TRUE iff the READING yazar already
		 * holds a vouch row for this çaylak. Resolved in the roster's own batch, never a
		 * per-row `VouchLedger.has` (ADR 0021's no-waterfalls contract).
		 */
		viewerVouched: boolean;
	}
>;

export class DivanCaylakView extends FateDataView<DivanCaylakViewRow>()("DivanCaylak")({
	id: true,
	authorId: true,
	...caylakIdentityFields,
	definitionCount: true,
	postCount: true,
	commentCount: true,
	totalCount: true,
	viewerVouched: true,
} as const satisfies {[K in keyof DivanCaylakViewRow]: true}) {}

export const divanCaylakDataView = DivanCaylakView.view;

export type DivanCaylak = WorkerEntity<typeof DivanCaylakView>;

export type DivanBacklogItemViewRow = ViewRow<{
	id: string;
	kind: DivanItemKind;
	authorId: string;
	createdAt: string;
	preview: string;
}>;

export class DivanBacklogItemView extends FateDataView<DivanBacklogItemViewRow>()(
	"DivanBacklogItem",
)({
	id: true,
	kind: true,
	authorId: true,
	createdAt: true,
	preview: true,
} as const satisfies {[K in keyof DivanBacklogItemViewRow]: true}) {}

export const divanBacklogItemDataView = DivanBacklogItemView.view;

export type DivanBacklogItem = WorkerEntity<typeof DivanBacklogItemView>;

/**
 * The topbar badge's synthetic singleton (#6760): one row carrying how many
 * sandbox-backlog items await divan review. Delivered inline by the
 * `divan.pendingCount` query (no by-id read), so like the other two private views its
 * source is capability-less.
 */
export type DivanPendingViewRow = ViewRow<{
	id: string;
	count: number;
}>;

export class DivanPendingView extends FateDataView<DivanPendingViewRow>()("DivanPending")({
	id: true,
	count: true,
} as const satisfies {[K in keyof DivanPendingViewRow]: true}) {}

export const divanPendingDataView = DivanPendingView.view;

export type DivanPending = WorkerEntity<typeof DivanPendingView>;

/**
 * The receipt a `divan.vote` returns, delivered inline by the mutation (no by-id read), so
 * its source is a capability-less `Fate.syntheticSource` like the other two. `id` is the
 * `<kind>:<itemId>` composite — the same identity as {@link DivanBacklogItemView}.
 */
export type DivanVoteReceiptViewRow = ViewRow<{
	id: string;
	score: number;
	myVote: boolean;
}>;

export class DivanVoteReceiptView extends FateDataView<DivanVoteReceiptViewRow>()(
	"DivanVoteReceipt",
)({
	id: true,
	score: true,
	myVote: true,
} as const satisfies {[K in keyof DivanVoteReceiptViewRow]: true}) {}

export const divanVoteReceiptDataView = DivanVoteReceiptView.view;

export type DivanVoteReceipt = WorkerEntity<typeof DivanVoteReceiptView>;
