# Security

## Reporting a problem

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/potterdigital/plan-usage-mod/security/advisories/new) rather than in a public issue. You can expect a first reply within a week.

## What this mod can do

A Claude Code mod runs with your permissions inside Claude Code and is not sandboxed, so it is worth knowing exactly what this one touches. `claude plugin validate .` prints the full list from the source. In short:

- It reads the plan-limit figures Claude Code already holds and the `CLAUDE_CONFIG_DIR` environment variable.
- It writes its last reading to its own file in Claude Code's plugin store.
- With the optional pause turned on, it refuses tool calls during a pause, ends the running turn, and later sends one prompt you can configure.
- It makes no network requests, reads no other files or environment variables, and calls no model.
