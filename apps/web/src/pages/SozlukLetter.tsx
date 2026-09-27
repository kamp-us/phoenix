/**
 * One Turkish alphabet letter's whole index (#9267). Unlike the home's two curated columns,
 * this reads the corpus: the `terms` root takes the letter server-side and pages it with the
 * same keyset connection every other list uses, so a term is reachable by browsing whether or
 * not it was recently added or upvoted.
 */
import {EmptyState} from "@kampus/design";
import type * as React from "react";
import {useListView, useRequest} from "react-fate";
import {Link, Navigate, useParams} from "react-router";
import {Breadcrumbs} from "../components/layout/Breadcrumbs";
import {TermRow, TermRowView} from "../components/sozluk/TermRow";
import {LoadMoreButton} from "../fate/LoadMoreButton";
import {Screen} from "../fate/Screen";
import {useT, useTPlural} from "../i18n";
import {sozlukLetterParam} from "../lib/sozlukLetterParam";
import "./SozlukLetter.css";

/** A connection "view" is a plain `{items: {node: View}}` selection, not a `view<T>()`. */
const TermConnectionView = {items: {node: TermRowView}} as const;

/**
 * Wide enough that most letters read as one page, small enough that a second page is one
 * click rather than a scroll of dead space. Keyset paging, so this is a page width and never
 * an offset.
 */
export const SOZLUK_LETTER_PAGE_SIZE = 10;

const letterRequest = (letter: string) =>
	({
		terms: {
			list: TermConnectionView,
			args: {sort: "alphabetical", letter, first: SOZLUK_LETTER_PAGE_SIZE},
		},
	}) as const;

/** Turkish dotted-capital: `i` uppercases to `İ`, never the ASCII `I` (#2169). */
const display = (letter: string): string => letter.toLocaleUpperCase("tr");

export function SozlukLetter() {
	const {letter: raw} = useParams<{letter: string}>();
	const letter = sozlukLetterParam(raw);
	// A route value naming no letter has no page to render — the strip only ever links to the
	// letters the index holds, so this catches a hand-typed or stale URL rather than inventing
	// an empty letter.
	if (!letter) return <Navigate to="/sozluk" replace />;

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<LetterChrome letter={letter}>
					{/* `Screen` CALLS `error`, so the arm has to return an element: a bare function
					    component here would run its hooks outside a component body. */}
					<Screen
						fallback={<LetterStatus messageKey="sozluk.letter.loading" />}
						error={({code}) => <LetterError code={code} />}
					>
						<LetterList letter={letter} />
					</Screen>
				</LetterChrome>
			</div>
		</div>
	);
}

function LetterStatus({messageKey}: {messageKey: "sozluk.letter.loading"}) {
	const t = useT();
	return <p className="kp-sozluk-letter__status">{t(messageKey)}</p>;
}

function LetterError({code}: {code: string}) {
	const t = useT();
	return (
		<p className="kp-sozluk-letter__error">
			{t("sozluk.letter.loadFailed", {code: code.toLowerCase()})}
		</p>
	);
}

function LetterChrome({letter, children}: {letter: string; children: React.ReactNode}) {
	const t = useT();
	return (
		<>
			<header className="kp-sozluk-letter__masthead">
				<Breadcrumbs
					className="kp-sozluk-letter__crumb"
					trail={[{key: "root", label: <Link to="/sozluk">{t("sozluk.letter.crumbRoot")}</Link>}]}
				/>
				<h1 className="kp-sozluk-letter__title">
					{t("sozluk.letter.title", {letter: display(letter)})}
				</h1>
			</header>
			{children}
		</>
	);
}

function LetterList({letter}: {letter: string}) {
	const t = useT();
	const tp = useTPlural();
	const {terms} = useRequest(letterRequest(letter));
	const [items, loadNext] = useListView(TermConnectionView, terms);

	if (items.length === 0) {
		return (
			<EmptyState
				title={t("sozluk.letter.empty", {letter: display(letter)})}
				description={t("sozluk.letter.emptyHint")}
			/>
		);
	}

	return (
		<>
			{/* `loadNext` is the page's only evidence about the rest of the letter: while it is
			    there the letter holds more terms than these, so the count is scoped to what was
			    loaded. Gone, and the loaded rows are the letter's whole set — then the plain
			    count is the letter's own. */}
			<p className="kp-sozluk-letter__count">
				{tp(
					items.length,
					loadNext
						? {
								one: "sozluk.letter.termCountLoaded.one",
								other: "sozluk.letter.termCountLoaded.other",
							}
						: {
								one: "sozluk.letter.termCount.one",
								other: "sozluk.letter.termCount.other",
							},
				)}
			</p>
			<div className="kp-sozluk-list">
				{items.map(({node}) => (
					<TermRow key={node.id} term={node} variant="recent" />
				))}
			</div>
			{loadNext ? (
				<div className="kp-sozluk-letter__more">
					<LoadMoreButton
						loadNext={loadNext}
						ariaLabel={t("sozluk.letter.loadMore", {letter: display(letter)})}
						testId="sozluk-letter-load-more"
					/>
				</div>
			) : null}
		</>
	);
}
