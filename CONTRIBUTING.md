# Contributing

Issues and pull requests are welcome. For anything larger than a small fix, please open an issue first so we can agree on the approach.

## Working on the mod

1. Clone the repository and start Claude Code on it: `claude --plugin-dir .`. The mod reloads each time you save a file, and Claude Code writes the type declarations for your version into `.claude-plugin/types/`.
2. Before you open a pull request, run:

   ```sh
   claude plugin test .
   claude plugin validate --strict .
   prettier --check .
   npx -p typescript tsc -p .
   ```

## Tests

- Each test names the regression it guards in a `// GUARDS:` comment.
- Tests fake only what Claude Code answers and the clock (`claude-code/testing`).
- Keep the suite fast: it runs in under a second today.

## Style

- TypeScript, strict, no `any`.
- Formatting comes from Prettier with the repository's `.prettierrc.json`.
- User-facing text is plain language, and any level or state is shown by an icon and a word as well as color.
