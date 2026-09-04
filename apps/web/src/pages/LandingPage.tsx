/** Landing page (`/`) — one batched `useRequest` under one `Screen`; see ADR 0021, ADR 0022. */
import {ArrowRight} from "lucide-react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {LandingStats, Post, Term} from "../../worker/features/fate/views";
import {useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {Icon} from "../components/Icon";
import {Screen} from "../fate/Screen";
import {toIso} from "../fate/wire";
import {type CatalogKey, plural, useLocale, useT} from "../i18n";
import {formatAgoTR} from "../lib/datetime";
import {landingCtaPhase, showJoinCta} from "./landingGating";
import "./LandingPage.css";

const LANDING_LIST_SIZE = 5;

const LandingStatsView = view<LandingStats>()({
	id: true,
	totalDefinitions: true,
	totalPosts: true,
	totalComments: true,
	totalAuthors: true,
	version: true,
});

const LandingPostView = view<Post>()({
	id: true,
	slug: true,
	title: true,
	url: true,
	host: true,
	score: true,
	author: true,
	createdAt: true,
	commentCount: true,
});

const LandingTermView = view<Term>()({
	id: true,
	slug: true,
	title: true,
	definitionCount: true,
	excerpt: true,
	lastActivityAt: true,
});

/** A connection "view" is a plain `{items: {node: View}}` selection, not a `view<T>()`. */
const PostConnectionView = {items: {node: LandingPostView}} as const;
const TermConnectionView = {items: {node: LandingTermView}} as const;

const landingRequest = {
	landingStats: {view: LandingStatsView},
	landingPosts: {list: PostConnectionView, args: {first: LANDING_LIST_SIZE}},
	landingTerms: {list: TermConnectionView, args: {first: LANDING_LIST_SIZE}},
} as const;

function formatStat(n: number): string {
	if (n < 1000) return String(n);
	return n.toLocaleString("tr-TR");
}

export function LandingPage() {
	// Gating rules (and why the phase is three-valued) live in `landingGating`.
	const t = useT();
	const session = useSession();
	const {status} = useMe();
	const phase = landingCtaPhase(session.isPending, status);
	const joinVisible = showJoinCta(phase);

	return (
		<div className="kp-landing">
			<div className="kp-landing__hero">
				<div>
					<h1 className="kp-landing__brand">
						kamp<span className="dot">.</span>us
					</h1>
					<p className="kp-landing__tagline">{t("auth.landing.tagline")}</p>
					<p className="kp-landing__manifesto">
						<strong>
							{t("auth.landing.manifesto.panoLead", {panoNoun: t("auth.brand.pano")})}
						</strong>{" "}
						{t("auth.landing.manifesto.panoBody")}{" "}
						<strong>
							{t("auth.landing.manifesto.sozlukLead", {sozlukNoun: t("auth.brand.sozluk")})}
						</strong>{" "}
						{t("auth.landing.manifesto.sozlukBody")} {t("auth.landing.manifesto.tail")}
					</p>
					{joinVisible ? (
						<p className="kp-landing__rite">
							<strong>{t("auth.landing.rite.doorLead")}</strong> {t("auth.landing.rite.doorBody")}{" "}
							<strong>{t("auth.landing.rite.earnedLead")}</strong>{" "}
							{t("auth.landing.rite.earnedBody", {divanNoun: t("auth.brand.divan")})}
						</p>
					) : null}
				</div>
				<div className="kp-landing__cta">
					{joinVisible ? (
						<Link className="kp-landing__join" to="/auth" data-testid="landing-join-cta">
							<span className="label">
								{t("auth.landing.join.label")}{" "}
								<Icon icon={ArrowRight} size={16} className="kp-inline-arrow" />
							</span>
							<span className="sub">{t("auth.landing.join.sub")}</span>
						</Link>
					) : null}
					<div className="kp-landing__browse">
						<Link to="/pano">
							<span className="label">
								{t("auth.brand.pano")}{" "}
								<Icon icon={ArrowRight} size={16} className="kp-inline-arrow" />
							</span>
							<span className="sub">{t("auth.landing.browse.panoSub")}</span>
						</Link>
						<Link to="/sozluk">
							<span className="label">
								{t("auth.brand.sozluk")}{" "}
								<Icon icon={ArrowRight} size={16} className="kp-inline-arrow" />
							</span>
							<span className="sub">{t("auth.landing.browse.sozlukSub")}</span>
						</Link>
					</div>
				</div>
			</div>

			<Screen fallback={<LandingBodyFallback />} error={() => <LandingBodyError />}>
				<LandingBody />
			</Screen>
		</div>
	);
}

type StatId = "definitions" | "posts" | "authors" | "comments" | "version";

// The tile order, shared by the loaded grid and both skeletons. `id` is the test handle and stays
// English while `label` translates — a test id derived from copy would change with the locale.
const STAT_TILES: ReadonlyArray<{readonly id: StatId; readonly label: CatalogKey}> = [
	{id: "definitions", label: "auth.landing.stats.definitions"},
	{id: "posts", label: "auth.landing.stats.posts"},
	{id: "authors", label: "auth.landing.stats.authors"},
	{id: "comments", label: "auth.landing.stats.comments"},
	{id: "version", label: "auth.landing.stats.version"},
];

/**
 * The noun beside a count, in the reader's locale. Turkish has one form for both arms and English
 * two, so the catalog carries a `…One`/`…Other` pair per noun and `plural` picks (ADR 0347).
 */
function useCountNoun(): (count: number, one: CatalogKey, other: CatalogKey) => string {
	const t = useT();
	const {locale} = useLocale();
	return (count, one, other) => plural(locale, count, {one: t(one), other: t(other)});
}

function LandingBody() {
	const t = useT();
	const {landingStats, landingPosts, landingTerms} = useRequest(landingRequest);
	const stats = useView(LandingStatsView, landingStats);
	const [postItems] = useListView(PostConnectionView, landingPosts);
	const [termItems] = useListView(TermConnectionView, landingTerms);
	const statValues: Readonly<Record<StatId, string>> = {
		definitions: formatStat(stats.totalDefinitions),
		posts: formatStat(stats.totalPosts),
		authors: formatStat(stats.totalAuthors),
		comments: formatStat(stats.totalComments),
		version: String(stats.version),
	};

	return (
		<>
			<div className="kp-landing__cols">
				<section className="kp-landing__col">
					<header className="kp-landing__col-head">
						<h3>{t("auth.landing.col.pano", {panoNoun: t("auth.brand.pano")})}</h3>
						<Link to="/pano">
							{t("auth.landing.seeAll")}{" "}
							<Icon icon={ArrowRight} size={16} className="kp-inline-arrow" />
						</Link>
					</header>
					<ul>
						{postItems.length === 0 ? (
							<li className="kp-landing-row">
								<span className="kp-landing-row__rank">·</span>
								<div>
									<span className="kp-landing-row__meta">{t("auth.landing.empty.posts")}</span>
								</div>
							</li>
						) : (
							postItems.map(({node}, i) => (
								<LandingPostRow key={String(node.id)} node={node} rank={i + 1} />
							))
						)}
					</ul>
				</section>

				<section className="kp-landing__col">
					<header className="kp-landing__col-head">
						<h3>{t("auth.landing.col.sozluk", {sozlukNoun: t("auth.brand.sozluk")})}</h3>
						<Link to="/sozluk">
							{t("auth.landing.seeAll")}{" "}
							<Icon icon={ArrowRight} size={16} className="kp-inline-arrow" />
						</Link>
					</header>
					<ul>
						{termItems.length === 0 ? (
							<li className="kp-landing-row">
								<span className="kp-landing-row__rank">·</span>
								<div>
									<span className="kp-landing-row__meta">{t("auth.landing.empty.terms")}</span>
								</div>
							</li>
						) : (
							termItems.map(({node}) => <LandingTermRow key={String(node.id)} node={node} />)
						)}
					</ul>
				</section>
			</div>

			<div className="kp-landing__stats" data-testid="kp-landing-stats">
				{STAT_TILES.map((tile) => (
					<div key={tile.id} className="kp-landing__stat" data-testid={`stat-${tile.id}`}>
						<div className="n">{statValues[tile.id]}</div>
						<div className="l">{t(tile.label)}</div>
					</div>
				))}
			</div>
		</>
	);
}

function LandingPostRow({node, rank}: {node: ViewRef<"Post">; rank: number}) {
	const p = useView(LandingPostView, node);
	const countNoun = useCountNoun();
	return (
		<li className="kp-landing-row">
			<span className="kp-landing-row__rank">{String(rank).padStart(2, "0")}</span>
			<div>
				<Link className="kp-landing-row__title" to={`/pano/${p.slug ?? p.id}`}>
					{p.title}
				</Link>
				{p.url ? (
					<a
						className="kp-landing-row__site"
						href={p.url}
						target="_blank"
						rel="noreferrer noopener"
					>
						{p.host ?? p.url} ↗
					</a>
				) : null}
				<div className="kp-landing-row__meta">
					<span>
						{p.score} {countNoun(p.score, "auth.landing.row.voteOne", "auth.landing.row.voteOther")}
					</span>
					<span className="dot">·</span>
					<span className="author">@{p.author}</span>
					<span className="dot">·</span>
					<span>{formatAgoTR(toIso(p.createdAt))}</span>
					<span className="dot">·</span>
					<span>
						{p.commentCount}{" "}
						{countNoun(
							p.commentCount,
							"auth.landing.row.commentOne",
							"auth.landing.row.commentOther",
						)}
					</span>
				</div>
			</div>
		</li>
	);
}

function LandingTermRow({node}: {node: ViewRef<"Term">}) {
	const term = useView(LandingTermView, node);
	const countNoun = useCountNoun();
	return (
		<li className="kp-landing-row">
			<span className="kp-landing-row__rank">·</span>
			<div>
				<Link className="kp-landing-row__title" to={`/sozluk/${term.slug}`}>
					{term.title}
					{term.excerpt ? <span className="gloss"> — {term.excerpt}</span> : null}
				</Link>
				<div className="kp-landing-row__meta">
					{term.lastActivityAt ? (
						<>
							<span>{formatAgoTR(toIso(term.lastActivityAt))}</span>
							<span className="dot">·</span>
						</>
					) : null}
					<span>
						{term.definitionCount}{" "}
						{countNoun(
							term.definitionCount,
							"auth.landing.row.definitionOne",
							"auth.landing.row.definitionOther",
						)}
					</span>
				</div>
			</div>
		</li>
	);
}

function LandingColsSkeleton({status}: {status: "loading" | "error"}) {
	const t = useT();
	const label = status === "loading" ? t("auth.landing.loading") : t("auth.landing.error");
	return (
		<div className="kp-landing__cols">
			<section className="kp-landing__col">
				<header className="kp-landing__col-head">
					<h3>{t("auth.landing.col.pano", {panoNoun: t("auth.brand.pano")})}</h3>
					<Link to="/pano">
						{t("auth.landing.seeAll")}{" "}
						<Icon icon={ArrowRight} size={16} className="kp-inline-arrow" />
					</Link>
				</header>
				<ul>
					<li className="kp-landing-row">
						<span className="kp-landing-row__rank">·</span>
						<div>
							<span className="kp-landing-row__meta">{label}</span>
						</div>
					</li>
				</ul>
			</section>
			<section className="kp-landing__col">
				<header className="kp-landing__col-head">
					<h3>{t("auth.landing.col.sozluk", {sozlukNoun: t("auth.brand.sozluk")})}</h3>
					<Link to="/sozluk">
						{t("auth.landing.seeAll")}{" "}
						<Icon icon={ArrowRight} size={16} className="kp-inline-arrow" />
					</Link>
				</header>
				<ul>
					<li className="kp-landing-row">
						<span className="kp-landing-row__rank">·</span>
						<div>
							<span className="kp-landing-row__meta">{label}</span>
						</div>
					</li>
				</ul>
			</section>
		</div>
	);
}

function LandingBodyFallback() {
	const t = useT();
	return (
		<>
			<LandingColsSkeleton status="loading" />
			<div className="kp-landing__stats" data-testid="kp-landing-stats-loading">
				{STAT_TILES.map((tile) => (
					<div key={tile.id} className="kp-landing__stat">
						<div className="n">…</div>
						<div className="l">{t(tile.label)}</div>
					</div>
				))}
			</div>
		</>
	);
}

function LandingBodyError() {
	const t = useT();
	return (
		<>
			<LandingColsSkeleton status="error" />
			<div className="kp-landing__stats" data-testid="kp-landing-stats-error">
				<div className="kp-landing__stat">
					<div className="n">—</div>
					<div className="l">{t("auth.landing.stats.error")}</div>
				</div>
			</div>
		</>
	);
}
