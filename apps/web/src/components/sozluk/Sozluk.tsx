import type * as React from "react";
import {Link} from "react-router";
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
	return (
		<Link to={`/sozluk/${term.slug}`} className="kp-sozluk-term-row">
			<div>
				<div className="kp-sozluk-term-row__title">{term.title}</div>
				{term.excerpt ? <div className="kp-sozluk-term-row__excerpt">{term.excerpt}</div> : null}
			</div>
			<span className="kp-sozluk-term-row__count">{term.count} tanım</span>
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
	return (
		<ol className="kp-sozluk-popular">
			{terms.map((t, i) => (
				<li key={t.slug} className="kp-sozluk-popular__row">
					<span className="kp-sozluk-popular__rank">{String(i + 1).padStart(2, "0")}</span>
					<Link className="kp-sozluk-popular__title" to={`/sozluk/${t.slug}`}>
						{t.title}
					</Link>
					<span className="kp-sozluk-popular__meta">{t.totalScore} ↑</span>
				</li>
			))}
		</ol>
	);
}

export type DefinitionData = {
	id: string;
	body: React.ReactNode;
	author: string;
	// Live identity (#2139): the current `{username, displayName}` so the label resolves
	// via `actorLabel` and the profile link targets the handle; both optional so an
	// unstamped caller falls back to the `author` snapshot.
	authorUsername?: string | null;
	authorDisplayName?: string | null;
	agoLabel: string;
	score: number;
};

export function SozlukDefinition({d}: {d: DefinitionData}) {
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
				<span>{d.score} puan</span>
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

/**
 * The A-Z index as real navigable links to `/sozluk?harf=<letter>` (issue #693):
 * each letter is a shareable URL, back-button-correct and middle-clickable. The
 * active letter links back to bare `/sozluk` so it still toggles its filter off.
 * Empty letters stay inert `<span>`s — no destination to navigate to.
 */
export function SozlukAlphabet({
	value,
	emptyLetters = [],
}: {
	value?: string;
	emptyLetters?: string[];
}) {
	return (
		<nav className="kp-sozluk-alphabet" aria-label="Harf">
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
				if (isEmpty) {
					return (
						<span key={l} className={cls}>
							{l}
						</span>
					);
				}
				return (
					<Link
						key={l}
						to={sozlukLetterHref(l, isActive)}
						className={cls}
						aria-current={isActive ? "page" : undefined}
					>
						{l}
					</Link>
				);
			})}
		</nav>
	);
}
