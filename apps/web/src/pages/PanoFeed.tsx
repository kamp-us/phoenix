/**
 * Pano feed page. One component serves every subfeed off the deep-linkable
 * `?sort=` param — including `?sort=saved`, which is the same feed shape over a
 * different data source (`savedPosts`).
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
import {type CatalogKey, plural, useLocale} from "../i18n";
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

// `prepend: "visible"` overrides fate's default `"edge"` buffering — see `.patterns/fate-live-views.md`.
const PostConnectionView = {
	items: {node: PanoPostCardView},
	live: {prepend: "visible"},
} as const;

const SavedConnectionView = {
	items: {node: PanoPostCardView},
} as const;

type Chrome = (children: React.ReactNode, meta: React.ReactNode) => React.ReactNode;

/**
 * The chip copy per filter id. `PANO_FILTERS` still owns the ids, the sorts and their order —
 * this only names the catalog key for each, because the Turkish `label` it carries predates the
 * catalog (#7530). A filter added there without a row here falls back to that label, so a new
 * chip renders rather than vanishing.
 */
const FILTER_LABEL_KEYS: Readonly<Record<string, CatalogKey>> = {
	sicak: "pano.filter.hot",
	yeni: "pano.filter.new",
	"en-iyi": "pano.filter.top",
	tartisma: "pano.filter.discuss",
};

export function PanoFeed({host}: {host?: string}) {
	const {t} = useLocale();
	const [searchParams, setSearchParams] = useSearchParams();
	const session = useSession();
	const variant = panoVariantFromParam(searchParams.get(PANO_SORT_PARAM));
	const filterId = panoActiveFilterId(variant);
	// A chip swap re-suspends the content; writing `?sort=` inside `startTransition` keeps the
	// current feed committed instead of hard-swapping to the skeleton.
	const [isPending, startTransition] = React.useTransition();
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
						{t("pano.feed.loadFailed", {
							what: t(variant.kind === "saved" ? "pano.filter.saved" : "pano.feed.posts"),
							code: code.toLowerCase(),
						})}
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
	const {value: muteEnabled} = useFlag(MEMBER_MUTE, false);
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
	const {locale, t} = useLocale();
	const [items, loadNext] = useLiveListView(PostConnectionView, connection);

	// First-feed-paint instrumentation: latches once per tab, no-op when off. See `feedPerf.ts`.
	React.useEffect(() => {
		if (items.length > 0) markFeedPaintOnce();
	}, [items.length]);

	const count = items.length;
	const meta = host
		? plural(locale, count, {
				one: t("pano.feed.postCountHost.one", {count, host}),
				other: t("pano.feed.postCountHost.other", {count, host}),
			})
		: plural(locale, count, {
				one: t("pano.feed.postCount.one", {count}),
				other: t("pano.feed.postCount.other", {count}),
			});

	return chrome(
		<>
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
	const {locale, t} = useLocale();
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
		plural(locale, count, {
			one: t("pano.feed.savedCount.one", {count}),
			other: t("pano.feed.savedCount.other", {count}),
		}),
	);
}

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
	const {t} = useLocale();
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
					{t("pano.feed.savedEmpty.title")}
				</p>
				<p style={{font: "var(--t-meta)", color: "var(--text-muted)", margin: 0}}>
					{t("pano.feed.savedEmpty.hintBefore")} <strong>{t("pano.save.save")}</strong>
					{t("pano.feed.savedEmpty.hintAfter")}
				</p>
			</div>
			<Link to="/pano" className="kp-btn kp-btn--primary kp-btn--sm">
				{t("pano.feed.savedEmpty.cta")}
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
	const {t} = useLocale();
	const filters = React.useMemo<SubnavFilter[]>(() => {
		const chips: SubnavFilter[] = PANO_FILTERS.map((f) => {
			const key = FILTER_LABEL_KEYS[f.id];
			return {id: f.id, label: key ? t(key) : f.label};
		});
		if (signedIn) chips.push({id: SAVED_PANO_FILTER_ID, label: t("pano.filter.saved")});
		return chips;
	}, [signedIn, t]);
	// Pano's Subnav lives in the persistent zone (`PanoSubnavLayout`), so this feed publishes UP
	// into it rather than painting its own. `inZone` is false only for the eager public paint
	// above the router (App.tsx has no zone ancestor), which keeps the local Subnav fallback.
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
			...(host
				? {
						crumb: {
							label: (
								<>
									{t("pano.crumb.site")} / {host}
								</>
							),
							onClear: () => navigate("/pano"),
						},
					}
				: {}),
		});
	}, [inZone, setPanoSubnav, filters, filterId, setFilterId, meta, host, navigate, t]);
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
