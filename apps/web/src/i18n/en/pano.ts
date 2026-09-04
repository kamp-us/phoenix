import type {PanoKey} from "../tr/pano";

// Lowercase like the Turkish side, matching the layout surface: pano's voice is lowercase, and a
// locale swap changes the language, never the typographic voice. The two capitalised groups are
// the ones the Turkish side capitalises too — the vote/collapse aria-labels and the create
// dialog's fields. `pano` is a brand noun (ADR 0347), so it reads identically in both catalogs.
export const pano = {
	"pano.action.edit": "edit",
	"pano.action.delete": "delete",
	"pano.action.reply": "reply",
	"pano.action.hide": "hide",
	"pano.action.cancel": "cancel",
	"pano.action.dismiss": "cancel",
	"pano.action.submit": "submit",
	"pano.action.save": "save",
	"pano.action.saving": "saving…",
	"pano.action.deleting": "deleting…",
	"pano.action.sending": "sending…",

	"pano.field.title": "title",
	"pano.field.body": "content",
	"pano.field.url": "URL",
	"pano.field.comment": "comment",
	"pano.field.reply": "reply",

	"pano.loading": "loading…",
	"pano.optional": "(optional)",
	"pano.required": "required",
	"pano.markdown": "markdown",
	"pano.user": "user",
	"pano.backToFeed": "back to the feed",

	"pano.crumb.root": "pano",
	"pano.crumb.site": "site",

	"pano.cta.newPost": "new post",

	"pano.vote.ownPost": "You cannot vote on your own post",
	"pano.vote.retract": "Retract your vote",
	"pano.vote.up": "Upvote",

	"pano.save.save": "save",
	"pano.save.saved": "saved",

	"pano.post.text": "text",
	"pano.post.commentCount.one": "{count} comment",
	"pano.post.commentCount.other": "{count} comments",

	"pano.comment.deleted": "[deleted]",
	"pano.comment.collapse": "Collapse",
	"pano.comment.expand": "Expand",
	"pano.comment.more": "More",

	"pano.filter.hot": "hot",
	"pano.filter.new": "new",
	"pano.filter.top": "top",
	"pano.filter.discuss": "discussion",
	"pano.filter.saved": "saved",

	"pano.feed.posts": "posts",
	"pano.feed.loadFailed": "could not load {what}: {code}",
	"pano.feed.postCount.one": "{count} post",
	"pano.feed.postCount.other": "{count} posts",
	"pano.feed.postCountHost.one": "{count} post · {host}",
	"pano.feed.postCountHost.other": "{count} posts · {host}",
	"pano.feed.savedCount.one": "{count} saved",
	"pano.feed.savedCount.other": "{count} saved",
	"pano.feed.savedEmpty.title": "nothing saved yet",
	"pano.feed.savedEmpty.hintBefore": "keep a post by hitting",
	"pano.feed.savedEmpty.hintAfter": ".",
	"pano.feed.savedEmpty.cta": "explore pano",

	"pano.mode.link": "link",
	"pano.mode.linkShort": "link",
	"pano.mode.text": "text",

	"pano.createDialog.title": "New Pano Entry",
	"pano.createDialog.description": "enrich pano :)",
	"pano.createDialog.titleLabel": "Title",
	"pano.createDialog.titleHint": "At least {min} characters",
	"pano.createDialog.textLabel": "Text",
	"pano.createDialog.textHint": "markdown supported",

	"pano.submit.heading": "share something",
	"pano.submit.lede":
		"a link, a piece of writing, a question. self-promo is fine too — just say once why you are sharing it.",
	"pano.submit.url.placeholder": "https://overreacted.io/...",
	"pano.submit.titleAutofill": "the title will fill in on its own",
	"pano.submit.title.tooShort": "cannot be shorter than {min} characters",
	"pano.submit.title.tooLong": "at most {max} characters",
	"pano.submit.title.placeholder": "at least {min} characters",
	"pano.submit.context.label": "context (optional)",
	"pano.submit.context.placeholder": "say once why you are sharing it",
	"pano.submit.body.hint": "markdown · ``` ``` code block · {count}/{max}",
	"pano.submit.body.placeholder": "markdown · ``` ``` code block",
	"pano.submit.tags.legend": "tags · at least 1, at most 3",
	"pano.submit.tags.lastStep": "last step: pick at least one tag",
	"pano.submit.draft": "draft",
	"pano.submit.draftSaved": "draft saved",
	"pano.submit.draftFailed": "the draft could not be saved",
	"pano.submit.share": "share",
	"pano.submit.failed": "the post could not be shared",
	"pano.submit.disabled.lastStep": "one step left before “share”: pick at least one tag above",
	"pano.submit.disabled.needTag": "you have to pick at least one tag before “share”",

	"pano.detail.loadFailed": "the post could not be loaded: {code}",
	"pano.detail.notFound.message":
		'we found no post called "{query}". want to look at something else?',
	"pano.detail.postUpdateFailed": "the post could not be updated",
	"pano.detail.deletePost.title": "delete the post",
	"pano.detail.deletePost.description":
		"are you sure you want to delete this post? it cannot be undone.",
	"pano.detail.deleteComment.title": "delete the comment",
	"pano.detail.deleteComment.description":
		"are you sure you want to delete this comment? it cannot be undone.",
	"pano.detail.commentDeleteFailed": "the comment could not be deleted",
	"pano.detail.commentAddFailed": "the comment could not be added",
	"pano.detail.commentUpdateFailed": "the comment could not be updated",
	"pano.detail.noComments.title": "no comments yet.",
	"pano.detail.noComments.description": "write the first one — start the discussion.",
	"pano.detail.editComment.label": "edit the comment",

	"pano.composer.placeholder": "write a comment. markdown works, ``` ``` code blocks work.",
	"pano.composer.signedOutPlaceholder": "log in to write a comment",
	"pano.composer.submit": "add comment",

	"pano.error.titleRequired": "the title cannot be empty",
	"pano.error.titleTooLong": "the title can be at most {max} characters",
	"pano.error.bodyTooLong": "the text can be at most {max} characters",
	"pano.error.tagsRequired": "pick at least one tag",
	"pano.error.tagInvalid": "invalid tag",
	"pano.error.urlInvalid": "invalid link",
	"pano.error.titleTooShort": "the title has to be at least {min} characters",
	"pano.error.validation": "the details you entered are invalid",
	"pano.error.userNotFound": "user not found",
	"pano.error.badRequest": "invalid request",
	"pano.error.postNotFound": "post not found",
	"pano.error.commentBodyRequired": "the comment cannot be empty",
	"pano.error.commentBodyTooLong": "the comment can be at most {max} characters",
	"pano.error.commentNotFound": "comment not found",
	"pano.error.parentNotFound": "the comment being replied to was not found",
} satisfies Record<PanoKey, string>;
