# Build your first app with fabrika

In this lesson you take an app idea to its first working page. The app is Streakly, a small habit
tracker: one web page that lists three habits with a streak count beside each. You describe the
look, file the idea, and fabrika builds the page, checks it and adds it to your repo. It takes
about 25 minutes, and most of that is waiting while fabrika works.

Build Streakly as written, even if you have your own idea ready. Once you have done it once, the
same steps carry your own app.

You need:

- The repo you finished [Getting started with fabrika](getting-started.md) in, with its first pull
  request merged. A pull request is a proposed change to the repo that waits to be checked. Merging
  it adds the change to `main`, the repo's main line.
- fabrika's command-line tool at version 0.10.0 or later. `fabrika --version` prints yours.
- A web browser, and a way to take a screenshot.

This lesson writes two files that step 9 of getting started also writes: the design rules and the
hand-check rule. If you did that step and both files are already on GitHub, begin at step 4.

Run every command from the root of your clone, on `main`. A command that starts with `/` is typed
into Claude Code, opened in that clone, not into a shell.

The samples below come from one run of this lesson. Where the run printed a web address, the sample
shows `<issue-url>` or `<pull-request-url>`, and yours will print the address of your own issue or
pull request. Your wording will differ too: the agents write their answers fresh each time.

The numbers follow on from getting started, which used 1 for its issue and 2 for its pull request.
Here the issue is 3 and its pull request is 4. If yours differ, use yours.

## 1. Say what the app looks like

fabrika's builder does not invent a look. It follows your design rules: a file named
`design-system-manifest.md` that states the colours, type and spacing every screen must keep to.

Open Claude Code in the clone and type:

```
/fabrika:front-door I am building a small habit tracker called Streakly. It will be one web page in plain HTML and CSS. It has a screen, so I think I need the design rules file. Can you help me with that?
```

It proposes a look in plain words and asks before it writes anything. In this run the answer
included:

```
- **Mood:** calm and encouraging, never nagging.
- **Colours:** warm off-white background, near-black text, one orange for streaks.
- **Type:** the system font, with big bold streak numbers.
- **Spacing:** roomy, one column, one habit per row.

Want me to write the design rules file with this look?
```

Ask for one change, so the look is yours, and say yes. If your proposal names another colour for
streaks, put that colour in place of `orange`. Type:

```
I like it, but make the streak colour green instead of orange. Then yes, write it.
```

Its answer began:

```
Done. The design rules file is written and checked: `design-system-manifest.md` at the repo root, with green (`#1B7F45`) as the streak colour.
```

The reply may go on to ask you a question, such as an offer to commit the file for you, and it may
name a command to run next. Do not answer the question and do not run that command. This lesson
commits the file in step 3 and gives you each command when you need it.

Open `design-system-manifest.md` and read it. It is short, and it is the whole brief the builder
gets for how Streakly looks. The file is on your machine only. Step 3 puts it on GitHub.

## 2. Say that you will check the screen yourself

When a pull request changes a screen, fabrika's reviewer wants to see that screen. By default it
opens a hosted copy of the app, which means a copy running on a server for anyone to visit.
Streakly has no hosting, so say that you will look at the screen yourself:

```bash
fabrika status bootstrap hand-check-rule
```

```
status bootstrap: created .fabrika.jsonc for hand-check-rule with one hand-check rule, read-back conformed.
bootstrap	created	hand-check-rule	.fabrika.jsonc	ok
```

That wrote one rule into a new file, `.fabrika.jsonc`. Getting started says
[what the rule does](getting-started.md#if-your-app-is-not-hosted-yet).

## 3. Put both files on GitHub

The builder starts from what is on GitHub, so the two files have to be there first. A commit is one
saved change in the repo's history. Make one:

```bash
git add design-system-manifest.md .fabrika.jsonc
git commit -m "Add design rules and the hand-check rule"
```

Push that commit to GitHub with `git push`.

## 4. File the idea

Describe the first page in two sentences. In Claude Code, type:

```
/fabrika:report The app has no screen yet. I want the first page of Streakly: one web page, plain HTML and CSS in index.html, that shows a list of three example habits (Read, Walk, Water) with a streak count next to each, following the design rules file.
```

Its answer began:

```
Filed: #3 <issue-url>

It's waiting for triage. I didn't build the page — report only files the request.

