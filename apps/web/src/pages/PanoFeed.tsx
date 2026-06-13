/**
 * Pano feed page — fate. One batched `useRequest({posts: {list, args}})` resolves
 * the feed; `useLiveListView` paginates. Connection identity keeps the filter
 * args (`sort`/`host`) but strips pagination, so each filter combo is a distinct
 * connection that paginates independently. The `tartışma` chip is a client-side
 * tag filter (the server has no tag-filter arg yet).
 */
import * as React from "react";
import {useLiveListView, useLiveView, useRequest, type ViewRef} from "react-fate";
import {Subnav} from "../components/layout/Subnav";
import {PanoCrumb} from "../components/pano/index";
import {PanoPostCard, PanoPostCardView} from "../components/pano/PanoPostCard";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";

const PAGE_SIZE = 20;

/**
 * `live: {prepend: "visible"}` makes a server-pushed `prependNode` (a new post
 * from another client) appear at the top immediately, instead of fate's default
 * `"edge"` mode buffering it until a page load. See `.patterns/fate-live-views.md`.
 */
const PostConnectionView = {
	items: {node: PanoPostCardView},
	live: {prepend: "visible"},
} as const;

/**
 * UI sort labels (Turkish) → server `sort` string. `tartışma` pages the `hot`
 * feed and filters to the `discuss` tag client-side (no server tag-filter arg).
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
	const [items, loadNext] = useLiveListView(PostConnectionView, connection);

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
 * `tartışma` filter excludes it. fate masks by view *identity*, so the filter
 * must read through the **same** view the node ref carries (`PanoPostCardView`) —
 * a separate tags-only view would throw "Invalid view reference".
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
	const data = useLiveView(PanoPostCardView, node);
	if (tagKind && !(data.tags ?? []).some((t) => t.kind === tagKind)) return null;
	return <PanoPostCard post={node} rank={rank} />;
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
