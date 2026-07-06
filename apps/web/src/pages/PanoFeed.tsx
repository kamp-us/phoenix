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
import {PanoFeedSkeleton} from "../components/pano/PanoSkeleton";
import {EmptyState} from "../components/ui/EmptyState";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {
	PANO_FEED_PAGE_SIZE,
	PANO_FILTERS,
	PANO_SORT_PARAM,
	panoFilterIdFromParam,
	panoSortFromFilterId,
	SAVED_LINK,
} from "../lib/panoNav";

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
	// The `?sort=` param is the source of truth for the active subfeed: the chip is
	// derived from it every render (not just seeded once), and switching a chip writes
	// the sort back to the URL — so reload, back/forward, and share-current-URL all
	// preserve the active subfeed instead of resetting to the default (#2072).
	const [searchParams, setSearchParams] = useSearchParams();
	const filterId = panoFilterIdFromParam(searchParams.get(PANO_SORT_PARAM));
	// Switching a chip swaps to a different `sort` connection, so `FeedContent`
	// re-suspends. Writing the `?sort=` param inside `startTransition` marks that
	// re-fetch as non-urgent: React keeps the CURRENT feed committed + interactive
	// under the stable `<Screen>` boundary instead of hard-swapping to the skeleton,
	// and surfaces the in-flight swap as `isPending` (#2161). The initial cold load
	// still shows the skeleton — there's no prior content to preserve there.
	const [isPending, startTransition] = React.useTransition();
	// Push (not replace) a history entry so browser back/forward step across the
	// visited subfeeds, per the acceptance criteria.
	const setFilterId = React.useCallback(
		(id: string) => {
			startTransition(() => {
				setSearchParams((prev) => {
					const next = new URLSearchParams(prev);
					next.set(PANO_SORT_PARAM, panoSortFromFilterId(id));
					return next;
				});
			});
		},
		[setSearchParams],
	);
	const filter = PANO_FILTERS.find((f) => f.id === filterId) ?? PANO_FILTERS[0];
	if (!filter) return null;

	return (
		<Screen
			fallback={
				<FeedChrome host={host} filterId={filterId} setFilterId={setFilterId} meta="">
					<PanoFeedSkeleton />
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
				pending={isPending}
			/>
		</Screen>
	);
}

function FeedContent({
	host,
	filterId,
	setFilterId,
	sort,
	pending,
}: {
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	sort: string;
	pending: boolean;
}) {
	const {posts} = useRequest({
		posts: {
			list: PostConnectionView,
			args: {sort, first: PANO_FEED_PAGE_SIZE, ...(host ? {host} : {})},
		},
	});

	return (
		<FeedRows
			connection={posts}
			host={host}
			filterId={filterId}
			setFilterId={setFilterId}
			pending={pending}
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
	pending,
}: {
	connection: PostConnection;
	host?: string;
	filterId: string;
	setFilterId: (id: string) => void;
	pending: boolean;
}) {
	const [items, loadNext] = useLiveListView(PostConnectionView, connection);

	const meta = host ? `${items.length} başlık · ${host}` : `${items.length} başlık`;

	return (
		<FeedChrome host={host} filterId={filterId} setFilterId={setFilterId} meta={meta}>
			{/* During a chip-driven sort swap the current rows stay committed but dim +
			    go inert (`aria-busy`), so the swap reads as "loading the next sort" rather
			    than a frozen screen — the `startTransition` in the parent keeps them here
			    instead of unmounting to the skeleton (#2161). */}
			{items.length === 0 && !pending ? (
				<EmptyState
					title={host ? `${host} için henüz başlık yok.` : "henüz başlık yok."}
					description="ilk başlığı sen aç — pano seni bekliyor."
				/>
			) : (
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
						<PanoPostCard key={node.id} post={node} rank={i + 1} />
					))}
				</div>
			)}
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
