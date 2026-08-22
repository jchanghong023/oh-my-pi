# Fork-specific behavior

## Development branch

- Make fork-specific development changes on the `dev` branch by default, not `main`.
- Commit and push completed fork work to `origin/dev` unless an explicit task requires another branch.

## Provider allow-list

- This fork uses the positive `enabledProviders` allow-list and does not use the upstream `disabledProviders` blacklist.
- `disabledProviders` is rejected as a configuration error so stale upstream configuration cannot silently weaken the allow-list.
- The default enabled providers, in order, are `opencode-go`, `opencode-zen`, `openai-codex`, and `deepseek`.
- Every provider not listed is closed by default, including future upstream providers.
- API keys and OAuth credentials cannot bypass `enabledProviders`.
- `/login` authenticates a provider only; it never enables one.
- Bundled, custom, runtime-discovered, extension-registered, and implicit-local model providers use this same allow-list.
- This is a long-term fork constraint and must be retained when merging or rebasing upstream.
