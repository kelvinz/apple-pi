# apple-pi

A UI and workflow extension for [Pi](https://github.com/earendil-works/pi). It adds provider usage, local reset times, a custom footer, and transcript controls. Pi loads it directly from your Git clone.

## Features

- Provider usage for Codex and Z.ai: percentage left, a usage bar, a reset countdown, and the local reset time. The new OpenAI subscription login can show separately labelled Codex CLI quota from an existing CLI login. Extra Codex quota windows appear when the provider reports them. A failed refresh keeps the last good numbers and adds a "showing last result" line. Other providers and ordinary OpenAI API-key setups show "no usage endpoint".
- A footer with the directory, Git branch, session name, token use, cost, context use, model, thinking level, average output speed of recent replies, and extension status.
- Small titles above tool calls, assistant replies, and thinking blocks. Built-in tool results and expand/collapse controls stay in place.
- A **previous message** button above the fullscreen editor.
- Fullscreen copy that joins transcript-wrapped lines while keeping intentional line breaks. In Herdr, selected text goes to the clipboard of the computer viewing the chat, including remote chats. No setting is needed.
- Automatic continuation after a subscription usage limit resets, with messages added while waiting included on resume. No settings or enable command.
- A permission question before shell commands that can lose work for good or reach past the project: deleting files or discarding work, or pushing to a remote, such as `rm`, `git reset --hard`, or `git push`. See [Destructive commands](#destructive-commands).

Reset times use the computer's local time zone and a 24-hour clock:

```text
5-hour: resets 3h 42m (18:30)
weekly: resets 2d 5h (Sun 4 Oct, 18:30)
```

Windows shorter than one day show time only, even across midnight. Daily, weekly, monthly, and unknown windows show the weekday, date, and time. Narrow layouts wrap onto extra lines, so the reset time and the `/login` command in an expired-token message stay whole. Missing timestamps show no reset details; passed timestamps show `resets now` with the scheduled time until fresh data arrives.

## Install

Do these steps in order on each computer. Pi loads the repository in place: `pi install .` records the clone's path in `~/.pi/agent/settings.json`, so the clone can live in any folder except `~/.pi/agent/extensions/`. Each computer can use a different path.

### 1. Check the requirements

Git, Node.js 22.19 or later, pnpm, and `@earendil-works/pi-coding-agent` (the upstream package, checked with Pi 1.3.0; the tool-title renderer resolver needs its `registerToolRenderer` API). Pi supplies the extension's runtime dependencies, so the repository needs no build step.

Run `pi --version`. If Pi is missing, install the tested version:

```bash
pnpm add -g @earendil-works/pi-coding-agent@1.3.0
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

Sign in separately on each computer with Pi's `/login` command for legacy Codex. For the new **OpenAI → Sign in with ChatGPT** login, keep your active model under `openai`. Its token cannot read the old quota endpoint, so apple-pi reads an existing Codex CLI subscription credential from `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) only to read quota: the footer shows it, and auto-resume uses it to time retries. Run `codex login` with the **same ChatGPT account** if that credential is missing, then `/usage` in Pi. The CLI refreshes its own token whenever you use Codex, so an expired token usually only needs a Codex request (or `codex login`). If the CLI keeps its login in the OS credential store (`cli_auth_credentials_store = "keyring"`, or `"auto"` where a store is available), there is no `auth.json` to read and the footer asks for `codex login`; set `cli_auth_credentials_store = "file"` in the Codex config and sign in again to use this feature. The extension does not refresh or write the CLI credential, change chat authentication, or send the new OpenAI token/API keys to the Codex quota endpoint.

Rows are labelled **codex CLI**. The quota belongs to whichever account the CLI is signed in to, and Pi's OpenAI subscription usage counts against it. OpenAI's Subscription Sharing limit can stop Pi before the window shows 100%; on 2026-10-23 it stopped Pi once at 98% and once at 100%. Without a usable CLI login, the footer shows setup guidance and `https://chatgpt.com/settings/usage`.

Z.ai's key is resolved through Pi itself (`modelRegistry.getApiKeyForProvider`), so a saved literal key, a saved reference to `ZAI_API_KEY`, and a saved credential command all work exactly as they do for chat requests; apple-pi never interprets Pi's credential storage. Only the provider for the active model is queried.

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

Paragraph formatting stays the same: transcript-wrapped lines are joined, while intentional line breaks, lists, tables, and code are preserved. Outside Herdr, Pi's usual clipboard route is unchanged. Closing the session or removing apple-pi restores Pi's normal copying. Pi's separate `/copy` or “copy last reply” action without a selection, and Claude's copy actions, are not changed.

The viewing terminal must allow terminal clipboard writes (OSC 52). “Copied” means the request was sent; the terminal gives no confirmation that it accepted it. A write error or a selection over 100,000 base64 characters (75,000 UTF-8 bytes) shows an error instead. Copy a smaller selection if needed. The extension does not read the clipboard, create clipboard-sync jobs, or save copied text.

## Automatic resume

In long-lived Pi terminal and RPC sessions, a finalized assistant usage-limit error automatically schedules `continue` for the reset time plus one minute. Pi's own retries finish first. There is nothing to configure or turn on.

The footer shows `Auto-resume at …` when the error or fresh usage gave a reset time, or `Auto-resume retry at … · reset time unknown` when it is only a backoff retry. You can keep submitting messages while it waits: they appear in the transcript as `apple-pi-queued` entries, including attached images, without starting another model request or changing the deadline. Pi sends these entries to the provider as user messages when the thread continues. Ordinary slash commands still work normally; they are not queued by this feature.

The resume time comes from the error's own retry hint when it has one, because that names the limit that was hit. Otherwise it is the first reset of any main quota window in fresh provider usage, whatever its usage level: usually the 5-hour reset, or the weekly reset when that comes first, because it also resets the 5-hour window. OpenAI subscription models read this from the Codex CLI quota. Stale usage, passed resets, and separate extra quota buckets are ignored. If neither the error nor fresh usage supplies a reset time, it retries after 15 minutes, then 30, then at most once an hour until a new limit error supplies better information. Authentication/network errors, ordinary HTTP 429s, and successful replies mentioning limits do not activate it.

**There are no crons or background jobs.** Only the running Pi session owns the timer. Closing/exiting Pi, replacing the thread, or `/reload` clears it; reopening a thread does not restore an old timer. Changing the model or navigating to another branch also clears it. Messages already added to the transcript remain saved. Detaching from Herdr is different from closing Pi: if the remote Pi process stays alive, it will still resume.

Pi must stay running, and the timer waits for Pi to be idle and for extension approval/question dialogs to close. The resumed agent uses your existing tool permissions and may continue executing tools unattended. One-shot print/JSON runs do not schedule continuations.

## Destructive commands

Pi runs tool calls without asking. apple-pi asks you first when a `bash` or `powershell` command deletes work that you cannot get back or sends work to a remote:

- file deletion: `rm`, `rmdir -Recurse` or `rmdir /s`, `unlink`, `shred`, `srm`, `truncate`, `dd of=…`, `find -delete`, `find -exec rm`, `rsync --delete`, `Remove-Item`, `ri`, `del`, `erase`, `rd`;
- Git: every `push` (it sends commits to the shared remote; `--force` (also when joined, as in `-fu`), `+<branch>`, `--delete`, `--mirror`, and `--prune` can also lose work that is already there), `clean`, `reset --hard` or `--merge`, `checkout -- <path>` or `checkout .`, `restore` (except `--staged` only), `switch -f`, `stash drop` or `clear`, `branch -D`, `rm -f`, `worktree remove`, `reflog expire`, `gc --prune`, `update-ref -d`, and history rewrites;
- disks and services: `fdisk` (except `-l`), `mkfs`, `diskutil erase…`, `docker rm` or `prune` (except images), `kubectl delete`, `terraform destroy`, and SQL `DROP TABLE`, `DROP DATABASE`, or `TRUNCATE TABLE`.

Commands that change things you can easily restore run without a question: `rmdir` without `-Recurse` or `/s` (only empty folders), `git tag -d`, `git reset --keep`, `git rm` without `-f` (Git refuses to delete uncommitted changes), `git worktree prune`, `rsync --remove-source-files`, `docker rmi`, and `docker image …`. Every `git push` asks, including `--force-with-lease` (it is still a push to the shared remote). `sudo` and `doas` do not ask by themselves; the guard checks the command they run, so `sudo rm -rf /opt/x` still asks.

The check also looks inside `bash -c`, `eval`, `xargs`, `$( … )`, subshells, and chained commands. It checks commands after wrappers such as `sudo`, `timeout`, `nice`, `env`, and `watch`, including their common options. Codemode scripts call tools through the same check.

Before the question opens, your current model explains what the **whole command will do**, in plain words, like one person talking to another. It assumes you know Git ideas such as commits and branches, but not what each command or option does. The request asks for 2 or 3 sentences of at most 20 words in ASD-STE100 Simplified Technical English, in one paragraph, without notes in brackets or words such as "pipe" or "reflog". It first says what the command does, step by step, and then what it changes outside the project folder and what is lost for good, leaving out a part that does not apply. The guard sends its own reason for asking (for example, "Throws away every edit that you have not committed") with the command, so the explanation can name the specific risk. For example, `cd app && rm -rf dist && npm run build` should explain going into `app`, deleting `dist` and all its files for good, and then building the app. Only commands that the guard flags get an explanation. The prompt shows the explanation without a label, then the original command, and offers **Yes**, **No**, and **Type a reply**, without extra help text about these choices. A typed reply stops the command and sends your instructions back to the agent. Closing either question or submitting an empty reply also stops the command. Print and JSON runs cannot ask, so they block these commands. Questions are asked one at a time: concurrent flagged commands (including several from one codemode script) queue, so one question can never displace another unresolved one. Cancelling a queued command blocks it without a question, and closing the session blocks everything still waiting. While the question is open, apple-pi sends a `herdr:blocked` event. The tests check this event, but the live Herdr pane display has not been verified.

Each summary adds one model request through Pi's configured model and authentication (Pi 1.3.0's `modelRegistry.streamSimple`, documented in `docs/extensions.md`). It sends the full command, the shell tool name, and the guard's reason for asking, not your chat history or file contents. Command text can contain secrets; those are sent to the selected provider too. Virtual models use their configured routing. This adds latency and provider usage; the guard does not add that usage to the main chat's displayed totals. The summary has no tools and cannot grant permission. It is an AI interpretation, not proof of what will happen.

