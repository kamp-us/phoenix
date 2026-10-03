import type {WireCodeKey, WireUsernameKey} from "../tr/wire";

// Lowercase like the Turkish side: these are inline error lines, not sentences with a
// capitalised opener. `mecmua` is a product name (ADR 0414), so it reads identically here, and
// the other Turkish words are translated — `brandNouns.unit.test.ts` is what holds that.
const codes: Record<WireCodeKey, string> = {
	"wire.UNAUTHORIZED": "you need to sign in to do that",
	"wire.FORBIDDEN": "you do not have permission to do that",
	"wire.VOTE_REQUIRES_YAZAR": "you can vote once you are an author",
	"wire.SELF_VOTE_NOT_ALLOWED": "you cannot vote on your own content",
	"wire.VOUCH_LIMIT_REACHED": "you have reached your vouch limit",
	"wire.INSUFFICIENT_KARMA": "your karma is too low for that",
	"wire.EMAIL_UNVERIFIED": "verify your email address before you write",
	"wire.RATE_LIMIT_EXCEEDED": "too fast, slow down a little",
	"wire.DEFINITION_NOT_FOUND": "definition not found",
	"wire.POST_NOT_FOUND": "post not found",
	"wire.POST_DELETE_FAILED": "the post could not be deleted, please try again",
	"wire.COMMENT_NOT_FOUND": "comment not found",
	"wire.VALIDATION_ERROR": "the details you entered are not valid",
	"wire.BODY_REQUIRED": "the body cannot be empty",
	"wire.BODY_TOO_LONG": "the body is too long",
	"wire.TITLE_REQUIRED": "the title cannot be empty",
	"wire.TITLE_TOO_LONG": "the title is too long",
	"wire.URL_INVALID": "invalid link",
	"wire.TAGS_REQUIRED": "pick at least one tag",
	"wire.TAG_INVALID": "invalid tag",
	"wire.PARENT_NOT_FOUND": "the content you replied to was not found",
	"wire.INVALID_FORMAT": "invalid format",
	"wire.TOO_SHORT": "too short",
	"wire.TOO_LONG": "too long",
	"wire.ALREADY_SET": "already set",
	"wire.TAKEN": "that value is taken",
	"wire.USER_NOT_FOUND": "user not found",
	"wire.DISPLAY_NAME_EMPTY": "the display name cannot be empty",
	"wire.BAN_REASON_REQUIRED": "a ban reason is required",
	"wire.EMAIL_FAILING_REASON_REQUIRED": "a reason for the mark is required",
	"wire.MECMUA_DISABLED": "mecmua is closed right now",
	"wire.MECMUA_POST_NOT_FOUND": "entry not found",
	"wire.MUTE_DISABLED": "mute is off right now",
	"wire.SELF_MUTE_REJECTED": "you cannot mute yourself",
	"wire.BAD_REQUEST": "invalid request",
	"wire.INTERNAL_SERVER_ERROR": "something went wrong, please try again",
};

const username: Record<WireUsernameKey, string> = {
	"wire.username.TOO_SHORT": "a username must be at least 3 characters",
	"wire.username.TOO_LONG": "a username can be at most 30 characters",
	"wire.username.INVALID_FORMAT": "a username can only contain lowercase letters, digits and -",
	"wire.username.RESERVED": "that username is reserved and cannot be used",
	"wire.username.TAKEN": "that username is taken, try another one",
	"wire.username.ALREADY_SET": "your username is already set",
	"wire.username.generic": "the username could not be set",
};

export const wire = {
	...codes,
	...username,
};
