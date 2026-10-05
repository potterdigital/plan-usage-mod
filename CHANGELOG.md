# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-05

### Added

- A line above the prompt with the session and weekly limits, their reset times in your time zone, and a blue OK or orange HIGH level with its own icon and word.
- The `plan_usage` tool and the `/plan-usage` command, which report every limit window as JSON without a model call.
- Sharing of the newest reading between open sessions on the same Claude profile, so idle sessions stay current.
- An optional pause near the session limit that lets running tool calls finish, ends the turn, and continues two minutes after the reset. It runs only in interactive sessions, and a prompt you send while it is in place cancels it until the window resets.
- A first-run question, shown until answered, to choose `show_at`: always, from 50%, from 80%, or a percent you type.
- Settings: `warn_at`, `show_at`, `time_zone`, `auto_pause`, `pause_threshold`, `resume_prompt`.

[0.1.0]: https://github.com/potterdigital/plan-usage-mod/releases/tag/v0.1.0
