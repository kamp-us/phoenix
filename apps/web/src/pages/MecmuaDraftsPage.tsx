/**
 * `/mecmua/yazilarim` — the author's OWN posts (#2544): the private retrieval surface
 * the mecmua write path lacked. It reads the `CurrentUser`-scoped `mecmuaMyPosts` fate
 * root (drafts + published, newest-started first) and lists each as a card linking to
 * the editor at that post's id (`/mecmua/yaz/:id`), so a saved taslak is reopenable —
 * closing the #2429 Story 3 "keep multiple drafts" journey the write-only path broke.
 *
 * The whole surface ships dark behind `MECMUA_WRITE` (default-off): the page self-gates
 * (off ⇒ 404), the same seam the editor gates on, and `mecmuaMyPosts` serves empty while
 * the flag is off — so no unreleased authoring surface leaks (ADR 0083). Signed-out reads
 * are empty (the read is author-scoped), rendered as the empty state.
 */
import {NotebookPen} from "lucide-react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {MecmuaPost} from "../../worker/features/fate/views";
import {Icon} from "../components/Icon";
import {Card} from "../components/ui/Card";
import {EmptyState} from "../components/ui/EmptyState";
import {MetaRow} from "../components/ui/MetaRow";
import {Screen} from "../fate/Screen";
import {toIso} from "../fate/wire";
import {MECMUA_WRITE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {formatDateTR} from "../lib/datetime";
import {NotFoundPage} from "./NotFoundPage";
import "./MecmuaDraftsPage.css";

const MecmuaMyPostView = view<MecmuaPost>()({
	id: true,
	title: true,
	publishedAt: true,
});
const MyPostsConnectionView = {items: {node: MecmuaMyPostView}} as const;
const myPostsRequest = {
	mecmuaMyPosts: {list: MyPostsConnectionView, args: {first: 50}},
} as const;

/** The "yeni yazı" entry-point link to a blank editor, styled as the primary CTA button. */
function MecmuaWriteCta() {
	return (
		<Link to="/mecmua/yaz" className="kp-btn kp-btn--primary" data-testid="mecmua-drafts-new">
			yeni yazı
		</Link>
	);
}

export function MecmuaDraftsPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MECMUA_WRITE, false);

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first (the
	// MecmuaEditorPage / MecmuaPostPage self-gate idiom).
	if (flagLoading) {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">
					<p className="kp-mecmua-drafts__status">yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!flagOn) return <NotFoundPage />;

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<header className="kp-mecmua-drafts__head">
					<div className="kp-mecmua-drafts__head-row">
						<h1 className="kp-mecmua-drafts__title">yazılarım</h1>
						<MecmuaWriteCta />
					</div>
					<p className="kp-mecmua-drafts__lede">taslakların ve yayımladığın yazılar.</p>
				</header>
				<Screen
					fallback={<p className="kp-mecmua-drafts__status">yükleniyor…</p>}
					error={({code}) => (
						<p className="kp-mecmua-drafts__status" role="alert">
							yazılar yüklenemedi: {code.toLowerCase()}
						</p>
					)}
				>
					<MecmuaDraftsList />
				</Screen>
			</div>
		</div>
	);
}

function MecmuaDraftsList() {
	const {mecmuaMyPosts} = useRequest(myPostsRequest);
	const [items] = useListView(MyPostsConnectionView, mecmuaMyPosts);

	if (items.length === 0) {
		return (
			<EmptyState
				icon={<Icon icon={NotebookPen} size={24} />}
				title="henüz yazın yok"
				description="yeni bir yazıya başla; taslakların burada birikir."
				action={<MecmuaWriteCta />}
			/>
		);
	}

	return (
		<ul className="kp-mecmua-drafts__list">
			{items.map(({node}) => (
				<MecmuaDraftRow key={String(node.id)} node={node} />
			))}
		</ul>
	);
}

function MecmuaDraftRow({node}: {node: ViewRef<"MecmuaPost">}) {
	const post = useView(MecmuaMyPostView, node);
	const published = post.publishedAt != null;
	const heading = post.title.trim().length > 0 ? post.title : "(başlıksız taslak)";

	return (
		<Card as="li" interactive className="kp-mecmua-drafts__item" data-testid="mecmua-drafts-item">
			<Link to={`/mecmua/yaz/${String(node.id)}`} className="kp-mecmua-drafts__link">
				<span className="kp-mecmua-drafts__item-title">{heading}</span>
				<MetaRow as="div" className="kp-mecmua-drafts__meta">
					{published ? (
						<>
							<span className="kp-mecmua-drafts__badge kp-mecmua-drafts__badge--published">
								yayımlandı
							</span>
							{post.publishedAt ? (
								<time dateTime={toIso(post.publishedAt)}>
									{formatDateTR(toIso(post.publishedAt))}
								</time>
							) : null}
						</>
					) : (
						<span className="kp-mecmua-drafts__badge">taslak</span>
					)}
				</MetaRow>
			</Link>
		</Card>
	);
}