One gap I noted in the issue: you didn't give streak numbers, so the builder will pick sample ones.
```

One page is one issue. You do not need to split it up or plan it first.

## 5. Triage it

Triage turns your two sentences into something a builder can pick up cold. Type:

```
/fabrika:triage 3
```

It takes about two minutes. In this run its answer was:

````
Issue 3 is triaged. It is a new feature, priced p1, meaning it is worth pulling next, because nothing else can be built until a page exists.

What I changed on <issue-url>:
- **Body rewritten**, with the original kept underneath. It opens with a plain summary and a short pitch.
- **12 acceptance criteria added**, taken from `design-system-manifest.md`. One needs a screenshot in the pull request, since the look can't be judged from code alone.
- **Home:** the "First arc" milestone. It waits on no other issue.
- **Labels:** `type:feature`, `p1`, `ready-for:agent`, `class:ui`, `class:doc`.
- **Scope:** I added a one-line README fix, because its "no app code yet" sentence goes stale once the page lands. The streak numbers are left to the builder as sample values.

**What happened:** the issue is ready for a builder, but the pitch check fails until you approve the pitch.

**What you do next:** post this as a comment on <issue-url>:

```
pitch-approved: appetite S
```

A pitch is a short proposal naming the problem, how much effort it is worth and what is left out. The size (`S`, `M` or `L`, small to large) is that effort budget. Work entering a build lane owes a pitch and your approval of its size, so the check blocks this issue until that comment is there, and a size changed later needs a new approval.
````

Open the issue on GitHub and read it. The section named "Pitch" is the proposal, and the list under
"Acceptance criteria" is what the finished page is graded against. Notice the criterion that asks
for a screenshot. You meet it again in step 8.

## 6. Approve the pitch

This is the moment you agree to the scope. Nothing gets built until you do.

On the issue's page on GitHub, paste this line into the comment box at the bottom and press
**Comment**:

```
pitch-approved: appetite S
```

## 7. Start the run

```
/fabrika:operate 3
```

`operate` carries one issue all the way through. It picks the right builder for an issue with a
screen, sends the pull request to review, and merges it. You watch.

This is the long step, about ten minutes. The run builds the page and opens pull request 4. Then it
stops and hands one job to you. Its last lines were:

```
**What happened:** the page and README in <pull-request-url> are right, but the review failed because the PR body has no screenshot, and no step in the run can upload one.

**What you do next:** paste a screenshot of `index.html` into the PR 4 body (or rule that the written hand-check counts), then run `fabrika lane transition 3 UNBLOCKED --task issue` from the repo root and start the run on issue 3 again: <issue-url>

LANE-PARKED
```

`LANE-PARKED` means the run is waiting for a person. The reviewer checked the page against all
twelve criteria and passed every one but the screenshot, which only you can supply. Step 8 supplies
it.

If your last line is `LANE-TERMINAL`, the pull request is already merged. Go to step 10.

## 8. Look at the page, and add a screenshot

The page is not on `main` yet. It sits on the pull request's branch, a side line of the repo's
history. The run left a comment on issue 3 that opens "This run is parked and needs a person", and
that comment names the branch. In this run it was `build/3-first-page-habit-list-87276b55`.

Fetch the branch and put its files in your clone, with your branch's name in place of this one:

```bash
git fetch origin
git switch --detach origin/build/3-first-page-habit-list-87276b55
```

```
HEAD is now at c8bf203 feat: add the first Streakly page, a habit list with streak counts (#3)
```

Open `index.html` in your browser. On a Mac, `open index.html` does it. You see a `Streakly` heading
and three white cards, Read, Walk and Water, each with a green number on its right. That is your
app's first page. Check it against your design rules, then take a screenshot of it.

Open pull request 4 on GitHub. On its description, the first box on the page, choose **Edit** from
the `…` menu. Drag your screenshot into the text, at the end, and press **Update comment**.

Then put your clone back on `main`:

```bash
git switch main
```

## 9. Let the run finish

Tell fabrika the job it gave you is done:

```bash
fabrika lane transition 3 UNBLOCKED --task issue
```

Start the run again:

```
/fabrika:operate 3
```

It picks up where it stopped. The reviewer looks at your screenshot, passes the last criterion, and
the pull request is merged. This took about eight minutes, and ended with:

```
Issue 3 is done: <pull-request-url> was squash-merged into main as `48460c6e` and <issue-url> is closed.
Nothing is needed from you. If you want this repo on a project table, run `fabrika table setup` and then `fabrika table sync 3` from the repo root.

LANE-TERMINAL
```

`LANE-TERMINAL` means the run is over. Just above those lines it says a table did not sync. A new
repo has no project table, and this lesson does not need one.

## 10. Open your app

Pull the merge into your clone:

```bash
git pull
```

Open `index.html` in your browser again. This time it comes from `main`. Streakly's first page is
in your repo.

## You are done

You wrote down a look, filed an idea in two sentences, approved its scope, and checked the screen
with your own eyes. fabrika wrote the page, reviewed it against the criteria and merged it.

Every page after this one takes steps 4 to 10 again: report, triage, approve, operate, look, open.
The design rules and the hand-check rule are already in place.

Where to go next:

- [`how-fabrika-works.md`](how-fabrika-works.md): why the builder, the reviewer and the merge step
  are separate, and why a run can stop and pick up again.
- [If your app has no preview deploys](adopt-fabrika-in-a-new-repo.md#if-your-app-has-no-preview-deploys):
  the hand-check rule in full, and what changes once your app has hosting.
- [`run-agents-under-a-second-account.md`](run-agents-under-a-second-account.md): keep steps like
  the pitch approval yours alone, by running the agents under a second GitHub account.
