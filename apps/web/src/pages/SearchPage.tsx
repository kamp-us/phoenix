/**
 * Search-results page — see ADR 0080. Two per-type roots, no unified result type; the
 * backend ranks and owns the keyset. A query under the backend's minimum renders the
 * prompt outside `<Screen>`, so it issues no request at all.
 */

import {Alert} from "@kampus/design";
import {useListView, useRequest} from "react-fate";
import {useSearchParams} from "react-router";
import {PanoPostCard, PanoPostCardView} from "../components/pano/PanoPostCard";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import {useT, useTPlural} from "../i18n";
import "./SearchPage.css";

const MIN_QUERY_LENGTH = 2;
const PAGE_SIZE = 10;

/** Connection "views" are plain `{items: {node: View}}` selections, not `view<T>()`. */
const TermConnectionView = {items: {node: TermRowView}} as const;
const PostConnectionView = {items: {node: PanoPostCardView}} as const;

export function SearchPage() {
	const [params] = useSearchParams();
	const t = useT();
	const query = (params.get("q") ?? "").trim();

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<header className="kp-search__masthead">
					<h1 className="kp-search__title">
						{t("search.title")}
						{query ? <small>"{query}"</small> : null}
					</h1>
				</header>

				{query.length < MIN_QUERY_LENGTH ? (
					<SearchPrompt />
				) : (
					<Screen
						fallback={<p className="kp-search__rail">{t("search.searching")}</p>}
						error={({code}) => (
							<Alert
								variant="danger"
								className="kp-alert--inline kp-search__rail kp-search__rail--error"
							>
								{t("search.failed", {code: code.toLowerCase()})}
							</Alert>
						)}
					>
						<SearchResults query={query} />
					</Screen>
				)}
			</div>
		</div>
	);
}

function SearchPrompt() {
	const t = useT();
	return <p className="kp-search__rail">{t("search.minLength", {min: MIN_QUERY_LENGTH})}</p>;
}

const searchRequest = (query: string) =>
	({
		searchTerms: {list: TermConnectionView, args: {query, first: PAGE_SIZE}},
		searchPosts: {list: PostConnectionView, args: {query, first: PAGE_SIZE}},
	}) as const;

function SearchResults({query}: {query: string}) {
	const t = useT();
	const tp = useTPlural();
	const {searchTerms, searchPosts} = useRequest(searchRequest(query));
	const [termItems, loadMoreTerms] = useListView(TermConnectionView, searchTerms);
	const [postItems, loadMorePosts] = useListView(PostConnectionView, searchPosts);

	// Both roots returning zero rows is the legible zero-match state — one message, not two empty
	// sections, so a no-result query reads as "no results" rather than blank.
	if (termItems.length === 0 && postItems.length === 0) {
		return <p className="kp-search__rail kp-search__empty">{t("search.noResults", {query})}</p>;
	}

	return (
		<div className="kp-search__results">
			<section className="kp-search__section">
				<header className="kp-search__section-head">
					<span className="title">{t("search.sozluk")}</span>
					<span>
						{tp(termItems.length, {one: "search.termCount.one", other: "search.termCount.other"})}
					</span>
				</header>
				{termItems.length === 0 ? (
					<p className="kp-search__section-empty">{t("search.noTerms")}</p>
				) : (
					<div className="kp-sozluk-list">
						{termItems.map(({node}) => (
							<TermRow key={node.id} term={node} />
						))}
					</div>
				)}
				{loadMoreTerms ? (
					<div className="kp-search__more">
						<LoadMoreButton loadNext={loadMoreTerms} />
					</div>
				) : null}
			</section>

			<section className="kp-search__section">
				<header className="kp-search__section-head">
					<span className="title">{t("search.pano")}</span>
					<span>
						{tp(postItems.length, {one: "search.postCount.one", other: "search.postCount.other"})}
					</span>
				</header>
				{postItems.length === 0 ? (
					<p className="kp-search__section-empty">{t("search.noPosts")}</p>
				) : (
					<div className="kp-pano-list">
						{postItems.map(({node}, i) => (
							<PanoPostCard key={node.id} post={node} rank={i + 1} />
						))}
					</div>
				)}
				{loadMorePosts ? (
					<div className="kp-search__more">
						<LoadMoreButton loadNext={loadMorePosts} />
					</div>
				) : null}
			</section>
		</div>
	);
}
