/**
 * `BildirimList` — the notification center's list (#1694): the `bildirim.list`
 * connection paginated via `useListView`, with per-row mark-read and a
 * mark-all-read header action. Read state folds the server `readAt` stamp with
 * this session's mark actions (`rowUnread`) — the receipt doesn't rewrite listed
 * rows, so the fold is what makes a marked row stop reading as unread without a
 * reload. A dead target (`targetUrl: null`) renders the tombstone row
 * (`bildirimTarget`), never a broken link.
 */
import {useEffect, useRef, useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Notification, NotificationMarkReceipt} from "../../../worker/features/fate/views";
import {useSession} from "../../auth/client";
import {LoadMoreButton} from "../../fate/wire";
import {bildirimCopy, bildirimTarget, rowUnread, targetLinkLabel} from "./bildirim";
import {useBildirimUnread} from "./useBildirimUnread";

const PAGE_SIZE = 20;

const BildirimRowView = view<Notification>()({
	id: true,
	kind: true,
	targetKind: true,
	targetId: true,
	targetUrl: true,
	count: true,
	readAt: true,
	createdAt: true,
});

const MarkReceiptView = view<NotificationMarkReceipt>()({
	id: true,
	marked: true,
	unreadCount: true,
});

const BildirimConnectionView = {
	items: {node: BildirimRowView},
} as const;

const bildirimRequest = {
	"bildirim.list": {list: BildirimConnectionView, args: {first: PAGE_SIZE}},
} as const;

export function BildirimList() {
	const result = useRequest(bildirimRequest);
	const [items, loadNext] = useListView(BildirimConnectionView, result["bildirim.list"]);
	const fate = useFateClient();
	const userId = useSession().data?.user?.id ?? null;

	// Live-reconcile the center over `/fate/live` (#1700): when a recorded notification
	// bumps the viewer's live unread count, refetch the list once (network-only) so the
	// new row surfaces without a nav or refresh. `bildirim.list` has no per-node live
	// topic; the per-recipient count is the coarse signal that a re-read is due.
	//
	// The count comes from `useBildirimUnread` — the same seed-gated, NON-suspending live
	// read the shell badge uses — NOT a `useLiveView(channelRef)`. `NotificationChannel` is
	// a loader-less `Fate.syntheticSource`, so the suspending read's `readView` fires a
	// `byId` on any cache miss, which 500s through fate's capability-less arm as an
	// `INTERNAL_ERROR` (#2206). That surfaced as the popover's generic "yüklenemedi": the
	// popover mounts this list from the shell where the co-bundled hydration isn't a hard
	// guarantee, so the suspending read hit the `byId`. `useBildirimUnread` never issues a
	// `byId` (it reads only once its own query seed has hydrated the cache), so the live
	// count is byId-safe in every mount context (#2982).
	const liveUnread = useBildirimUnread(userId != null, userId);
	const lastUnread = useRef<number | null>(null);
	useEffect(() => {
		if (userId == null) return;
		if (lastUnread.current != null && liveUnread > lastUnread.current) {
			void fate.request(bildirimRequest, {mode: "network-only"}).catch(() => {});
		}
		lastUnread.current = liveUnread;
	}, [liveUnread, userId, fate]);

	// This session's mark state — the receipt confirms the write but doesn't
	// rewrite the listed rows, so rows fold these into their unread reading.
	const [markedIds, setMarkedIds] = useState<ReadonlySet<string>>(new Set());
	const [allMarked, setAllMarked] = useState(false);
	const [markAllBusy, setMarkAllBusy] = useState(false);

	async function onMarkRead(id: string) {
		// Optimistic flip; a rejected write is invisible here by design — the row
		// re-reads unread on the next load, and the gate already denied a
		// signed-out/dark caller server-side.
		setMarkedIds((prev) => new Set(prev).add(id));
		try {
			await fate.mutations.bildirim.markRead({input: {id}, view: MarkReceiptView});
		} catch {
			// Keep the local flip; the next full read is the reconciler.
		}
	}

	async function onMarkAllRead() {
		if (markAllBusy || allMarked) return;
		setMarkAllBusy(true);
		try {
			await fate.mutations.bildirim.markAllRead({input: {}, view: MarkReceiptView});
			setAllMarked(true);
		} catch {
			// Leave state as-is; the action stays retryable.
		} finally {
			setMarkAllBusy(false);
		}
	}

	if (items.length === 0) {
		return (
			<p className="kp-bildirim__empty" data-testid="bildirim-empty">
				henüz bildirimin yok.
			</p>
		);
	}

	return (
		<>
			<div className="kp-bildirim__masthead">
				<span className="kp-bildirim__meta">{items.length} bildirim</span>
				<button
					type="button"
					className="kp-topbar__btn"
					onClick={onMarkAllRead}
					disabled={markAllBusy || allMarked}
					data-testid="bildirim-mark-all"
				>
					{allMarked ? "tümü okundu" : "tümünü okundu say"}
				</button>
			</div>
			<ul className="kp-bildirim__list" data-testid="bildirim-list">
				{items.map(({node}) => (
					<BildirimRow
						key={node.id}
						node={node}
						markedThisSession={markedIds.has(String(node.id))}
						allMarkedThisSession={allMarked}
						onMarkRead={onMarkRead}
					/>
				))}
			</ul>
			{loadNext ? (
				<div className="kp-bildirim__more">
					<LoadMoreButton loadNext={loadNext} testId="bildirim-load-more" />
				</div>
			) : null}
		</>
	);
}

function BildirimRow({
	node,
	markedThisSession,
	allMarkedThisSession,
	onMarkRead,
}: {
	node: ViewRef<"Notification">;
	markedThisSession: boolean;
	allMarkedThisSession: boolean;
	onMarkRead: (id: string) => void;
}) {
	const data = useView(BildirimRowView, node);
	const unread = rowUnread(data.readAt, markedThisSession, allMarkedThisSession);
	const target = bildirimTarget(data.targetUrl);

	return (
		<li
			className="kp-bildirim__row"
			data-testid={`bildirim-row-${data.id}`}
			data-unread={unread ? "" : undefined}
		>
			{/* Decorative — the unread state is announced by the row's "okundu" button. */}
			{unread ? <span className="kp-bildirim__dot" aria-hidden="true" /> : null}
			<span className="kp-bildirim__kind">{bildirimCopy(data.kind, data.count)}</span>
			<time className="kp-bildirim__meta" dateTime={data.createdAt}>
				{new Date(data.createdAt).toLocaleDateString("tr-TR")}
			</time>
			<span className="kp-bildirim__spacer" />
			{target.kind === "link" ? (
				<Link
					to={target.href}
					onClick={() => {
						if (unread) onMarkRead(data.id);
					}}
					data-testid={`bildirim-target-${data.id}`}
				>
					{targetLinkLabel(data.targetKind)}
				</Link>
			) : (
				<span className="kp-bildirim__tombstone" data-testid={`bildirim-tombstone-${data.id}`}>
					silinmiş içerik
				</span>
			)}
			{unread ? (
				<button
					type="button"
					className="kp-topbar__btn"
					onClick={() => onMarkRead(data.id)}
					data-testid={`bildirim-mark-${data.id}`}
				>
					okundu
				</button>
			) : null}
		</li>
	);
}
