/**
 * `BildirimList` — the notification center's list (#1694): the `bildirim.list`
 * connection paginated via `useListView`, with per-row mark-read and a
 * mark-all-read header action. Read state folds the server `readAt` stamp with
 * this session's mark actions (`rowUnread`) — the receipt doesn't rewrite listed
 * rows, so the fold is what makes a marked row stop reading as unread without a
 * reload. A dead target (`targetUrl: null`) renders the tombstone row
 * (`bildirimTarget`), never a broken link.
 */
import {useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {Notification, NotificationMarkReceipt} from "../../../worker/features/fate/views";
import {LoadMoreButton} from "../../fate/wire";
import {bildirimCopy, bildirimTarget, rowUnread, targetLinkLabel} from "./bildirim";

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
