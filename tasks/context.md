# Project Context: apple-pi

## Project
- Personal Pi UI/workflow extension loaded directly from `extensions/apple-pi.ts`; no build step.
- Verification recipe: run `pnpm test` with globally installed Pi (or `PI_PACKAGE_DIR`). Tests mock credentials/HTTP. For the live footer, run `/reload` then `/usage` in Pi; confirm the source label and compare quota with the corresponding account's usage page. No background service is started.

## Current state
- OpenAI subscription quota support is implemented; no PRD was created for this user-requested change.
- The footer keeps the `codex CLI` source label without a separate account/app-limit warning line; caveats remain in README.
- All nine OpenAI tests pass. The existing real-selector test still fails against Pi 1.4.0 and is being repaired separately. Live rendering after `/reload` is not yet verified.
- Open question: whether Pi usage on an `openai` subscription model moves the Codex CLI percentage at all. Check by noting the percentage, running a few Pi turns, then `/usage`. If it never moves, revert to the plain "no usage endpoint" note with the `https://chatgpt.com/settings/usage` link.

## Key decisions
- New OpenAI subscription tokens cannot read the Codex quota endpoint (locally verified HTTP 401). Use an existing, separately authorized Codex CLI credential only for display; never refresh/write it or change inference authentication.
- Do not alias `openai` to the Codex fetcher or send its token/API keys to `wham/usage`; the direct token is rejected and API keys must never go there.
- Codex CLI quota is not evidence of the new flow's app-specific reset time. Its separate cache is explicitly excluded from OpenAI auto-resume scheduling.

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

## Notes / gotchas
- `CODEX_HOME` overrides `~/.codex` for the optional CLI credential. Verify that CLI and Pi sign-ins use the same account; automatic account matching is not established.
- A CLI login kept in the OS credential store (`cli_auth_credentials_store` = `keyring`, or `auto` with a store available) has no `auth.json` and is reported as missing.
- Ordinary OpenAI API-key configurations do not read CLI credentials or send quota requests.
