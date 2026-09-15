/**
 * Regression for #9266 — the pano feed forgot its loaded pages on back navigation.
 *
 * This drives the page's own wiring. `usePanoFeedPosts` is the hook `FeedContent` calls, with
 * the page's real root request and its real `PanoFeedConnectionView`; a local copy of that
 * wiring would keep passing while the page pinned `{mode: "stale-while-revalidate"}` back at
 * the callsite, which is exactly the change this test exists to stop.
 *
 * Unmounting and re-rendering IS the navigation: `/pano` and `/pano/:id` are sibling routes
 * (`App.tsx`), so opening a post unmounts the feed and returning mounts a fresh one against the
 * same client — the three return routes in the report (the "akışa dön" button, browser back,
 * its keyboard shortcut) are one and the same remount.
 *
 * `FEED_SNAPSHOT_ENABLED` is baked from `import.meta.env` at module load, so the only way to
 * drive both arms in one file is to mock the module that reads the env var. The build flag is
 * not what is under test here; the wiring over it is.
 */
import {clientRoot, createClient} from "@nkzw/fate";
import {act, render, screen} from "@testing-library/react";
import * as React from "react";
import {FateClient, useLiveListView} from "react-fate";
import {describe, expect, it, vi} from "vitest";
import {PANO_FEED_PAGE_SIZE} from "../lib/panoNav";
import {PanoFeedConnectionView, usePanoFeedPosts} from "./PanoFeed";

// Vitest hoists both of these above the imports above, so the page reads the flag through here.
const snapshot = vi.hoisted(() => ({enabled: true}));

vi.mock("../fate/snapshot", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../fate/snapshot")>();
	return {
		...actual,
		get FEED_SNAPSHOT_ENABLED() {
			return snapshot.enabled;
		},
	};
});

type Post = {__typename: "Post"; id: string; title: string};

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

let loadNextPage: (() => Promise<void>) | null = null;

/** `FeedContent` minus its chrome: the page's hook, then the page's live read of the result. */
function Feed() {
	const posts = usePanoFeedPosts({sort: "hot"});
	const [items, loadNext] = useLiveListView(PanoFeedConnectionView, posts);
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

async function openFeed(client: TestClient) {
	let mounted!: ReturnType<typeof render>;
	await act(async () => {
		mounted = render(
			<FateClient client={client}>
				<React.Suspense fallback={<output data-testid="rows">…</output>}>
					<Feed />
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
			snapshot.enabled = snapshotEnabled;
			const {client} = makeClient();

			const feed = await openFeed(client);
			expect(rowCount()).toBe("20");

			await act(async () => {
				await loadNextPage?.();
			});
			expect(rowCount()).toBe("40");

			feed.unmount();
			await settle();

			await openFeed(client);
			expect(rowCount()).toBe("40");
		});
	}

	it("still revalidates the first page when the first page is the whole window", async () => {
		snapshot.enabled = true;
		const {client, fetched} = makeClient();

		const feed = await openFeed(client);
		expect(rowCount()).toBe("20");
		expect(fetched).toHaveLength(1);

		feed.unmount();
		await settle();

		await openFeed(client);
		expect(rowCount()).toBe("20");
		expect(fetched).toHaveLength(2);
	});
});

describe("a snapshot-wide window is refreshed on the first mount of a tab (#9266)", () => {
	it("revalidates a restored window rather than painting it", async () => {
		snapshot.enabled = true;
		const first = makeClient();
		const feed = await openFeed(first.client);
		await act(async () => {
			await loadNextPage?.();
		});
		expect(rowCount()).toBe("40");
		feed.unmount();
		await settle();

		// A new tab boots from what the last one persisted (`fate/snapshot.ts`). The stored window
		// carries no age bound, and a signed-out reader's live subscription is a no-op
		// (`fate/client.ts`), so nothing else would ever correct this paint.
		const next = makeClient();
		next.client.hydrate(first.client.dehydrate(), {merge: "preserve-existing"});

		await openFeed(next.client);
		expect(next.fetched).toHaveLength(1);
		expect(rowCount()).toBe("20");
	});
});

describe("the feed key keeps this file reviewable (#9266)", () => {
	it("carries no raw control character in its source", async () => {
		const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
		// A path string, not a `URL`: jsdom's `URL` is a different class than the one `node:fs`
		// recognises, so a `URL` argument reads here as a non-file scheme.
		const source = await fs.readFile(path.join(import.meta.dirname, "PanoFeed.tsx"), "utf8");
		// Tab, newline and carriage return are the only sub-space bytes a source file may carry.
		// Any other one classifies the file as binary, and the diff then reads "Binary files
		// differ" — the fix lands unreadable, to a human reviewer and to every gate.
		const control = [...source]
			.map((character) => character.codePointAt(0) ?? 0)
			.filter((code) => code < 9 || code === 11 || code === 12 || (code > 13 && code < 32));
		expect(control).toEqual([]);
	});
});
