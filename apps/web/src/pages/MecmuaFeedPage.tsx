/**
 * `/mecmua/akis` — the subscribed-author feed (#2500, epic #2467): a time-ordered list of
 * published mecmua posts from the authors the reader follows, newest-first by
 * `publishedAt`. Reads the `mecmuaFeed` fate root in one batched `useRequest` and renders
 * each post as a card linking to its reader page (`/mecmua/:slug`) — the same Card /
 * EmptyState / MetaRow shell the public index (#2512) uses, so the two mecmua surfaces read
 * as one family. On-site reading only — there is NO email/bülten path here by design (map
 * #2467/#2466).
 *
 * The whole surface ships dark behind `MECMUA_FEED` (default-off): the page self-gates
 * (off ⇒ 404), mirroring `MecmuaPostPage`, so the route is absent until a human flips the
 * flag at release (ADR 0083). The `mecmuaFeed` root also serves empty while the flag is
 * off, so no unreleased feed content leaks even if the page is reached.
 */
import {Newspaper} from "lucide-react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {MecmuaPost} from "../../worker/features/fate/views";
import {Icon} from "../components/Icon";
import {Card} from "../components/ui/Card";
import {EmptyState} from "../components/ui/EmptyState";
import {MetaRow} from "../components/ui/MetaRow";
import {Screen} from "../fate/Screen";
import {toIso} from "../fate/wire";
import {MECMUA_FEED} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {formatAgoTR} from "../lib/datetime";
import {NotFoundPage} from "./NotFoundPage";
import "./MecmuaFeedPage.css";

const MecmuaFeedPostView = view<MecmuaPost>()({
	id: true,
	slug: true,
	title: true,
	body: true,
	publishedAt: true,
});

/** A connection "view" is a plain `{items: {node: View}}` selection, not a `view<T>()`. */
const FeedConnectionView = {items: {node: MecmuaFeedPostView}} as const;

const FEED_PAGE_SIZE = 20;

const feedRequest = {
	mecmuaFeed: {list: FeedConnectionView, args: {first: FEED_PAGE_SIZE}},
} as const;

export function MecmuaFeedPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MECMUA_FEED, false);

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first (the
	// MecmuaPostPage self-gate idiom).
	if (flagLoading) {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">
					<p className="kp-mecmua-feed__status">yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!flagOn) return <NotFoundPage />;

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<header className="kp-mecmua-feed__head">
					<h1 className="kp-mecmua-feed__title">mecmua</h1>
					<p className="kp-mecmua-feed__lede">takip ettiğin yazarların son yazıları.</p>
				</header>
				<Screen
					fallback={<p className="kp-mecmua-feed__status">yükleniyor…</p>}
					error={({code}) => (
						<p className="kp-mecmua-feed__status" role="alert">
							akış yüklenemedi: {code.toLowerCase()}
						</p>
					)}
				>
					<MecmuaFeedList />
				</Screen>
			</div>
		</div>
	);
}

function MecmuaFeedList() {
	const {mecmuaFeed} = useRequest(feedRequest);
	const [items] = useListView(FeedConnectionView, mecmuaFeed);

	if (items.length === 0) {
		return (
			<EmptyState
				icon={<Icon icon={Newspaper} size={24} />}
				title="henüz akışında yazı yok"
				description="birkaç yazar takip et, yazıları burada belirsin."
			/>
		);
	}

	return (
		<ol className="kp-mecmua-feed">
			{items.map(({node}) => (
				<MecmuaFeedRow key={String(node.id)} node={node} />
			))}
		</ol>
	);
}

function MecmuaFeedRow({node}: {node: ViewRef<"MecmuaPost">}) {
	const post = useView(MecmuaFeedPostView, node);
	// The reader page is keyed by slug or id; a draft-less feed row is always published,
	// so `slug ?? id` always resolves to a readable `/mecmua/:key`.
	const href = `/mecmua/${encodeURIComponent(post.slug ?? String(post.id))}`;
	const excerpt = post.body.length > 240 ? `${post.body.slice(0, 240).trimEnd()}…` : post.body;

	return (
		<Card as="li" interactive className="kp-mecmua-feed__item">
			<Link to={href} className="kp-mecmua-feed__link">
				<h2 className="kp-mecmua-feed__row-title">{post.title}</h2>
				{post.publishedAt ? (
					<MetaRow as="div" className="kp-mecmua-feed__meta">
						<time dateTime={toIso(post.publishedAt)}>
							{formatAgoTR(toIso(post.publishedAt))}
						</time>
					</MetaRow>
				) : null}
				<p className="kp-mecmua-feed__excerpt">{excerpt}</p>
			</Link>
		</Card>
	);
}
