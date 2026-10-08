# apple-pi

A UI and workflow extension for [Pi](https://github.com/earendil-works/pi). It adds provider usage, local reset times, a custom footer, and transcript controls. Pi loads it directly from your Git clone.

## Features

- Provider usage for Codex and Z.ai: percentage left, a usage bar, a reset countdown, and the local reset time. Extra Codex quota windows appear when the provider reports them. A failed refresh keeps the last good numbers and adds a "showing last result" line. Other providers show "no usage endpoint".
- A footer with the directory, Git branch, session name, token use, cost, context use, model, thinking level, average output speed of recent replies, and extension status.
- Small titles above tool calls, assistant replies, and thinking blocks. Built-in tool results and expand/collapse controls stay in place.
- A **previous message** button above the fullscreen editor.
- Fullscreen copy that joins transcript-wrapped lines while keeping intentional line breaks. In Herdr, selected text goes to the clipboard of the computer viewing the chat, including remote chats. No setting is needed.
- Automatic continuation after a subscription usage limit resets, with messages added while waiting included on resume. No settings or enable command.

Reset times use the computer's local time zone and a 24-hour clock:

```text
5-hour: resets 3h 42m (18:30)
weekly: resets 2d 5h (Sun 4 Oct, 18:30)
```

Windows shorter than one day show time only, even across midnight. Daily, weekly, monthly, and unknown windows show the weekday, date, and time. Narrow layouts wrap onto extra lines, so the reset time and the `/login` command in an expired-token message stay whole. Missing timestamps show no reset details; passed timestamps show `resets now` with the scheduled time until fresh data arrives.

## Install

Do these steps in order on each computer. Pi loads the repository in place: `pi install .` records the clone's path in `~/.pi/agent/settings.json`, so the clone can live in any folder except `~/.pi/agent/extensions/`. Each computer can use a different path.

### 1. Check the requirements

Git, Node.js 22.19 or later, pnpm, and `@earendil-works/pi-coding-agent` (the upstream package, checked with Pi 1.0.0). Pi supplies the extension's runtime dependencies, so the repository needs no build step.

Run `pi --version`. If Pi is missing, install the tested version:

```bash
pnpm add -g @earendil-works/pi-coding-agent@1.0.0
```

### 2. Clone the repository

In the folder where you keep Git repositories:

```bash
git clone https://github.com/kelvinz/apple-pi.git apple-pi
cd apple-pi
```

A private repository needs a GitHub account with access.

### 3. Register the folder with Pi

From the `apple-pi` folder:

```bash
pi install .
pi list
```

The package's `package.json` tells Pi to load `extensions/apple-pi.ts`.

### 4. Reload and check

Run `/reload` in an open Pi session, or start a new one. Installation is done when:

- `pi list` shows your local `apple-pi` folder.
- Pi shows the custom footer.
- After signing in (below), `/usage` shows the limits of a supported provider's model.

### Provider access

Sign in separately on each computer with Pi's `/login` command for Codex. Z.ai uses Pi's saved `zai` API key or the `ZAI_API_KEY` environment variable. Only the provider for the active model is queried.

Pi credentials, sessions, and machine settings stay out of this repository.

## Edit and sync

Edit `extensions/apple-pi.ts` in your clone, then sync through Git.

On the computer where you made changes:

```bash
pnpm test
git add extensions tests README.md package.json .gitignore
git commit -m "Update apple-pi"
git push
```

On the other computer:

```bash
git pull --ff-only
```

Then run `/reload` in Pi. Commit and push before switching computers. If `git pull --ff-only` fails, resolve the Git changes by hand so neither copy is overwritten.

`pi update --extensions` does not pull this working repository; `git pull` is the update path.

## Copy from a remote chat

In Pi's fullscreen chat, select text and copy it as usual. Inside Herdr, apple-pi sends the selection through the terminal to the clipboard of the computer viewing the chat. It does not rely on SSH environment variables, which can be missing in persistent remote panes. This route is used in both local and remote Herdr panes; it does not write to the remote Mac's native clipboard.

Paragraph formatting stays the same: transcript-wrapped lines are joined, while intentional line breaks, lists, tables, and code are preserved. Outside Herdr, Pi's usual clipboard route is unchanged. Pi's separate `/copy` or “copy last reply” action without a selection, and Claude's copy actions, are not changed.

The viewing terminal must allow terminal clipboard writes (OSC 52). “Copied” means the request was sent; the terminal gives no confirmation that it accepted it. A write error or a selection over 100,000 base64 characters (75,000 UTF-8 bytes) shows an error instead. Copy a smaller selection if needed. The extension does not read the clipboard, create clipboard-sync jobs, or save copied text.

## Automatic resume

In long-lived Pi terminal and RPC sessions, a finalized assistant usage-limit error automatically schedules `continue` for the reset time plus one minute. Pi's own retries finish first. There is nothing to configure or turn on.

The footer shows `Auto-resume at …`. You can keep submitting messages while it waits: they appear in the transcript as `apple-pi-queued` entries, including attached images, without starting another model request or changing the deadline. Pi sends these entries to the provider as user messages when the thread continues. Ordinary slash commands still work normally; they are not queued by this feature.

The reset is taken from the error's retry hint and fresh provider usage. If both main 5-hour and weekly windows are exhausted, the later reset wins. Stale usage and unrelated extra quota buckets cannot postpone the retry. If neither the error nor the endpoint supplies a trustworthy reset time, it retries after 15 minutes, then 30, then at most once an hour until a new limit error supplies better information. Authentication/network errors, ordinary HTTP 429s, and successful replies mentioning limits do not activate it.

**There are no crons or background jobs.** Only the running Pi session owns the timer. Closing/exiting Pi, replacing the thread, or `/reload` clears it; reopening a thread does not restore an old timer. Changing the model or navigating to another branch also clears it. Messages already added to the transcript remain saved. Detaching from Herdr is different from closing Pi: if the remote Pi process stays alive, it will still resume.

Pi must stay running, and the timer waits for Pi to be idle and for extension approval/question dialogs to close. The resumed agent uses your existing tool permissions and may continue executing tools unattended. One-shot print/JSON runs do not schedule continuations.

## Usage and checks

The footer fetches usage at session start. It also refreshes when you send a message, after each turn of a run, after the agent settles, and when the model changes, at most once a minute per provider. `/usage` forces a refresh. The countdown is recalculated on every footer render; there is no separate timer.

The footer's `~120 tok/s` is an estimate of how fast content arrives, not the provider's billed token rate. It counts received answer text, thinking text (including summaries), and tool-call arguments at roughly four characters per token. Hidden reasoning is not counted. This estimate varies by language and content. Timing runs from the first nonempty piece of text to the end of the reply, including pauses but excluding the initial wait. The value uses total estimated tokens divided by total time across the last 10 qualifying replies; failed, cancelled, and very short replies are excluded.

Run the tests from the repository root, across time zones:

```bash
pnpm test
TZ=Asia/Singapore pnpm test
TZ=America/New_York pnpm test
TZ=UTC pnpm test
```

The tests use the jiti compiler and TUI helpers from a global `@earendil-works/pi-coding-agent` (found through `pnpm root -g` or `npm root -g`; set `PI_PACKAGE_DIR` for another location). Credentials and HTTP responses are mocked, so no provider requests happen. They cover reset formats, footer widths, both providers, stale data after a failed refresh, the once-a-minute refresh limit, output-speed averaging and filtering, tool registration with Pi's settings, and the copy reflow rules. Clipboard tests cover Herdr routing without SSH variables, UTF-8 encoding, size limits, write errors, reloads, and Pi's real selection-copy action with a simulated terminal. Fake-clock auto-resume tests cover the reset buffer, weekly windows, queued text/images and their provider-context conversion, sleep/wake, unknown-reset backoff, approval dialogs, and timer cleanup (including closing during a pending fetch).

They do not cover live provider endpoints, live auto-resume behavior, or mouse and copy behavior in a terminal. Fullscreen navigation and copy rely on internal Pi layout fields and may break after a Pi update. Check these by hand:

1. For Codex and Z.ai, select the model and run `/usage`. Compare the percentage left and reset time with the provider's usage page.
2. In fullscreen mode, select a paragraph that wraps across several lines and paste it into another app. Repeat from a remote Herdr chat and paste into a local app. Done when the local clipboard has the selected text, the paragraph has no extra line breaks, and intentional paragraph breaks remain.
3. Scroll past an earlier user message and click **previous message**. Done when it returns you to that message.
4. When a real subscription limit occurs, check the auto-resume time, submit another message, and verify it is shown as queued without another provider request. Done when Pi continues once after the deadline with that message in context. Separately close/reload a waiting session and confirm no old continuation fires.

Raw provider responses and clipboard contents stay out of Git. A provider with no login is untested, not a failed check.

## Remove

From the cloned `apple-pi` folder (elsewhere, pass the registered clone path):

```bash
pi remove .
```

This removes the package registration and keeps your Git repository. Then run `/reload` in Pi.
