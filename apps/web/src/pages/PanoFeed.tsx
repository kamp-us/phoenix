/**
 * Pano feed page — fate. One `PanoFeed` serves every subfeed, selected by the
 * deep-linkable `?sort=` param: the sort subfeeds (sıcak / yeni / en iyi /
 * tartışma) and the per-viewer kaydedilenler collection (`?sort=saved`), one feed
 * shape + one routing model (#2196).
 *
 * The sort subfeeds share `useRequest({posts, args:{sort}})` + `useLiveListView`;
 * connection identity keeps the filter args (`sort`/`host`) but strips pagination,
 * so each combo paginates independently. The saved variant is the same feed shape
 * over a DIFFERENT data source (`savedPosts`) with its own preserved behavior:
 * signed-in-only (auth redirect w/ `returnTo`), live-`isSaved` row-drop via
 * `savedReconcile`, and no ranks (a personal collection has no ordinal meaning).
 */
import * as React from "react";
import {useLiveListView, useLiveView, useRequest, type ViewRef} from "react-fate";
import {Link, Navigate, useNavigate, useSearchParams} from "react-router";
import {useSession} from "../auth/client";
import {Subnav, type SubnavFilter} from "../components/layout/Subnav";
import {PanoCrumb} from "../components/pano/index";
import {PanoPostCard, PanoPostCardView} from "../components/pano/PanoPostCard";
import {PanoFeedSkeleton} from "../components/pano/PanoSkeleton";
import {useSetPanoSubnavContent} from "../components/pano/PanoSubnavLayout";
import {Screen} from "../fate/Screen";
import {FEED_SNAPSHOT_ENABLED} from "../fate/snapshot";
import {LoadMoreButton} from "../fate/wire";
import {MEMBER_MUTE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {markFeedPaintOnce} from "../lib/feedPerf";
import {
	PANO_FEED_PAGE_SIZE,
	PANO_FILTERS,
	PANO_SORT_PARAM,
	panoActiveFilterId,
	panoSortParamFromFilterId,
	panoVariantFromParam,
	SAVED_HREF,
	SAVED_PANO_FILTER_ID,
} from "../lib/panoNav";
import {authRedirectPath} from "../lib/returnTo";
import {countSavedRows, isRowSaved} from "./savedReconcile";

/**
 * `live: {prepend: "visible"}` makes a server-pushed `prependNode` (a new post
 * from another client) appear at the top immediately, instead of fate's default
 * `"edge"` mode buffering it until a page load. See `.patterns/fate-live-views.md`.
 */
const PostConnectionView = {
	items: {node: PanoPostCardView},
	live: {prepend: "visible"},
} as const;

const SavedConnectionView = {
	items: {node: PanoPostCardView},
} as const;

type Chrome = (children: React.ReactNode, meta: React.ReactNode) => React.ReactNode;

export function PanoFeed({host}: {host?: string}) {
	// The `?sort=` param is the source of truth for the active variant: derived every
	// render (not seeded once), and switching a chip writes it back to the URL — so
	// reload, back/forward, and share-current-URL all preserve the active subfeed
	// instead of resetting to the default (#2072). The saved variant is `?sort=saved`.
	const [searchParams, setSearchParams] = useSearchParams();
	const session = useSession();
	const variant = panoVariantFromParam(searchParams.get(PANO_SORT_PARAM));
	const filterId = panoActiveFilterId(variant);
	// Switching a chip swaps to a different connection, so the content re-suspends.
	// Writing the `?sort=` param inside `startTransition` marks that re-fetch as
	// non-urgent: React keeps the CURRENT feed committed + interactive under the stable
	// `<Screen>` boundary instead of hard-swapping to the skeleton, and surfaces the
	// in-flight swap as `isPending` (#2161). The cold load still shows the skeleton.
	const [isPending, startTransition] = React.useTransition();
	// Push (not replace) a history entry so browser back/forward step across the
	// visited subfeeds, per the acceptance criteria.
	const setFilterId = React.useCallback(
		(id: string) => {
			startTransition(() => {
				setSearchParams((prev) => {
					const next = new URLSearchParams(prev);
					next.set(PANO_SORT_PARAM, panoSortParamFromFilterId(id));
					return next;
				});
			});
		},
		[setSearchParams],
	);

	const signedIn = !!session.data?.user;
	const chrome: Chrome = (children, meta) => (
		<FeedChrome
			host={host}
			filterId={filterId}
			setFilterId={setFilterId}
			signedIn={signedIn}
			meta={meta}
		>
			{children}
		</FeedChrome>
	);

	// Saved is signed-in only: a signed-out load redirects to auth with a `returnTo`
	// back to kaydedilenler.
	if (variant.kind === "saved") {
		if (session.isPending) return null;
		if (!signedIn) return <Navigate to={authRedirectPath(SAVED_HREF)} replace />;
	}

	return (
		<Screen
			fallback={chrome(<PanoFeedSkeleton />, "")}
			error={({code}) =>
				chrome(
					<p style={{font: "var(--t-meta)", color: "var(--danger)"}}>
						{variant.kind === "saved" ? "kaydedilenler" : "başlıklar"} yüklenemedi:{" "}
						{code.toLowerCase()}
					</p>,
					"",
				)
			}
		>
			{variant.kind === "saved" ? (
				<SavedContent chrome={chrome} />
			) : (
				<FeedContent host={host} sort={variant.sort} pending={isPending} chrome={chrome} />
			)}
		</Screen>
	);
}

function FeedContent({
	host,
	sort,
	pending,
	chrome,
}: {
	host?: string;
	sort: string;
	pending: boolean;
	chrome: Chrome;
}) {
	// Member-mute (#3117), dark behind `member-mute`. Read once here and threaded to every row
	// so a card can hide a muted member's post + offer the "sustur" action without each card
	// re-evaluating the flag. Off (default) ⇒ no mute surface, byte-identical to today.
	const {value: muteEnabled} = useFlag(MEMBER_MUTE, false);
	// Feed snapshot (leg A, #2319): under the containment flag, run the feed read
	// stale-while-revalidate so a snapshot hydrated into the public client paints
	// synchronously and the network patch lands in the background. Flag off ⇒ an
	// `undefined` options arg, behaviorally identical to today's cache-first default.
	const {posts} = useRequest(
		{
			posts: {
				list: PostConnectionView,
				args: {sort, first: PANO_FEED_PAGE_SIZE, ...(host ? {host} : {})},
			},
		},
		FEED_SNAPSHOT_ENABLED ? {mode: "stale-while-revalidate"} : undefined,
	);

	return (
		<FeedRows
			connection={posts}
			host={host}
			pending={pending}
			chrome={chrome}
			muteEnabled={muteEnabled}
		/>
	);
}

type PostConnection = ReturnType<
	typeof useRequest<{posts: {list: typeof PostConnectionView}}>
>["posts"];

function FeedRows({
	connection,
	host,
	pending,
	chrome,
	muteEnabled,
}: {
	connection: PostConnection;
	host?: string;
	pending: boolean;
	chrome: Chrome;
	muteEnabled: boolean;
}) {
	const [items, loadNext] = useLiveListView(PostConnectionView, connection);

	// Reload→first-feed-paint instrumentation (#2326, epic #2316): mark the first committed
	// feed rows so the epic's founding floor is readable in a DevTools/Performance trace.
	// Fires once per tab (the module latches) and classifies the path (snapshot/edge/cold)
	// from the boot-time snapshot signal; no-op when the instrument is off. See `feedPerf.ts`.
	React.useEffect(() => {
		if (items.length > 0) markFeedPaintOnce();
	}, [items.length]);

	const meta = host ? `${items.length} başlık · ${host}` : `${items.length} başlık`;

	return chrome(
		<>
			{/* During a chip-driven sort swap the current rows stay committed but dim +
			    go inert (`aria-busy`), so the swap reads as "loading the next sort" rather
			    than a frozen screen — the `startTransition` in the parent keeps them here
			    instead of unmounting to the skeleton (#2161). */}
			<div
				className="kp-pano-list"
				aria-busy={pending}
				style={
					pending
						? {opacity: 0.6, transition: "opacity var(--motion-base) var(--ease-standard)"}
						: undefined
				}
			>
				{items.map(({node}, i) => (
					<PanoPostCard key={node.id} post={node} rank={i + 1} compose muteEnabled={muteEnabled} />
				))}
			</div>
			{loadNext ? (
				<div style={{marginTop: "var(--s-3)", display: "flex", justifyContent: "center"}}>
					<LoadMoreButton loadNext={loadNext} />
				</div>
			) : null}
		</>,
		meta,
	);
}

function SavedContent({chrome}: {chrome: Chrome}) {
	const {savedPosts} = useRequest({
		savedPosts: {
			list: SavedConnectionView,
			args: {first: PANO_FEED_PAGE_SIZE},
		},
	});

	return <SavedRows connection={savedPosts} chrome={chrome} />;
}

type SavedConnection = ReturnType<
	typeof useRequest<{savedPosts: {list: typeof SavedConnectionView}}>
>["savedPosts"];

function SavedRows({connection, chrome}: {connection: SavedConnection; chrome: Chrome}) {
	const [items, loadNext] = useLiveListView(SavedConnectionView, connection);

	// Each row reads its `isSaved` via its own `useLiveView` hook, and lifting that read
	// into a parent loop would vary the hook count as pagination grows `items` — illegal.
	// So rows report their live `isSaved` up here; the count + empty-state then use the
	// SAME rule the row drops on (`savedReconcile`), never edge-`node` truthiness (#1417).
	const [savedById, setSavedById] = React.useState<ReadonlyMap<string | number, boolean>>(
		() => new Map(),
	);
	const reportSaved = React.useCallback((id: string | number, saved: boolean) => {
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

	return chrome(
		<>
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
		</>,
		count === 0 ? "0 kayıt" : `${count} kayıt`,
	);
}

/**
 * One saved row. Reads the post's live `isSaved` so an un-save (from this card's own
 * `PostSaveButton`, or another client/tab) drops the row immediately, and reports that
 * same saved-ness up so the list count + empty-state track it. Ranks are omitted — a
 * saved list has no ordinal meaning.
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
	React.useEffect(() => {
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

interface ChromeProps {
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	signedIn: boolean;
	meta: React.ReactNode;
	children: React.ReactNode;
}

function FeedChrome({host, filterId, setFilterId, signedIn, meta, children}: ChromeProps) {
	// kaydedilenler is a per-viewer chip, so it joins the sort chips only signed-in —
	// same subnav row, driven by the same `onFilterChange` → `?sort=` mechanism (#1641).
	const filters = React.useMemo<SubnavFilter[]>(
		() =>
			signedIn
				? [...PANO_FILTERS, {id: SAVED_PANO_FILTER_ID, label: "kaydedilenler"}]
				: PANO_FILTERS,
		[signedIn],
	);
	// Per the nav-IA placement law (#2601), pano's Subnav lives in the persistent product zone
	// (`PanoSubnavLayout`), not per-page here: publish this feed's filters/meta/crumb UP into
	// that zone rather than painting a second Subnav, and fold the active site-filter into the
	// zone's crumb slot as transient state paint — so the resting-chrome PanoCrumb strip is
	// gone. `inZone` requires the zone ancestor's setter, so the eager public paint above the
	// router (App.tsx, no ancestor) keeps its own Subnav + PanoCrumb strip.
	const setPanoSubnav = useSetPanoSubnavContent();
	const navigate = useNavigate();
	const inZone = setPanoSubnav != null;

	React.useEffect(() => {
		if (!inZone || !setPanoSubnav) return;
		setPanoSubnav({
			filters,
			activeFilter: filterId,
			onFilterChange: setFilterId,
			meta,
			...(host ? {crumb: {label: <>site / {host}</>, onClear: () => navigate("/pano")}} : {}),
		});
	}, [inZone, setPanoSubnav, filters, filterId, setFilterId, meta, host, navigate]);
	// Clear the zone's content when this feed leaves for a non-feed `/pano/*` route, so the
	// persistent zone falls back to just its CTA. Keyed on the stable setter, so it fires on
	// unmount only — not on every filter/meta change (which the publish effect above tracks).
	React.useEffect(() => {
		return () => setPanoSubnav?.(null);
	}, [setPanoSubnav]);

	if (inZone) {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">{children}</div>
			</div>
		);
	}
	return (
		<>
			<Subnav filters={filters} activeFilter={filterId} onFilterChange={setFilterId} meta={meta} />
			{host ? <PanoCrumb host={host} /> : null}
			<div className="kp-page">
				<div className="kp-page__inner">{children}</div>
			</div>
		</>
	);
}
