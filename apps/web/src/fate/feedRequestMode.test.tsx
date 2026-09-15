/**
 * Regression for #9266 — the pano feed forgot its loaded pages on back navigation.
 *
 * The probe below is `PanoFeed`'s `FeedContent` reduced to its fate wiring: the same root
 * `posts(sort, first: PANO_FEED_PAGE_SIZE)` request, the same `useFeedRequestMode` choice
 * over it, and the same `useLiveListView` read. Rendering the page itself would drag in the
 * router, the session and the flag client without exercising one more line of the path
 * under test.
 *
 * Unmounting and re-rendering IS the navigation: `/pano` and `/pano/:id` are sibling routes
 * (`App.tsx`), so opening a post unmounts the feed and returning mounts a fresh one against
 * the same client — the three return routes in the report (the "akışa dön" button, browser
 * back, its keyboard shortcut) are one and the same remount.
 *
 * `snapshotEnabled: true` is the production build configuration (`VITE_FEED_SNAPSHOT=on`,
 * `.github/workflows/deploy.yml`), and it is the arm that used to reset the feed.
 */
import {clientRoot, createClient} from "@nkzw/fate";
import {act, render, screen} from "@testing-library/react";
import * as React from "react";
import {FateClient, useLiveListView, useRequest, view} from "react-fate";
import {describe, expect, it} from "vitest";
import {PANO_FEED_PAGE_SIZE} from "../lib/panoNav";
import {feedRequestMode, REVALIDATE_FEED, useFeedRequestMode} from "./feedRequestMode";

type Post = {__typename: "Post"; id: string; title: string};

const PostView = view<Post>()({id: true, title: true});
const PostConnectionView = {items: {node: PostView}} as const;

const CORPUS = Array.from({length: 60}, (_, index) => ({
	id: `post_${index}`,
	title: `title ${index}`,
}));

/** Forward-only, exactly like every phoenix list (`worker/features/fate/connection.ts`). */
function page(first: number, after: string | undefined) {
	const start = after ? CORPUS.findIndex((post) => post.id === after) + 1 : 0;
	const rows = CORPUS.slice(start, start + first);
	return {
		items: rows.map((node) => ({cursor: node.id, node})),
		pagination: {
			hasNext: start + first < CORPUS.length,
			hasPrevious: false,
			nextCursor: rows.at(-1)?.id,
		},
	};
}

const FEED_REQUEST = {
	posts: {list: PostConnectionView, args: {sort: "hot", first: PANO_FEED_PAGE_SIZE}},
};

function makeClient() {
	const fetched: Array<Record<string, unknown>> = [];
	const client = createClient({
		hydrationScope: "test",
		roots: {posts: clientRoot<Post, "Post">("Post")},
		types: [{type: "Post"}],
		transport: {
			fetchById: async () => [],
			fetchList: async (
				_procedure: string,
				_select: Iterable<string>,
				args?: Record<string, unknown>,
			) => {
				fetched.push({...args});
				const after = args?.after;
				return page(
					Number(args?.first ?? PANO_FEED_PAGE_SIZE),
					typeof after === "string" ? after : undefined,
				);
			},
			// The app's anonymous client grafts the same no-ops on (`fate/client.ts`).
			subscribeById: () => () => undefined,
			subscribeConnection: () => () => undefined,
		},
	});
	return {client, fetched};
}

type TestClient = ReturnType<typeof makeClient>["client"];

/**
 * What `FeedContent` reads off the generated client as `…posts.items.length`. The roots here
 * are declared in this file rather than generated, so the result type resolves to `never` and
 * the shape has to be named locally.
 */
function cachedRows(client: TestClient): number {
	const result: unknown = client.getRequestResult(FEED_REQUEST);
	return (result as {posts?: {items?: ReadonlyArray<unknown>}}).posts?.items?.length ?? 0;
}

let loadNextPage: (() => Promise<void>) | null = null;

function Feed({client, snapshotEnabled}: {client: TestClient; snapshotEnabled: boolean}) {
	const mode = useFeedRequestMode(
		"hot",
		snapshotEnabled,
		() => cachedRows(client),
		PANO_FEED_PAGE_SIZE,
	);
	const {posts} = useRequest(FEED_REQUEST, mode);
	return <Rows connection={posts} />;
}

type FeedConnection = ReturnType<typeof useRequest<typeof FEED_REQUEST>>["posts"];

function Rows({connection}: {connection: FeedConnection}) {
	const [items, loadNext] = useLiveListView(PostConnectionView, connection);
	loadNextPage = loadNext;
	return <output data-testid="rows">{items.length}</output>;
}

async function settle() {
	for (let tick = 0; tick < 5; tick += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
}

async function openFeed(client: TestClient, snapshotEnabled: boolean) {
	let mounted!: ReturnType<typeof render>;
	await act(async () => {
		mounted = render(
			<FateClient client={client}>
				<React.Suspense fallback={<output data-testid="rows">…</output>}>
					<Feed client={client} snapshotEnabled={snapshotEnabled} />
				</React.Suspense>
			</FateClient>,
		);
	});
	await settle();
	return mounted;
}

const rowCount = () => screen.getByTestId("rows").textContent;

describe("pano feed window survives leaving and returning (#9266)", () => {
	for (const snapshotEnabled of [true, false]) {
		it(`keeps every loaded page across a remount with snapshots ${snapshotEnabled ? "on" : "off"}`, async () => {
			const {client} = makeClient();

			const feed = await openFeed(client, snapshotEnabled);
			expect(rowCount()).toBe("20");

			await act(async () => {
				await loadNextPage?.();
			});
			expect(rowCount()).toBe("40");

			feed.unmount();
			await settle();

			await openFeed(client, snapshotEnabled);
			expect(rowCount()).toBe("40");
		});
	}

	it("still revalidates the first page when the first page is the whole window", async () => {
		const {client, fetched} = makeClient();

		const feed = await openFeed(client, true);
		expect(rowCount()).toBe("20");
		expect(fetched).toHaveLength(1);

		feed.unmount();
		await settle();

		await openFeed(client, true);
		expect(rowCount()).toBe("20");
		expect(fetched).toHaveLength(2);
	});
});

describe("feedRequestMode", () => {
	it("revalidates while the cached window is at most one page", () => {
		expect(feedRequestMode(true, 0, 20)).toBe(REVALIDATE_FEED);
		expect(feedRequestMode(true, 20, 20)).toBe(REVALIDATE_FEED);
	});

	it("reads from cache once the reader has paged past the first page", () => {
		expect(feedRequestMode(true, 21, 20)).toBeUndefined();
		expect(feedRequestMode(true, 40, 20)).toBeUndefined();
	});

	it("never revalidates with no snapshot to refresh", () => {
		expect(feedRequestMode(false, 0, 20)).toBeUndefined();
		expect(feedRequestMode(false, 40, 20)).toBeUndefined();
	});
});
