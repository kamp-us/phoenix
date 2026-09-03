/** `BildirimList` — the notification center's list (#1694), with per-row and mark-all read actions. */

import {Button} from "@kampus/design";
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

	// `bildirim.list` has no per-node live topic, so the per-recipient unread count is the
	// coarse signal that a re-read is due (#1700).
	//
	// The count must come from the seed-gated, NON-suspending `useBildirimUnread`, never a
	// `useLiveView(channelRef)`: the suspending read's `readView` fires a `byId` against the
	// loader-less `NotificationChannel` source on a cache miss, which 500s (#2206) and
	// surfaced as the popover's generic "yüklenemedi" (#2982).
	const liveUnread = useBildirimUnread(userId != null, userId);
	const lastUnread = useRef<number | null>(null);
	useEffect(() => {
		if (userId == null) return;
		if (lastUnread.current != null && liveUnread > lastUnread.current) {
			void fate.request(bildirimRequest, {mode: "network-only"}).catch(() => {});
		}
		lastUnread.current = liveUnread;
	}, [liveUnread, userId, fate]);

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
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="kp-topbar__btn"
					onClick={onMarkAllRead}
					disabled={markAllBusy || allMarked}
					loading={markAllBusy}
					data-testid="bildirim-mark-all"
				>
					{allMarked ? "tümü okundu" : "tümünü okundu say"}
				</Button>
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
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="kp-topbar__btn"
					onClick={() => onMarkRead(data.id)}
					data-testid={`bildirim-mark-${data.id}`}
				>
					okundu
				</Button>
			) : null}
		</li>
	);
}
