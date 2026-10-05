# Contributing

Issues and pull requests are welcome. For anything larger than a small fix, please open an issue first so we can agree on the approach.

## Working on the mod

1. Clone the repository and start Claude Code on it: `claude --plugin-dir .`. The mod reloads each time you save a file, and Claude Code writes the type declarations for your version into `.claude-plugin/types/`.
2. Before you open a pull request, run:

   ```sh
   claude plugin test .
   claude plugin validate --strict .
   npx prettier --check .
   npx -p typescript tsc -p .
   ```

A reload restarts the module but keeps the session's `$.state`, so the reading and any pause carry over. A tool call that is running when you save finishes in the old copy of the module; avoid saving mid-pause if you are testing the pause.

## Tests

- Each test names the regression it guards in a `// GUARDS:` comment.
- Tests fake only what Claude Code answers and the clock (`claude-code/testing`).
- Keep the suite fast: under 3 seconds.
- Every behavior the README promises has a test that fails when the code behind it is removed. To test what survives a hot reload or `/clear`, answer the `state.get` event in the test (`on('state.get', ($, e) => ({ value: { value: saved, version: 1 } }))`); the kit loads the module fresh for each test.

## CI

CI checks every push and pull request against the Claude Code version in the README, and runs weekly against the newest release. GitHub turns scheduled runs off after 60 days without activity in a repository; re-enable the workflow or run it by hand from the Actions tab.

## Style

- TypeScript, strict, no `any`.
- Formatting comes from Prettier with the repository's `.prettierrc.json`.
- User-facing text is plain language, and any level or state is shown by an icon and a word as well as color.
