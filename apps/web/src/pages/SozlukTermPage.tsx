import * as React from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '../components/ui/Button';
import './SozlukTermPage.css';

export type TermDefinition = {
	id: string;
	score: number;
	body: React.ReactNode;
	author: string;
	agoLabel: string;
	editsLabel?: string;
};

export type TermPageData = {
	slug: string;
	title: string;
	totalDefinitions: number;
	totalScore: number;
	firstAt: string;
	lastEditAgo: string;
	definitions: TermDefinition[];
	moreCount?: number;
};

export function SozlukTermPage({ terms }: { terms: Record<string, TermPageData> }) {
	const { slug } = useParams<{ slug: string }>();
	const term = slug ? terms[slug] : undefined;

	if (!term) {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">
					<p style={{ font: 'var(--t-body)', color: 'var(--text-muted)' }}>
						"{slug}" terimi henüz yok. <Link to="/sozluk">sözlüğe dön</Link>
					</p>
				</div>
			</div>
		);
	}

	const firstLetter = term.title.charAt(0).toLowerCase();

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<header className="kp-sozluk-term__head">
					<p className="kp-sozluk-term__crumbs">
						<Link to="/sozluk">sözlük</Link> / <Link to="/sozluk">{firstLetter}</Link> /{' '}
						{term.title}
					</p>
					<h1 className="kp-sozluk-term__title">{term.title}</h1>
					<div className="kp-sozluk-term__meta">
						<span>{term.totalDefinitions} tanım</span>
						<span>{term.totalScore} oy</span>
						<span>ilk: {term.firstAt}</span>
						<span>son düzenleme: {term.lastEditAgo}</span>
					</div>
				</header>

				{term.definitions.map((d, i) => (
					<DefinitionCard key={d.id} definition={d} rank={i + 1} top={i === 0} />
				))}

				{term.moreCount ? (
					<p className="kp-sozluk-term__more">
						— {term.moreCount} tanım daha · <Link to="#">hepsini gör</Link> —
					</p>
				) : null}

				<Composer />
			</div>
		</div>
	);
}

function DefinitionCard({
	definition,
	rank,
	top,
}: {
	definition: TermDefinition;
	rank: number;
	top: boolean;
}) {
	const [voted, setVoted] = React.useState(top);
	const cls = top
		? 'kp-sozluk-definition kp-sozluk-definition--top'
		: 'kp-sozluk-definition';

	return (
		<article className={cls}>
			<div className="kp-sozluk-definition__vote">
				<button
					type="button"
					className="kp-sozluk-definition__vote-btn"
					aria-pressed={voted}
					aria-label="Yukarı oy"
					onClick={() => setVoted(!voted)}
				>
					<span className="triangle" />
				</button>
				<span className="kp-sozluk-definition__vote-count">{definition.score}</span>
				<span className="kp-sozluk-definition__rank">#{rank}</span>
			</div>
			<div>
				<div className="kp-sozluk-definition__body">{definition.body}</div>
				<footer className="kp-sozluk-definition__foot">
					<span className="author">@{definition.author}</span>
					<span className="dot">·</span>
					<span>{definition.agoLabel}</span>
					{definition.editsLabel ? (
						<>
							<span className="dot">·</span>
							<span>{definition.editsLabel}</span>
						</>
					) : null}
					<span className="actions">
						<button type="button">paylaş</button>
						<button type="button">kalıcı bağlantı</button>
						<button type="button">bildir</button>
					</span>
				</footer>
			</div>
		</article>
	);
}

function Composer() {
	return (
		<form
			className="kp-sozluk-composer"
			onSubmit={(e) => {
				e.preventDefault();
			}}
		>
			<header className="kp-sozluk-composer__head">
				<span className="kp-sozluk-composer__title">sen nasıl tanımlardın?</span>
			</header>
			<textarea
				className="kp-sozluk-composer__textarea"
				placeholder="markdown destekli. ```js ... ``` kod bloğu için. kişisel deneyim, örnek, hatıra; kuru sözlük tanımı zaten Wikipedia'da var."
			/>
			<footer className="kp-sozluk-composer__foot">
				<span className="kp-sozluk-composer__hint">
					markdown · <kbd>⌘</kbd>+<kbd>↵</kbd> gönder
				</span>
				<span style={{ display: 'flex', gap: 6 }}>
					<Button variant="tertiary" size="sm" type="button">
						iptal
					</Button>
					<Button variant="primary" size="sm" type="submit">
						tanımı ekle
					</Button>
				</span>
			</footer>
		</form>
	);
}
