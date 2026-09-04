/**
 * `/mecmua/yazilarim` — the author's own drafts + published posts, off the `CurrentUser`-scoped
 * `mecmuaMyPosts` root. Ships dark behind `MECMUA_WRITE` (default-off;
 * `.patterns/flag-dark-page-gate.md`); that root serves empty while the flag is off, so a
 * signed-out or gated read just renders empty.
 */
import {NotebookPen} from "lucide-react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {MecmuaPost} from "../../worker/features/fate/views";
import {Icon} from "../components/Icon";
import {Alert} from "../components/ui/Alert";
import {Badge} from "../components/ui/Badge";
import {Card} from "../components/ui/Card";
import {EmptyState} from "../components/ui/EmptyState";
import {MetaRow} from "../components/ui/MetaRow";
import {Screen} from "../fate/Screen";
import {toIso} from "../fate/wire";
import {MECMUA_WRITE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {useT} from "../i18n";
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

export function MecmuaDraftsPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MECMUA_WRITE, false);
	const t = useT();
	// No in-page write CTA on purpose: mecmua's single one lives in the Subnav (#2603).

	if (flagLoading) {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">
					<p className="kp-mecmua-drafts__status">{t("mecmua.loading")}</p>
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
						<h1 className="kp-mecmua-drafts__title">{t("mecmua.drafts.title")}</h1>
					</div>
					<p className="kp-mecmua-drafts__lede">{t("mecmua.drafts.lede")}</p>
				</header>
				<Screen
					fallback={<p className="kp-mecmua-drafts__status">{t("mecmua.loading")}</p>}
					error={({code}) => (
						<Alert variant="danger" className="kp-alert--inline kp-mecmua-drafts__status">
							{t("mecmua.drafts.error", {code: code.toLowerCase()})}
						</Alert>
					)}
				>
					<MecmuaDraftsList />
				</Screen>
			</div>
		</div>
	);
}

function MecmuaDraftsList() {
	const t = useT();
	const {mecmuaMyPosts} = useRequest(myPostsRequest);
	const [items] = useListView(MyPostsConnectionView, mecmuaMyPosts);

	if (items.length === 0) {
		return (
			<EmptyState
				icon={<Icon icon={NotebookPen} size={24} />}
				title={t("mecmua.drafts.empty.title")}
				description={t("mecmua.drafts.empty.description")}
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
	const t = useT();
	const post = useView(MecmuaMyPostView, node);
	const published = post.publishedAt != null;
	const heading = post.title.trim().length > 0 ? post.title : t("mecmua.drafts.untitled");

	return (
		<Card as="li" interactive className="kp-mecmua-drafts__item" data-testid="mecmua-drafts-item">
			<Link to={`/mecmua/yaz/${String(node.id)}`} className="kp-mecmua-drafts__link">
				<span className="kp-mecmua-drafts__item-title">{heading}</span>
				<MetaRow as="div" className="kp-mecmua-drafts__meta">
					{published ? (
						<>
							<Badge
								variant="success"
								className="kp-mecmua-drafts__badge kp-mecmua-drafts__badge--published"
							>
								{t("mecmua.drafts.published")}
							</Badge>
							{post.publishedAt ? (
								<time dateTime={toIso(post.publishedAt)}>
									{formatDateTR(toIso(post.publishedAt))}
								</time>
							) : null}
						</>
					) : (
						<Badge variant="secondary" className="kp-mecmua-drafts__badge">
							{t("mecmua.drafts.draft")}
						</Badge>
					)}
				</MetaRow>
			</Link>
		</Card>
	);
}
