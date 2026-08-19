/**
 * Optimistic-edit payload builders for `post.edit` / `comment.edit` /
 * `definition.edit`. See `.patterns/fate-mutations-client.md`.
 */

export type Now = () => Date;

const defaultNow: Now = () => new Date();

export interface PostEditOptimistic {
	readonly title: string;
	readonly body: string;
	readonly updatedAt: Date;
}

export interface BodyEditOptimistic {
	readonly body: string;
	readonly updatedAt: Date;
}

export function postEditOptimistic(
	fields: {readonly title: string; readonly body: string},
	now: Now = defaultNow,
): PostEditOptimistic {
	return {title: fields.title, body: fields.body, updatedAt: now()};
}

export function bodyEditOptimistic(body: string, now: Now = defaultNow): BodyEditOptimistic {
	return {body, updatedAt: now()};
}
