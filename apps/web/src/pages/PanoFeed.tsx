/**
 * Pano feed page — fate. One batched `useRequest({posts: {list, args}})` resolves
 * the feed; `useLiveListView` paginates. Connection identity keeps the filter
 * args (`sort`/`host`) but strips pagination, so each filter combo is a distinct
 * connection that paginates independently. Every chip maps to a server `sort`,
 * so the feed pages and counts the result set the server returns directly.
 */
import * as React from "react";
import {useLiveListView, useRequest} from "react-fate";
import {useSearchParams} from "react-router";
import {useSession} from "../auth/client";
import {Subnav} from "../components/layout/Subnav";
import {PanoCrumb} from "../components/pano/index";
import {PanoPostCard, PanoPostCardView} from "../components/pano/PanoPostCard";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {PANO_FILTERS, PANO_SORT_PARAM, panoFilterIdFromParam, SAVED_LINK} from "../lib/panoNav";

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

export function PanoFeed({host}: {host?: string}) {
	// Seed the chip from `?sort=` so a deep link (e.g. the saved page's sort links)
	// opens the right feed; in-feed switching stays local chip state, unchanged.
	const [searchParams] = useSearchParams();
	const [filterId, setFilterId] = React.useState(() =>
		panoFilterIdFromParam(searchParams.get(PANO_SORT_PARAM)),
	);
	const filter = PANO_FILTERS.find((f) => f.id === filterId) ?? PANO_FILTERS[0];
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
			<FeedContent host={host} filterId={filterId} setFilterId={setFilterId} sort={filter.sort} />
		</Screen>
	);
}

function FeedContent({
	host,
	filterId,
	setFilterId,
	sort,
}: {
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	sort: string;
}) {
	const {posts} = useRequest({
		posts: {
			list: PostConnectionView,
			args: {sort, first: PAGE_SIZE, ...(host ? {host} : {})},
		},
	});

	return <FeedRows connection={posts} host={host} filterId={filterId} setFilterId={setFilterId} />;
}

type PostConnection = ReturnType<
	typeof useRequest<{posts: {list: typeof PostConnectionView}}>
>["posts"];

function FeedRows({
	connection,
	host,
	filterId,
	setFilterId,
}: {
	connection: PostConnection;
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
}) {
	const [items, loadNext] = useLiveListView(PostConnectionView, connection);

	const meta = host ? `${items.length} başlık · ${host}` : `${items.length} başlık`;

	return (
		<FeedChrome host={host} filterId={filterId} setFilterId={setFilterId} meta={meta}>
			<div className="kp-pano-list">
				{items.map(({node}, i) => (
					<PanoPostCard key={node.id} post={node} rank={i + 1} />
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

interface ChromeProps {
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	meta: React.ReactNode;
	children: React.ReactNode;
}

function FeedChrome({host, filterId, setFilterId, meta, children}: ChromeProps) {
	const session = useSession();
	const links = session.data?.user ? [SAVED_LINK] : undefined;

	return (
		<>
			<Subnav
				filters={PANO_FILTERS}
				activeFilter={filterId}
				onFilterChange={setFilterId}
				links={links}
				meta={meta}
			/>
			{host ? <PanoCrumb host={host} /> : null}
			<div className="kp-page">
				<div className="kp-page__inner">{children}</div>
			</div>
		</>
	);
}
