import type * as React from "react";
import {Link} from "react-router";
import {useT, useTPlural} from "../../i18n";
import {sozlukLetterHref} from "../../lib/sozlukLetterHref";
import {actorLabel} from "../moderation/actor-identity";
import "./Sozluk.css";

export type TermRow = {
	slug: string;
	title: string;
	count: number;
	excerpt?: string;
};

export function SozlukTermRow({term}: {term: TermRow}) {
	const tp = useTPlural();
	return (
		<Link to={`/sozluk/${term.slug}`} className="kp-sozluk-term-row">
			<div>
				<div className="kp-sozluk-term-row__title">{term.title}</div>
				{term.excerpt ? <div className="kp-sozluk-term-row__excerpt">{term.excerpt}</div> : null}
			</div>
			<span className="kp-sozluk-term-row__count">
				{tp(term.count, {one: "sozluk.entryCount.one", other: "sozluk.entryCount.other"})}
			</span>
		</Link>
	);
}

export function SozlukTermList({terms}: {terms: TermRow[]}) {
	return (
		<div className="kp-sozluk-list">
			{terms.map((t) => (
				<SozlukTermRow key={t.slug} term={t} />
			))}
		</div>
	);
}

export type PopularTerm = {
	slug: string;
	title: string;
	totalScore: number;
};

export function SozlukPopular({terms}: {terms: PopularTerm[]}) {
	const tp = useTPlural();
	return (
		<ol className="kp-sozluk-popular">
			{terms.map((t, i) => (
				<li key={t.slug} className="kp-sozluk-popular__row">
					<span className="kp-sozluk-popular__rank">{String(i + 1).padStart(2, "0")}</span>
					<Link className="kp-sozluk-popular__title" to={`/sozluk/${t.slug}`}>
						{t.title}
					</Link>
					<span className="kp-sozluk-popular__meta">
						{tp(t.totalScore, {one: "sozluk.voteCount.one", other: "sozluk.voteCount.other"})}
					</span>
				</li>
			))}
		</ol>
	);
}

export type DefinitionData = {
	id: string;
	body: React.ReactNode;
	author: string;
	authorUsername?: string | null;
	authorDisplayName?: string | null;
	agoLabel: string;
	score: number;
};

export function SozlukDefinition({d}: {d: DefinitionData}) {
	const tp = useTPlural();
	const handle = d.authorUsername ?? d.author;
	return (
		<article className="kp-definition" id={d.id}>
			<div className="kp-definition__body kp-prose">{d.body}</div>
			<div className="kp-definition__meta">
				<Link to={`/u/${handle}`}>
					{actorLabel(d.authorDisplayName ?? null, d.authorUsername ?? null, d.author)}
				</Link>
				<span>·</span>
				<span>{d.agoLabel}</span>
				<span>·</span>
				<span>{tp(d.score, {one: "sozluk.voteCount.one", other: "sozluk.voteCount.other"})}</span>
			</div>
		</article>
	);
}

export function SozlukDefinitionList({defs}: {defs: DefinitionData[]}) {
	return (
		<div className="kp-sozluk-list">
			{defs.map((d) => (
				<SozlukDefinition key={d.id} d={d} />
			))}
		</div>
	);
}

const ALPHABET = [
	"a",
	"b",
	"c",
	"ç",
	"d",
	"e",
	"f",
	"g",
	"ğ",
	"h",
	"ı",
	"i",
	"j",
	"k",
	"l",
	"m",
	"n",
	"o",
	"ö",
	"p",
	"r",
	"s",
	"ş",
	"t",
	"u",
	"ü",
	"v",
	"y",
	"z",
];

// A letter's accessible name spells it out ("A harfi") — a bare "a" reads
// ambiguously to a screen reader that spells single chars.
export function SozlukAlphabet({
	value,
	emptyLetters = [],
}: {
	value?: string;
	emptyLetters?: string[];
}) {
	const t = useT();
	return (
		<nav className="kp-sozluk-alphabet" aria-label={t("sozluk.alphabet.label")}>
			{ALPHABET.map((l) => {
				const isEmpty = emptyLetters.includes(l);
				const isActive = value === l;
				const cls = [
					"kp-sozluk-alphabet__letter",
					isActive ? "is-active" : "",
					isEmpty ? "is-empty" : "",
				]
					.filter(Boolean)
					.join(" ");
				// Turkish dotted-capital: `i` uppercases to `İ`, never the ASCII `I` (#2169).
				const letter = l.toLocaleUpperCase("tr");
				const letterName = t("sozluk.alphabet.letterName", {letter});
				if (isEmpty) {
					// A plain span so it isn't announced as a link. aria-label/aria-disabled aren't
					// valid on a generic span, so the visually-hidden suffix carries the "no terms"
					// distinction the muted color conveys visually.
					return (
						<span key={l} className={cls}>
							{l}
							<span className="kp-visually-hidden">
								{t("sozluk.alphabet.letterEmpty", {letter})}
							</span>
						</span>
					);
				}
				return (
					<Link
						key={l}
						to={sozlukLetterHref(l, isActive)}
						className={cls}
						aria-label={letterName}
						aria-current={isActive ? "page" : undefined}
					>
						{l}
					</Link>
				);
			})}
		</nav>
	);
}
