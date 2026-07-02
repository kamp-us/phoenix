/**
 * Saved posts page (`/pano/kaydedilenler`) — the viewer's bookmarks, newest save
 * first. Modeled on `PanoFeed`: one batched `useRequest({savedPosts})` +
 * `useLiveListView` pagination, reusing `PanoPostCard` (which renders
 * `PostSaveButton`). Signed-in only; a signed-out load redirects to auth with a
 * `returnTo` back here.
 *
 * Un-save-from-the-list drops the row immediately: un-saving publishes
 * `live.update("Post", id, {changed:["isSaved"]})` (a per-entity event, so it
 * fans out only to watchers of that post — no cross-viewer leak), and each row
 * reads that live `isSaved` and removes itself the moment it flips false. The
 * server connection therefore needs no per-viewer `deleteEdge` plumbing — the
 * drop is driven entirely by the entity update the card already subscribes to.
 *
 * The list count + empty-state derive from that SAME live `isSaved` rule (`savedReconcile`),
 * not edge-`node` truthiness: since the un-save leaves the edge/node truthy, a node-presence
 * count would over-report vanished rows and never trip the empty state until reload (#1417).
 */
import {type ReactNode, useCallback, useEffect, useState} from "react";
import {useLiveListView, useLiveView, useRequest, type ViewRef} from "react-fate";
import {Link, Navigate} from "react-router";
import {useSession} from "../auth/client";
import {Subnav} from "../components/layout/Subnav";
import "../components/ui/Button.css";
import {PanoPostCard, PanoPostCardView} from "../components/pano/PanoPostCard";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {authRedirectPath} from "../lib/returnTo";
import {countSavedRows, isRowSaved} from "./savedReconcile";

const PAGE_SIZE = 20;

const SavedConnectionView = {
	items: {node: PanoPostCardView},
} as const;

export function SavedPostsPage() {
	const session = useSession();
	if (session.isPending) return null;
	if (!session.data?.user) {
		return <Navigate to={authRedirectPath("/pano/kaydedilenler")} replace />;
	}

	return (
		<Screen
			fallback={<SavedChrome meta="yükleniyor…">{null}</SavedChrome>}
			error={({code}) => (
				<SavedChrome meta="">
					<p style={{font: "var(--t-meta)", color: "var(--danger)"}}>
						kaydedilenler yüklenemedi: {code.toLowerCase()}
					</p>
				</SavedChrome>
			)}
		>
			<SavedContent />
		</Screen>
	);
}

function SavedContent() {
	const {savedPosts} = useRequest({
		savedPosts: {
			list: SavedConnectionView,
			args: {first: PAGE_SIZE},
		},
	});

	return <SavedRows connection={savedPosts} />;
}

type SavedConnection = ReturnType<
	typeof useRequest<{savedPosts: {list: typeof SavedConnectionView}}>
>["savedPosts"];

function SavedRows({connection}: {connection: SavedConnection}) {
	const [items, loadNext] = useLiveListView(SavedConnectionView, connection);

	// Each row reads its `isSaved` via its own `useLiveView` hook, and lifting that read
	// into a parent loop would vary the hook count as pagination grows `items` — illegal.
	// So rows report their live `isSaved` up here; the count + empty-state then use the
	// SAME rule the row drops on (`savedReconcile`), never edge-`node` truthiness (#1417).
	const [savedById, setSavedById] = useState<ReadonlyMap<string | number, boolean>>(
		() => new Map(),
	);
	const reportSaved = useCallback((id: string | number, saved: boolean) => {
		setSavedById((prev) => {
			if (prev.get(id) === saved) return prev;
			const next = new Map(prev);
			next.set(id, saved);
			return next;
		});
	}, []);

	// A genuinely deleted entity has no node — that's edge presence (a row can't render),
	// NOT saved-ness, which is the live `isSaved` below.
	const nodes = items.flatMap(({node}) => (node ? [node] : []));
	const count = countSavedRows(
		nodes.map((node) => node.id),
		savedById,
	);

	return (
		<SavedChrome meta={count === 0 ? "0 kayıt" : `${count} kayıt`}>
			{/* Rows stay mounted even at count 0 so each keeps reporting its live `isSaved`;
			    an unsaved row renders null, so the empty-state message is the only visible
			    content when the still-saved count reaches 0. */}
			<div className="kp-pano-list">
				{nodes.map((node) => (
					<SavedRow key={node.id} post={node} onReconcile={reportSaved} />
				))}
			</div>
			{count === 0 ? (
				<SavedEmptyState />
			) : loadNext ? (
				<div style={{marginTop: "var(--s-3)", display: "flex", justifyContent: "center"}}>
					<LoadMoreButton loadNext={loadNext} />
				</div>
			) : null}
		</SavedChrome>
	);
}

/**
 * One saved row. Reads the post's live `isSaved` so an un-save (from this card's
 * own `PostSaveButton`, or another client/tab) drops the row immediately, and
 * reports that same saved-ness up so the list count + empty-state track it. Ranks
 * are omitted — a saved list has no ordinal meaning, it's a personal collection.
 */
function SavedRow({
	post,
	onReconcile,
}: {
	post: ViewRef<"Post">;
	onReconcile: (id: string | number, saved: boolean) => void;
}) {
	const data = useLiveView(PanoPostCardView, post);
	const saved = isRowSaved(data.isSaved);
	useEffect(() => {
		onReconcile(data.id, saved);
	}, [data.id, saved, onReconcile]);
	if (!saved) return null;
	return <PanoPostCard post={post} />;
}

function SavedEmptyState() {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				textAlign: "center",
				gap: "var(--s-3)",
				padding: "var(--s-8) var(--s-3)",
			}}
		>
			<svg
				width="28"
				height="28"
				viewBox="0 0 24 24"
				fill="none"
				stroke="var(--text-faint)"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
			</svg>
			<div style={{display: "flex", flexDirection: "column", gap: "var(--s-1)"}}>
				<p style={{font: "var(--t-body)", color: "var(--text-primary)", margin: 0}}>
					henüz kaydedilen yok
				</p>
				<p style={{font: "var(--t-meta)", color: "var(--text-muted)", margin: 0}}>
					bir başlığı <strong>kaydet</strong> ile saklayabilirsin.
				</p>
			</div>
			<Link to="/pano" className="kp-btn kp-btn--primary kp-btn--sm">
				pano'yu keşfet
			</Link>
		</div>
	);
}

function SavedChrome({meta, children}: {meta: ReactNode; children: ReactNode}) {
	return (
		<>
			<Subnav title="kaydedilenler" meta={meta} />
			<div className="kp-page">
				<div className="kp-page__inner">{children}</div>
			</div>
		</>
	);
}