The summary request has a 15-second limit. Missing models, failed requests, incomplete or empty responses, and commands over 16,000 characters show the guard's reason for asking and a note that no summary is available, beside the full command. The guard does not show a guessed or partial summary instead. Cancelling the agent stops the command. Print and JSON runs block without making a summary request.

This check cannot find every command that can cause data loss. It reads text; it does not fully parse shell syntax or all command options. It is not a sandbox: a script or build command that deletes files (`npm run clean`, `make clean`), `mv` or `cp` over an existing file, a `>` redirect, and the `write` and `edit` tools run without a question. A `git push --dry-run` (it only shows what it would send) runs unasked. For real limits, run Pi in a sandbox or container; see Pi's `docs/security.md`. A command that only mentions one of these words in quotes, such as `grep "rm -rf"`, can ask once more than needed.

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

The tests use the jiti compiler and TUI helpers from a global `@earendil-works/pi-coding-agent` (found through `pnpm root -g` or `npm root -g`; set `PI_PACKAGE_DIR` for another location). Credentials and HTTP responses are mocked, so no provider requests happen. They cover reset formats, footer widths, Codex/Z.ai parsing, OpenAI subscription quota via Codex CLI (custom paths, missing/invalid credentials, API-key isolation, stale data, separate caches, and use as the auto-resume reset when the error has no hint), Z.ai credential resolution through Pi's registry (including missing and failing credentials and a provider switch during a pending resolution), stale data after a failed refresh, the once-a-minute refresh limit, output-speed averaging and filtering, the tool-title renderer resolver (checked against Pi's real extension loader and tool merge, so registered tools are never replaced), and the copy reflow rules. Clipboard tests cover Herdr routing without SSH variables, UTF-8 encoding, size limits, write errors, reloads, and Pi's real selection-copy action with a simulated terminal. Copy-cleanup tests cover restoring native copying on shutdown and removal, including through Pi's real forwarding TUI reference. Guard tests cover which commands ask and which run unasked, the Herdr blocked signal, declined and headless calls, non-shell tools, and the one-question-at-a-time queue for concurrent calls (including concurrent approvals through Pi's real extension selector). Fake-clock auto-resume tests cover the reset buffer, the hint-first and first-window-reset rule, weekly windows, queued text/images and their provider-context conversion, sleep/wake, unknown-reset backoff, approval dialogs, and timer cleanup (including closing during a pending fetch).

They do not cover live provider endpoints, live auto-resume behavior, or mouse and copy behavior in a terminal. Fullscreen navigation and copy rely on internal Pi layout fields and may break after a Pi update. Check these by hand:

1. For Codex and Z.ai, select the model and run `/usage`. Compare the percentage left and reset time with the provider's usage page. For OpenAI subscription models, verify the Codex CLI uses the same ChatGPT account and that the footer says `codex CLI`; these are not app-specific limits.
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
