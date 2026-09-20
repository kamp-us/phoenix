/**
 * #9265 regression, over a REAL `@nkzw/fate` client and its real normalized cache: the
 * profile counters are re-counted server-side per request, nothing fans a `Profile`
 * invalidation, and the cache is persisted to `localStorage` — so the only thing keeping
 * the tiles honest is the request mode. The e2e reaches the profile by `page.goto` in a
 * context with no prior profile read, so it can never hold the warm cache this defect
 * needs; every case here warms the cache first and then reads back.
 *
 * The transport is a stub whose counts change between reads — that stands in for the
 * create/delete the reporter performed between two visits.
 */
import {clientRoot, createClient} from "@nkzw/fate";
import {describe, expect, it} from "vitest";
import {PROFILE_READ_OPTIONS} from "../components/profile/profileReads";
import {readImperativeView} from "../fate/useImperativeView";
import {PROFILE_STATS_MODE, ProfileStatsView} from "./useProfileStats";

const USERNAME = "ayse";
const USER_ID = "user_1";

type Counts = Readonly<{
	commentCount: number;
	definitionCount: number;
	postCount: number;
	totalKarma: number;
}>;

const STALE: Counts = {commentCount: 0, definitionCount: 0, postCount: 0, totalKarma: 0};
const FRESH: Counts = {commentCount: 2, definitionCount: 8, postCount: 1, totalKarma: 11};

function profileClient() {
	let counts: Counts = STALE;
	let queries = 0;
	const client = createClient({
		hydrationScope: "profile-counters-test",
		roots: {profile: clientRoot<unknown, "Profile">("Profile")},
		types: [{type: "Profile"}],
		transport: {
			fetchById: () => {
				throw new Error("transport.fetchById unused in this test");
			},
			fetchQuery: async () => {
				queries += 1;
				return {__typename: "Profile", id: USER_ID, userId: USER_ID, ...counts};
			},
		},
	});
	return {
		client,
		publish: (next: Counts) => {
			counts = next;
		},
		get queries() {
			return queries;
		},
	};
}

type ProfileTestClient = ReturnType<typeof profileClient>["client"];

// The `/profile` read: `useProfileStats` → `useImperativeView` → this function.
const readStats = (client: ProfileTestClient, mode?: typeof PROFILE_STATS_MODE) =>
	readImperativeView(client, "profile", ProfileStatsView, {username: USERNAME}, mode);

describe("profile counters over a warm fate cache (#9265)", () => {
	it("holds the defect: with fate's cache-first default the warm read re-serves the stale counts", async () => {
		const fate = profileClient();
		await readStats(fate.client);
		fate.publish(FRESH);

		const again = await readStats(fate.client);

		expect(again?.definitionCount).toBe(STALE.definitionCount);
		expect(fate.queries).toBe(1);
	});

	it("reads the fresh counts back on the `/profile` imperative read", async () => {
		const fate = profileClient();
		await readStats(fate.client, PROFILE_STATS_MODE);
		fate.publish(FRESH);

		const again = await readStats(fate.client, PROFILE_STATS_MODE);

		expect(again).toMatchObject(FRESH);
		expect(fate.queries).toBe(2);
	});

	it("patches the cache from the network on the `/u/:username` rendered read", async () => {
		const fate = profileClient();
		const request = {profile: {view: ProfileStatsView, args: {username: USERNAME}}};
		await fate.client.request(request, PROFILE_READ_OPTIONS);
		fate.publish(FRESH);

		// stale-while-revalidate answers from the cache and fetches behind it, so the
		// assertion that matters is what the cache holds once that leg settles — which is
		// what the rendered `useView` subscriptions re-render from.
		const ref = (await fate.client.request(request, PROFILE_READ_OPTIONS)).profile;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fate.queries).toBe(2);
		const snapshot = ref ? await fate.client.readView(ProfileStatsView, ref) : null;
		expect(snapshot?.data).toMatchObject(FRESH);
	});
});
