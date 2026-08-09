import data from "../comments-data.json";

// Renders reader-submitted comments; data arrives from the public comment endpoint.
export function Comments() {
	return (
		<section className="comments">
			{data.comments.map((c) => (
				<article className="comment" key={c.text}>
					<p className="comment-text">{c.text}</p>
				</article>
			))}
		</section>
	);
}
