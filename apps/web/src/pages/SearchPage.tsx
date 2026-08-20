/**
 * Search-results page — see ADR 0080. Two per-type roots, no unified result type; the
 * backend ranks and owns the keyset. A query under the backend's minimum renders the
 * prompt outside `<Screen>`, so it issues no request at all.
 */
import {useListView, useRequest} from "react-fate";
import {useSearchParams} from "react-router";
import {PanoPostCard, PanoPostCardView} from "../components/pano/PanoPostCard";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {Alert} from "../components/ui/Alert";
import {Screen} from "../fate/Screen";
import {LoadMoreButton} from "../fate/wire";
import "./SearchPage.css";

const MIN_QUERY_LENGTH = 2;
const PAGE_SIZE = 10;

/** Connection "views" are plain `{items: {node: View}}` selections, not `view<T>()`. */
const TermConnectionView = {items: {node: TermRowView}} as const;
const PostConnectionView = {items: {node: PanoPostCardView}} as const;

export function SearchPage() {
	const [params] = useSearchParams();
	const query = (params.get("q") ?? "").trim();

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<header className="kp-search__masthead">
					<h1 className="kp-search__title">arama{query ? <small>"{query}"</small> : null}</h1>
				</header>

				{query.length < MIN_QUERY_LENGTH ? (
					<SearchPrompt />
				) : (
					<Screen
						fallback={<p className="kp-search__rail">aranıyor…</p>}
						error={({code}) => (
							<Alert
								variant="danger"
								className="kp-alert--inline kp-search__rail kp-search__rail--error"
							>
								arama yapılamadı: {code.toLowerCase()}
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
	return <p className="kp-search__rail">aramak için en az {MIN_QUERY_LENGTH} harf girin.</p>;
}

const searchRequest = (query: string) =>
	({
		searchTerms: {list: TermConnectionView, args: {query, first: PAGE_SIZE}},
		searchPosts: {list: PostConnectionView, args: {query, first: PAGE_SIZE}},
	}) as const;

function SearchResults({query}: {query: string}) {
	const {searchTerms, searchPosts} = useRequest(searchRequest(query));
	const [termItems, loadMoreTerms] = useListView(TermConnectionView, searchTerms);
	const [postItems, loadMorePosts] = useListView(PostConnectionView, searchPosts);

	// Both roots returning zero rows is the legible zero-match state — one message,
	// not two empty sections, so a no-result query reads as "sonuç yok" not blank.
	if (termItems.length === 0 && postItems.length === 0) {
		return <p className="kp-search__rail kp-search__empty">"{query}" için sonuç yok.</p>;
	}

	return (
		<div className="kp-search__results">
			<section className="kp-search__section">
				<header className="kp-search__section-head">
					<span className="title">sözlük</span>
					<span>{termItems.length} terim</span>
				</header>
				{termItems.length === 0 ? (
					<p className="kp-search__section-empty">terim bulunamadı.</p>
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
					<span className="title">pano</span>
					<span>{postItems.length} gönderi</span>
				</header>
				{postItems.length === 0 ? (
					<p className="kp-search__section-empty">gönderi bulunamadı.</p>
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
