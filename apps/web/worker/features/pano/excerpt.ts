/**
 * The tweet-sized body excerpt both planes derive — a post's `bodyExcerpt` and a
 * comment's `bodyExcerpt` share the one length, so it has a single home rather than
 * being duplicated across the post/comment operation modules.
 */
import {excerpt as excerptText} from "../text/index.ts";

const POST_EXCERPT_LEN = 280; // tweet-sized

export const excerpt = (body: string): string => excerptText(body, POST_EXCERPT_LEN);
