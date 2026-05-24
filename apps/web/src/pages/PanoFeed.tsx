/**
 * Pano feed page — fate.
 *
 * One batched `useRequest({posts: {list, args:{sort, host, first}}})` resolves the
 * feed; `useListView` over the `posts` connection ref paginates ("daha fazla"
 * merges the next page). Each row is a `ViewRef<"Post">` handed to `PanoPostCard`
 * (which declares `PanoPostCardView`). Connection identity strips pagination args
 * (`first`/`after`) but keeps the filter args (`sort`/`host`), so each filter combo
 * is a distinct connection that paginates independently — the same per-filter store
 * behaviour the Relay `@connection(filters: [...])` gave, now declarative.
 *
 * Submitting a post inserts it into the no-filter feed via declarative `insert`
 * (on the submit page) — there is NO imperative connection-key updater. The old
 * hand-enumerated `panoFeedUpdater` is gone.
 *
 * The `tartışma` chip is a client-side tag filter (the server has no tag-filter
 * arg yet). It needs each row's tags, so a thin `FilterablePostCard` reads the
 * node and drops out of the DOM when the active tag excludes it — one `useView`
 * per node, the filter colocated (mirrors sözlük's `FilterableTermRow`).
 */
import * as React from "react";
import {useListView, useRequest, useView, type ViewRef} from "react-fate";
import {Subnav} from "../components/layout/Subnav";
import {PanoCrumb} from "../components/pano/index";
import {PanoPostCard, PanoPostCardView} from "../components/pano/PanoPostCard";
import {Button} from "../components/ui/Button";
import {Screen} from "../fate/Screen";

const PAGE_SIZE = 20;

/** The connection selection for the feed — the shape `useListView` reads. */
const PostConnectionView = {items: {node: PanoPostCardView}} as const;

/**
 * UI sort labels (Turkish) → server `sort` string. The `tartışma` filter is a
 * client-side tag filter today; it pages the `hot` feed and filters to the
 * `discuss` tag client-side.
 */
const FILTERS = [
	{id: "sicak", label: "sıcak", sort: "hot" as const},
	{id: "yeni", label: "yeni", sort: "new" as const},
	{id: "en-iyi", label: "en iyi", sort: "top" as const},
	{id: "tartisma", label: "tartışma", sort: "hot" as const, tagKind: "discuss"},
];

export function PanoFeed({host}: {host?: string}) {
	const [filterId, setFilterId] = React.useState("sicak");
	const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];
	if (!filter) return null;

	return (
		<Screen
			fallback={
				<FeedChrome host={host} filterId={filterId} setFilterId={setFilterId} meta="yükleniyor…">
					{null}
				</FeedChrome>
			}
			error={({code}) => (
				<FeedChrome host={host} filterId={filterId} setFilterId={setFilterId} meta="">
					<p style={{font: "var(--t-meta)", color: "var(--danger)"}}>
						başlıklar yüklenemedi: {code.toLowerCase()}
					</p>
				</FeedChrome>
			)}
		>
			<FeedContent
				host={host}
				filterId={filterId}
				setFilterId={setFilterId}
				sort={filter.sort}
				tagKind={filter.tagKind}
			/>
		</Screen>
	);
}

function FeedContent({
	host,
	filterId,
	setFilterId,
	sort,
	tagKind,
}: {
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	sort: string;
	tagKind?: string;
}) {
	const {posts} = useRequest({
		posts: {
			list: PostConnectionView,
			args: {sort, first: PAGE_SIZE, ...(host ? {host} : {})},
		},
	});

	return (
		<FeedRows
			connection={posts}
			host={host}
			filterId={filterId}
			setFilterId={setFilterId}
			tagKind={tagKind}
		/>
	);
}

type PostConnection = ReturnType<
	typeof useRequest<{posts: {list: typeof PostConnectionView}}>
>["posts"];

function FeedRows({
	connection,
	host,
	filterId,
	setFilterId,
	tagKind,
}: {
	connection: PostConnection;
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	tagKind?: string;
}) {
	const [items, loadNext] = useListView(PostConnectionView, connection);

	const meta = host ? `${items.length} başlık · ${host}` : `${items.length} başlık`;

	return (
		<FeedChrome host={host} filterId={filterId} setFilterId={setFilterId} meta={meta}>
			<div className="kp-pano-list">
				{items.map(({node}, i) => (
					<FilterablePostCard key={node.id} node={node} rank={i + 1} tagKind={tagKind} />
				))}
			</div>
			{loadNext ? (
				<div style={{marginTop: "var(--s-3)", display: "flex", justifyContent: "center"}}>
					<LoadMoreButton loadNext={loadNext} />
				</div>
			) : null}
		</FeedChrome>
	);
}

/**
 * A feed row that reads its own tags and drops out of the DOM when the active
 * `tartışma` tag filter excludes it. fate masks by view *identity*, so the filter
 * must read through the **same** view the node ref carries (`PanoPostCardView`,
 * the connection's node view) — a separate tags-only view would throw "Invalid
 * view reference" (1.0.3 masking, see task 6 drift #1). `PanoPostCardView` already
 * selects `tags`, so we read it here and `PanoPostCard` reads the same view again
 * (same identity, served from cache). When no tag filter is active it renders
 * unconditionally.
 */
function FilterablePostCard({
	node,
	rank,
	tagKind,
}: {
	node: ViewRef<"Post">;
	rank: number;
	tagKind?: string;
}) {
	const data = useView(PanoPostCardView, node);
	if (tagKind && !(data.tags ?? []).some((t) => t.kind === tagKind)) return null;
	return <PanoPostCard post={node} rank={rank} />;
}

function LoadMoreButton({loadNext}: {loadNext: () => Promise<void>}) {
	const [loading, setLoading] = React.useState(false);
	return (
		<Button
			variant="tertiary"
			size="sm"
			type="button"
			disabled={loading}
			onClick={async () => {
				setLoading(true);
				try {
					await loadNext();
				} finally {
					setLoading(false);
				}
			}}
		>
			{loading ? "yükleniyor…" : "daha fazla"}
		</Button>
	);
}

interface ChromeProps {
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	meta: React.ReactNode;
	children: React.ReactNode;
}

function FeedChrome({host, filterId, setFilterId, meta, children}: ChromeProps) {
	return (
		<>
			<Subnav filters={FILTERS} activeFilter={filterId} onFilterChange={setFilterId} meta={meta} />
			{host ? <PanoCrumb host={host} /> : null}
			<div className="kp-page">
				<div className="kp-page__inner">{children}</div>
			</div>
		</>
	);
}
