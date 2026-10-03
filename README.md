# apple-pi

Personal UI and workflow changes for [Pi](https://github.com/earendil-works/pi). Keep the code in this Git repository and load it directly on each computer. No extension copies or symbolic links are needed.

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

Windows shorter than one day show time only, even across midnight. Daily, weekly, monthly, and unknown windows show the weekday, date, and time. Narrow layouts use extra lines instead of cutting off the reset time. Missing timestamps show no reset details; passed timestamps show `resets now` with the scheduled time until fresh data arrives.

## Install on each computer

Use `@earendil-works/pi-coding-agent`, not a different Pi fork. This extension has been checked with Pi 1.0.0. Pi supplies its runtime dependencies; no build or `pnpm install` step is needed for this local package.

Clone this repository to a directory of your choice. For example:

```bash
mkdir -p ~/Documents/Git
git clone https://github.com/kelvinz/apple-pi.git ~/Documents/Git/apple-pi
pi install ~/Documents/Git/apple-pi
pi list
```

If the repository is private, Git must have access to your GitHub account. If you have already cloned it, skip the clone command and register its existing path.

Pi records the local package path in `~/.pi/agent/settings.json`. It loads `extensions/apple-pi.ts` from this repository without copying it into `~/.pi/agent/extensions/`.

After registration, remove any old standalone `~/.pi/agent/extensions/apple-pi.ts` so the extension does not load twice. Run `/reload` in an open Pi session, or start a new session.

### Provider access

Sign in separately on each computer with Pi's `/login` command for Codex. Z.ai uses Pi's saved `zai` API key or the `ZAI_API_KEY` environment variable. Only the provider for the active model is queried.

Do not commit or sync Pi credentials, sessions, or machine settings through this repository.

## Sync changes

Edit `extensions/apple-pi.ts` in this repository, not a file under `~/.pi/agent/extensions/`.

On the computer where you made changes:

```bash
cd ~/Documents/Git/apple-pi
pnpm test
git add extensions tests README.md package.json .gitignore
git commit -m "Update apple-pi"
git push
```

On the other computer:

```bash
cd ~/Documents/Git/apple-pi
git pull --ff-only
```

Then run `/reload` in Pi. Commit and push local changes before switching computers. If `git pull --ff-only` fails, resolve the Git changes instead of overwriting either copy.

Local package updates use `git pull`; `pi update --extensions` does not pull this working repository.

## Usage and checks

The footer fetches usage at session start. It also refreshes after the agent finishes a run and when the model changes, with a minimum one-minute gap per provider for those automatic refreshes. `/usage` forces a refresh. The countdown is recalculated whenever the footer renders; there is no separate timer.

Run the tests from the repository root:

```bash
pnpm test
TZ=Asia/Singapore pnpm test
TZ=America/New_York pnpm test
TZ=UTC pnpm test
```

The tests require Node.js and a global pnpm installation of `@earendil-works/pi-coding-agent`. They use Pi's installed TypeScript compiler and TUI helpers. Credentials and HTTP responses are mocked; the tests make no provider requests.

Tests cover reset formats, midnight, expired and missing timestamps, both providers, extra Codex quota windows, narrow layouts, styled text, and the automatic fetch gap. They do not verify live provider endpoints or mouse/copy behavior in a terminal. Fullscreen navigation and copy use internal Pi layout fields and may need changes after a Pi update.

## Files

```text
apple-pi/
├── extensions/apple-pi.ts
├── tests/apple-pi-reset.test.mjs
├── package.json
├── README.md
└── .gitignore
```

## Remove

```bash
pi remove ~/Documents/Git/apple-pi
```

Use the path you registered if it is different. This removes the package registration, not your Git repository. Then run `/reload` in Pi.
