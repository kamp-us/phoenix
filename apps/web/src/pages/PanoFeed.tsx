/**
 * Pano feed page.
 *
 * Idiomatic Relay shape: a top-level `useLazyLoadQuery` spreads the
 * `PanoFeedPostsFragment` into the `Query`, then `usePaginationFragment` reads
 * the connection. Each row is a fragment ref handed to `PanoPostCard` (which
 * declares its own `PanoPostCardFragment on Post`). A hand-written `updater`
 * on `submitPost` prepends the new edge into the active connection; deletes
 * use `@deleteRecord` and need no updater.
 *
 * Mirrors kampus's `apps/kamp-us/src/pages/Library.tsx` — same connection-key
 * naming convention (`PanoFeed_posts`), same `client:${parent.__id}:__<key>_connection`
 * connection-id template.
 */
import * as React from "react";
import {graphql, useLazyLoadQuery, usePaginationFragment} from "react-relay";
import type {PanoFeedPostsFragment$key} from "../__generated__/PanoFeedPostsFragment.graphql";
import type {PanoFeedQuery, PostSort} from "../__generated__/PanoFeedQuery.graphql";
import {PanoCrumb, PanoPostCard} from "../components/pano/index";
import {Subnav} from "../components/layout/Subnav";
import {Button} from "../components/ui/Button";
import {QueryBoundary} from "../relay/QueryBoundary";

const FeedQuery = graphql`
	query PanoFeedQuery($sort: PostSort, $host: String, $first: Int) {
		__id
		...PanoFeedPostsFragment @arguments(sort: $sort, host: $host, first: $first)
	}
`;

/**
 * `PanoFeed_posts` connection on `Query`, keyed by `(sort, host)` so each
 * filter combo lives in its own store entry — switching filters and back
 * reads from the existing edges instead of refetching.
 */
const PanoFeedPostsFragmentDef = graphql`
	fragment PanoFeedPostsFragment on Query
	@argumentDefinitions(
		sort: {type: "PostSort"}
		host: {type: "String"}
		first: {type: "Int", defaultValue: 20}
		after: {type: "String"}
	)
	@refetchable(queryName: "PanoFeedPostsPaginationQuery") {
		posts(sort: $sort, host: $host, first: $first, after: $after)
			@connection(key: "PanoFeed_posts", filters: ["sort", "host"]) {
			edges {
				node {
					id
					# Tags duplicated at the parent level so the client-side
					# tartışma tag filter can run without unmasking the fragment
					# (the card declares its own copy via PanoPostCardFragment).
					tags {
						kind
					}
					...PanoPostCardFragment
				}
			}
			pageInfo {
				hasNextPage
				endCursor
			}
			totalCount
		}
	}
`;

const PAGE_SIZE = 20;

/**
 * UI sort labels (Turkish) → server `PostSort` enum. The `tartışma` filter
 * is a client-side tag filter today; once the server grows tag filtering it
 * can collapse onto the `posts` `sort: discuss` enum (already exists on the
 * server but reads as "most-commented" rather than "tag = discuss").
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
		<QueryBoundary
			loading={
				<FeedChrome
					host={host}
					filterId={filterId}
					setFilterId={setFilterId}
					status="loading"
					meta="yükleniyor…"
				>
					{null}
				</FeedChrome>
			}
			error={(err) => (
				<FeedChrome
					host={host}
					filterId={filterId}
					setFilterId={setFilterId}
					status="error"
					meta=""
				>
					<p style={{font: "var(--t-meta)", color: "var(--danger)"}}>
						başlıklar yüklenemedi: {err.message}
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
		</QueryBoundary>
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
	sort: PostSort;
	tagKind?: string;
}) {
	const queryRef = useLazyLoadQuery<PanoFeedQuery>(FeedQuery, {
		sort,
		host: host ?? null,
		first: PAGE_SIZE,
	});

	return (
		<FeedRows
			query={queryRef}
			host={host}
			filterId={filterId}
			setFilterId={setFilterId}
			tagKind={tagKind}
		/>
	);
}

function FeedRows({
	query,
	host,
	filterId,
	setFilterId,
	tagKind,
}: {
	query: PanoFeedPostsFragment$key & {readonly __id: string};
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	tagKind?: string;
}) {
	const {data, loadNext, hasNext, isLoadingNext} = usePaginationFragment(
		PanoFeedPostsFragmentDef,
		query,
	);

	// Client-side tag filter for the `tartışma` chip — the server doesn't
	// support a tag filter argument yet (PRD open item). Filter is applied
	// post-fetch on the materialized edges; pagination still walks the full
	// server-side ranking.
	const allRows = data.posts.edges.map((e) => e.node);
	const rows = tagKind ? allRows.filter((n) => n.tags.some((t) => t.kind === tagKind)) : allRows;

	const meta = host ? `${rows.length} başlık · ${host}` : `${rows.length} başlık`;

	return (
		<FeedChrome
			host={host}
			filterId={filterId}
			setFilterId={setFilterId}
			status="ok"
			meta={meta}
		>
			<div className="kp-pano-list">
				{rows.map((node, i) => (
					<PanoPostCard key={node.id} post={node} rank={i + 1} />
				))}
			</div>
			{hasNext ? (
				<div style={{marginTop: "var(--s-3)", display: "flex", justifyContent: "center"}}>
					<Button
						variant="tertiary"
						size="sm"
						type="button"
						disabled={isLoadingNext}
						onClick={() => loadNext(PAGE_SIZE)}
					>
						{isLoadingNext ? "yükleniyor…" : "daha fazla"}
					</Button>
				</div>
			) : null}
		</FeedChrome>
	);
}

interface ChromeProps {
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	status: "loading" | "ok" | "error";
	meta: React.ReactNode;
	children: React.ReactNode;
}

function FeedChrome({host, filterId, setFilterId, meta, children}: ChromeProps) {
	return (
		<>
			<Subnav
				filters={FILTERS}
				activeFilter={filterId}
				onFilterChange={setFilterId}
				meta={meta}
			/>
			{host ? <PanoCrumb host={host} /> : null}
			<div className="kp-page">
				<div className="kp-page__inner">{children}</div>
			</div>
		</>
	);
}
