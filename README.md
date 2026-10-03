# apple-pi

A UI and workflow extension for [Pi](https://github.com/earendil-works/pi). It adds provider usage, local reset times, a custom footer, and transcript controls. Pi loads it directly from your Git clone.

## Features

- Provider usage for Codex and Z.ai: percentage left, a usage bar, a reset countdown, and the local reset time. Extra Codex quota windows appear when the provider reports them. A failed refresh keeps the last good numbers and adds a "showing last result" line. Other providers show "no usage endpoint".
- A footer with the directory, Git branch, session name, token use, cost, context use, model, thinking level, and extension status.
- Small titles above tool calls, assistant replies, and thinking blocks. Built-in tool results and expand/collapse controls stay in place.
- A **previous message** button above the fullscreen editor.
- Fullscreen copy that joins transcript-wrapped lines while keeping intentional line breaks.

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

## Usage and checks

The footer fetches usage at session start. It also refreshes after the agent settles and when the model changes, at most once a minute per provider. `/usage` forces a refresh. The countdown is recalculated on every footer render; there is no separate timer.

Run the tests from the repository root, across time zones:

```bash
pnpm test
TZ=Asia/Singapore pnpm test
TZ=America/New_York pnpm test
TZ=UTC pnpm test
```

The tests use the jiti compiler and TUI helpers from a global `@earendil-works/pi-coding-agent` (found through `pnpm root -g` or `npm root -g`; set `PI_PACKAGE_DIR` for another location). Credentials and HTTP responses are mocked, so no provider requests happen. They cover reset formats, footer widths, both providers, stale data after a failed refresh, tool registration with Pi's settings, and the copy reflow rules.

They do not cover live provider endpoints or mouse and copy behavior in a terminal. Fullscreen navigation and copy rely on internal Pi layout fields and may break after a Pi update. Check these by hand:

1. For Codex and Z.ai, select the model and run `/usage`. Compare the percentage left and reset time with the provider's usage page.
2. In fullscreen mode, select a paragraph that wraps across several lines and paste it into another app. Done when the paragraph has no extra line breaks and intentional paragraph breaks remain.
3. Scroll past an earlier user message and click **previous message**. Done when it returns you to that message.

Raw provider responses and clipboard contents stay out of Git. A provider with no login is untested, not a failed check.

## Remove

From the cloned `apple-pi` folder (elsewhere, pass the registered clone path):

```bash
pi remove .
```

This removes the package registration and keeps your Git repository. Then run `/reload` in Pi.
