# Project Context: apple-pi

## Project
- Personal Pi UI/workflow extension loaded directly from `extensions/apple-pi.ts`; no build step.
- Verification recipe: run `pnpm test` with globally installed Pi (or `PI_PACKAGE_DIR`). Tests mock credentials/HTTP. For the live footer, run `/reload` then `/usage` in Pi; confirm the source label and compare quota with the corresponding account's usage page. No background service is started.

## Current state
- OpenAI subscription quota support is implemented; no PRD was created for this user-requested change.
- The footer keeps the `codex CLI` source label without a separate account/app-limit warning line; caveats remain in README.
- Full-suite verification after review fixes and the selector-test update: 101/101 passed, including all nine OpenAI tests. The old real-selector test assumed displaced dialogs could never settle; Pi 1.4.0 now stacks dialogs. Its replacement drives two concurrent guard calls through Pi's real selector lifecycle and verifies ordered allow/block decisions, editor restoration, and status cleanup. Live rendering after `/reload` is not yet verified.
- Answered 2026-10-23: Pi usage on `openai` does move the Codex CLI 5-hour percentage (one Pi turn took it from 0% to 1%).

## Key decisions
- New OpenAI subscription tokens cannot read the Codex quota endpoint (locally verified HTTP 401). Use an existing, separately authorized Codex CLI credential only to read quota (footer display and auto-resume timing); never refresh/write it or change inference authentication.
- Do not alias `openai` to the Codex fetcher or send its token/API keys to `wham/usage`; the direct token is rejected and API keys must never go there.
- Auto-resume (all providers): the error's retry hint wins. Otherwise it waits until one minute after the first main quota window reset, at any usage level: usually the 5-hour reset, or the weekly reset if that comes first (it also resets the 5-hour window). OpenAI subscriptions read this from the Codex CLI quota. The 2026-10-23 observations below are the evidence.

## Endpoint findings (2026-10-23)
Read-only checks against installed Pi 1.4.0; no credentials changed or refreshed, no inference request made.

| Credential/request | Result |
| --- | --- |
| Pi `auth.json` entry `openai` | `type: oauth`, scope includes `chatgpt.tokens.use.direct` |
| New token's JWT | audience `https://api.openai.com/v1`; auth claim has `per_user_salt`, `encrypted_auth_metadata`, no plain `chatgpt_account_id` (so account matching with the CLI is not possible) |
| New token → `GET https://chatgpt.com/backend-api/wham/usage` | HTTP 401, `rejected_by_access_enforcement` / `no_matching_rule` |
| New token → `GET https://api.openai.com/v1/models` | HTTP 200; no limit/quota/usage/retry-after headers |
| Codex CLI token (`~/.codex/auth.json`, `auth_mode: chatgpt`) → `wham/usage` | HTTP 200; primary and secondary windows |

OpenAI's Sign in with ChatGPT docs ([errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)):
- Usage is charged to the user's ChatGPT plan, and "an app-specific limit can also apply". They never say this is the same pool as Codex limits.
- No quota endpoint, header, or stream event is documented. For `subscription_sharing_usage_limit_exceeded` (429): "Do not assume the entire plan is empty or infer a reset time from this code alone"; link to ChatGPT settings → Usage.
- [openai/codex#54219](https://github.com/openai/codex/issues/54219) requests a supported endpoint and reports the same rejection; open with no maintainer resolution when checked. If an endpoint ships, switch to it.
- Pi's provider sources: [openai.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/openai.ts), [openai-chatgpt.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-chatgpt.ts).

## Live observation: Subscription Sharing limit (2026-10-23)
- Pi on `openai` / `gpt-6-astra` failed at 16:51:59 and 17:07:05 (+08) with "reached their Subscription Sharing usage limit", with no retry hint. The Codex CLI `wham/usage` response at 17:09 said `limit_reached: false`, `allowed: true`, model available, 5-hour 98% used (reset 20:07), weekly 19% used. So the CLI did not report a block, but Pi was blocked.
- The footer's "Auto-resume at 17:37" was the 15→30 minute backoff, not a reset. It now reads `Auto-resume retry at … · reset time unknown` for backoff deadlines.
- Result: Pi retries at 17:37, 18:37 and 19:37 failed with the CLI 5-hour window at 98%. The CLI window reset at 20:07, and the 20:37 retry succeeded and moved the CLI meter from 0% to 1%. So the Subscription Sharing limit follows the CLI 5-hour window and cuts in near 98%. Retrying at the CLI reset would have resumed 30 minutes sooner. The limit cleared somewhere between 19:37 and 20:37, and 20:07 is the only known change in that span.
- Second limit at 22:33:49: the CLI showed 5-hour 100% used, `allowed: false`, `limit_reached: true`, `gpt-6-astra` unavailable until 01:37:44. The first version only used the CLI reset when it came before the next backoff retry, so the footer said `retry 22:49 · reset time unknown` beside a 01:37 reset. Fixed: the CLI reset is now the deadline itself.
- Live confirmation: after `/reload`, the next message failed at 22:40:51 and was scheduled for the CLI reset. With no failed retries in between, Pi sent `continue` at 01:38:44.036 (reset 01:37:44 + 1 minute) and it succeeded, with the queued message in context. CLI 5-hour usage then started a new window.

## Runbook: footer reset vs auto-resume time disagree
1. Find the real error: `grep 'stopReason":"error' ~/.pi/agent/sessions/<project>/*.jsonl` and read `errorMessage` and the timestamp. Does it carry "Try again in ~N"?
2. Find where the deadline came from. A hint gives failure time + N + 1 minute. Otherwise fresh usage gives the first main-window reset + 1 minute (for `openai`, from the Codex CLI quota). Otherwise it is the 15/30/60-minute backoff, measured from each failed retry. A status line ending in `· reset time unknown` means backoff; without it, the time came from the error hint or the quota.
3. Read the raw quota: `GET https://chatgpt.com/backend-api/wham/usage` with the CLI token. Check `limit_reached`, `model_usage`, and `additional_rate_limits` as well as the windows the footer shows.
4. If the error comes from a meter the footer doesn't show (such as Subscription Sharing), the footer and the auto-resume time measure different things. Don't wire one into the other without observing when the limit actually clears.

## Notes / gotchas
- `CODEX_HOME` overrides `~/.codex` for the optional CLI credential. Verify that CLI and Pi sign-ins use the same account; automatic account matching is not established.
- A CLI login kept in the OS credential store (`cli_auth_credentials_store` = `keyring`, or `auto` with a store available) has no `auth.json` and is reported as missing.
- Ordinary OpenAI API-key configurations do not read CLI credentials or send quota requests.
