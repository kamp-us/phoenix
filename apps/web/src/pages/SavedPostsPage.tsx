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
 */
import type * as React from "react";
import {useLiveListView, useLiveView, useRequest, type ViewRef} from "react-fate";
import {Navigate} from "react-router";
import {useSession} from "../auth/client";
import {Subnav} from "../components/layout/Subnav";
import {PanoPostCard, PanoPostCardView} from "../components/pano/PanoPostCard";
import {Screen} from "../fate/Screen";
import {useLiveListKeepAlive} from "../fate/useLiveKeepAlive";
import {LoadMoreButton} from "../fate/wire";
import {authRedirectPath} from "../lib/returnTo";

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
	// Pin the SSE connection on the saved-list's stable `listKey` for the list's
	// mount lifetime, so a save/unsave mutation's re-subscribe churn never drops
	// the refcount to 0 and drops a live update (#708; #711 is the durable
	// transport fix). See `apps/web/src/fate/useLiveKeepAlive.ts`.
	useLiveListKeepAlive(SavedConnectionView, connection);
	const [items, loadNext] = useLiveListView(SavedConnectionView, connection);

	// `items.length` counts edges still in the connection; an un-saved row stays
	// an edge but renders nothing (`SavedRow` returns null), so the count would
	// over-report. Drive the meta + empty state off the still-saved count instead.
	const savedNodes = items.filter(({node}) => node);

	if (savedNodes.length === 0) {
		return (
			<SavedChrome meta="0 kayıt">
				<p style={{font: "var(--t-meta)", color: "var(--text-muted)"}}>
					henüz kaydedilen yok — bir başlığı <strong>kaydet</strong> ile saklayabilirsin.
				</p>
			</SavedChrome>
		);
	}

	return (
		<SavedChrome meta={`${savedNodes.length} kayıt`}>
			<div className="kp-pano-list">
				{savedNodes.map(({node}) => (
					<SavedRow key={node.id} post={node} />
				))}
			</div>
			{loadNext ? (
				<div style={{marginTop: "var(--s-3)", display: "flex", justifyContent: "center"}}>
					<LoadMoreButton loadNext={loadNext} />
				</div>
			) : null}
		</SavedChrome>
	);
}

/**
 * One saved row. Reads the post's live `isSaved` so an un-save (from this card's
 * own `PostSaveButton`, or another client/tab) drops the row immediately. Ranks
 * are omitted — a saved list has no ordinal meaning, it's a personal collection.
 */
function SavedRow({post}: {post: ViewRef<"Post">}) {
	const data = useLiveView(PanoPostCardView, post);
	if (data.isSaved === false) return null;
	return <PanoPostCard post={post} />;
}

function SavedChrome({meta, children}: {meta: React.ReactNode; children: React.ReactNode}) {
	return (
		<>
			<Subnav title="kaydedilenler" meta={meta} />
			<div className="kp-page">
				<div className="kp-page__inner">{children}</div>
			</div>
		</>
	);
}
