import type {MecmuaKey} from "../tr/mecmua";

// Lowercase like the Turkish side — the locale swap changes the language, never the voice.
// `mecmua`, `yazar` and `çaylak` are brand nouns (ADR 0347), so they read identically here;
// where the Turkish carries only a suffixed form (`çaylakların`, `yazarsın`) the English uses a
// non-brand word too, so `brandNouns.unit.test.ts` sees the same count on both sides.
export const mecmua = {
	"mecmua.loading": "loading…",
	"mecmua.cta.newPost": "new post",
	"mecmua.nav.discover": "discover",
	"mecmua.nav.feed": "feed",
	"mecmua.nav.myPosts": "my posts",

	"mecmua.subscribe.subscribe": "subscribe",
	"mecmua.subscribe.following": "following",
	"mecmua.subscribe.leave": "unfollow",
	"mecmua.subscribe.error.subscribe": "could not subscribe, try again.",
	"mecmua.subscribe.error.unsubscribe": "could not unsubscribe, try again.",
	"mecmua.subscribe.error.generic": "something went wrong, try again.",

	"mecmua.index.title": "mecmua",
	"mecmua.index.lede": "long-form writing from the community",
	"mecmua.index.error": "posts could not be loaded, try again.",
	"mecmua.index.empty.title": "no posts yet",
	"mecmua.index.empty.description": "the first mecmua post will show up here once published.",

	"mecmua.feed.title": "mecmua",
	"mecmua.feed.lede": "the latest from the authors you follow.",
	"mecmua.feed.error": "the feed could not be loaded: {code}",
	"mecmua.feed.empty.title": "nothing in your feed yet",
	"mecmua.feed.empty.description": "follow a yazar or two and their posts will show up here.",

	"mecmua.drafts.title": "my posts",
	"mecmua.drafts.lede": "your drafts and the posts you have published.",
	"mecmua.drafts.error": "posts could not be loaded: {code}",
	"mecmua.drafts.empty.title": "you have not written anything yet",
	"mecmua.drafts.empty.description": "start a new post; your drafts collect here.",
	"mecmua.drafts.untitled": "(untitled draft)",
	"mecmua.drafts.published": "published",
	"mecmua.drafts.draft": "draft",

	"mecmua.editor.title.new": "new post",
	"mecmua.editor.title.edit": "edit post",
	"mecmua.editor.myPosts": "my posts",
	"mecmua.editor.backToMyPosts": "back to my posts",
	"mecmua.editor.draftNotFound": "draft not found.",
	"mecmua.editor.lede":
		"write something long-form. save a draft whenever you like; publish when it is ready.",
	"mecmua.editor.field.title": "title",
	"mecmua.editor.field.titlePlaceholder": "the title of your post",
	"mecmua.editor.field.body": "body",
	"mecmua.editor.action.saveDraft": "save draft",
	"mecmua.editor.action.publish": "publish",
	"mecmua.editor.notice.draftSaved": "draft saved",
	"mecmua.editor.notice.published": "your post is published",
	"mecmua.editor.error.saveDraft": "the draft could not be saved",
	"mecmua.editor.error.publish": "the post could not be published",

	"mecmua.gate.signedIn":
		"you need to be a yazar to publish — posts by çaylaks are not published yet.",
	"mecmua.gate.signedOut": "sign in and become a yazar to publish.",

	"mecmua.post.notFound.title": "post not found",
	"mecmua.post.notFound.message":
		'we could not find a post called "{slug}". want to look at something else?',
	"mecmua.post.error": "the post could not be loaded, try again.",
} satisfies Record<MecmuaKey, string>;
