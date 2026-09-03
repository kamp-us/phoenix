import type {AuthKey} from "../tr/auth";

// Lowercase like the Turkish side: kamp.us speaks in lowercase, and a locale swap changes the
// language, never the typographic voice.
//
// Where Turkish suffixes a brand noun into a longer word (`divanda`, `panoda`, `çaylaksın`) that
// word is no longer a whole-word hit, so English must not spell the bare noun either or the
// per-key counts diverge. English carries a placeholder instead — named `{panoNoun}`, never
// `{pano}`, because the invariant's `\p{L}+` scan reads a placeholder's own name as a word.
export const auth = {
	"auth.brand.pano": "pano",
	"auth.brand.sozluk": "sözlük",
	"auth.brand.divan": "divan",
	"auth.brand.caylak": "çaylak",
	"auth.brand.yazar": "yazar",

	"auth.signIn.title": "sign in",
	"auth.signIn.sub": "pick up where you left off.",
	"auth.signIn.submit": "continue",
	"auth.signIn.pending": "signing in…",
	"auth.signIn.failed": "sign-in failed",
	"auth.signIn.altPrompt": "no account yet? ",
	"auth.signUp.title": "sign up",
	"auth.signUp.sub": "the door is open, a voice is earned.",
	"auth.signUp.rite":
		"opening an account is free to everyone. what you write first is reviewed as a çaylak in the {divanNoun}; as you contribute, a yazar vouches for you and you become one too — and from then on what you write goes live directly.",
	"auth.signUp.submit": "create account",
	"auth.signUp.pending": "creating…",
	"auth.signUp.failed": "sign-up failed",
	"auth.signUp.altPrompt": "already have an account? ",

	"auth.field.name.label": "display name",
	"auth.field.email.label": "e-mail",
	"auth.field.username.label": "username",
	"auth.field.username.optional": "(optional)",
	"auth.field.username.hint": "your profile opens at /u/<name>. it cannot be changed later.",
	"auth.field.password.label": "password",
	"auth.field.password.capsLock": "Caps Lock on",
	"auth.field.password.show": "show password",
	"auth.field.password.hide": "hide password",
	"auth.field.password.placeholder": "at least 8 characters",

	"auth.validation.nameRequired": "display name is required",
	"auth.validation.emailRequired": "e-mail is required",
	"auth.validation.emailInvalid": "enter a valid e-mail",
	"auth.validation.passwordRequired": "password is required",
	"auth.validation.passwordTooShort": "password must be at least 8 characters",

	"auth.username.saving": "saving…",
	"auth.stuck.title": "could not set the username",
	"auth.stuck.subBefore": "your account was created, but the username",
	"auth.stuck.subAfter":
		"could not be set. a username cannot be changed later, so try again before continuing.",
	"auth.stuck.retry": "try again",
	"auth.stuck.abandon": "drop this name, i'll pick one later",

	"auth.bootstrap.title": "choose your username",
	"auth.bootstrap.confirmHint":
		"this name was derived from your e-mail. it cannot be changed later — change it now if you want to.",
	"auth.bootstrap.confirmSubmit": "confirm this name",
	"auth.bootstrap.submit": "continue",

	"auth.welcome.loading": "loading…",
	"auth.welcome.title": "welcome",
	"auth.welcome.titleCaylak": "welcome, çaylak",
	"auth.welcome.lede":
		"kamp.us is a slow corner where developers teach themselves. links and writing are shared on {panoNoun}; in {sozlukNoun} we write terms in our own words. no ads, no follower race — a voice is earned.",
	"auth.welcome.standingHeading": "where you stand",
	"auth.welcome.caylakLine": "your account is new; you are still a {caylakNoun}.",
	"auth.welcome.karmaLabel": "karma",
	"auth.welcome.vouchTerm": "kefil",
	"auth.welcome.yazarNote": "you are already a {yazarNoun}; what you write goes live directly.",
	"auth.welcome.standingLoading": "loading your standing.",
	"auth.welcome.riteHeading": "the road ahead",
	"auth.welcome.riteBody":
		"write your first contribution — you can start by adding an entry to an existing term. as you contribute, a yazar becomes your kefil; once the vouch and the review are complete you become a yazar and what you write goes live directly.",
	"auth.welcome.continue": "continue",

	"auth.landing.tagline": "a slow corner where developers teach themselves.",
	"auth.landing.manifesto.panoLead": "on {panoNoun}",
	"auth.landing.manifesto.panoBody": "we share and discuss links and writing.",
	"auth.landing.manifesto.sozlukLead": "in {sozlukNoun}",
	"auth.landing.manifesto.sozlukBody": "we write terms in our own words.",
	"auth.landing.manifesto.tail":
		"turkish first; no ads, no follower counts, no sensation — just things worth reading and the few hundred people who write them.",
	"auth.landing.rite.doorLead": "the door is open:",
	"auth.landing.rite.doorBody": "opening an account is free to everyone.",
	"auth.landing.rite.earnedLead": "a voice is earned:",
	"auth.landing.rite.earnedBody":
		"what you write first is reviewed as a çaylak in the {divanNoun}; as you contribute a yazar becomes your kefil and you become a yazar — and from then on what you write goes live directly.",
	"auth.landing.join.label": "create an account",
	"auth.landing.join.sub": "the door is open · a voice is earned",
	"auth.landing.browse.panoSub": "posts · discussions",
	"auth.landing.browse.sozlukSub": "terms · definitions",
	"auth.landing.col.pano": "the last 24 hours on {panoNoun}",
	"auth.landing.col.sozluk": "latest in {sozlukNoun}",
	"auth.landing.seeAll": "see all",
	"auth.landing.empty.posts": "no posts yet.",
	"auth.landing.empty.terms": "no terms yet.",
	"auth.landing.loading": "loading…",
	"auth.landing.error": "could not load right now",
	"auth.landing.stats.definitions": "definitions",
	"auth.landing.stats.posts": "posts",
	"auth.landing.stats.authors": "yazar",
	"auth.landing.stats.comments": "comments",
	"auth.landing.stats.version": "phoenix",
	"auth.landing.stats.error": "no stats right now",
	"auth.landing.row.voteOne": "vote",
	"auth.landing.row.voteOther": "votes",
	"auth.landing.row.commentOne": "comment",
	"auth.landing.row.commentOther": "comments",
	"auth.landing.row.definitionOne": "definition",
	"auth.landing.row.definitionOther": "definitions",

	"auth.onramp.heading.sozluk": "you're ready to write your first definition",
	"auth.onramp.heading.pano": "you're ready to share your first post",
	"auth.onramp.heading.panoComment": "you're ready to write your first comment",
	"auth.onramp.body":
		"what you write as a çaylak is reviewed in a space only moderators see until you become a yazar — it is not visible to everyone right away. as you write and contribute you gather karma, and with a yazar's backing you become one; then what you write goes live directly.",
} satisfies Record<AuthKey, string>;
