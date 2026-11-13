# Contributing to Emuly

Thank you for your help. Issues and pull requests are welcome.

## Report a bug or ask for a feature

Open an [issue](https://github.com/codewarnab/emuly/issues). Tell us:

- what you did,
- what you expected,
- what happened instead (logs or screenshots help).

Do not report security problems in a public issue. Open a private
[security advisory](https://github.com/codewarnab/emuly/security/advisories/new) instead.

## Set up the project

Follow [Run it locally](README.md#run-it-locally). You need Node 26, pnpm and your own GitHub OAuth App.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Keep each pull request small and about one topic.
3. Add or update tests in `lib/**/*.test.ts` when you change behavior.
4. Run the checks:

   ```sh
   pnpm lint
   pnpm test
   pnpm build
   ```

5. Open a pull request. Explain what changed and why.

## Code rules

- This project uses Next.js 16. Its APIs differ from older versions. Read the docs in
  `node_modules/next/dist/docs/` before you use a Next.js API.
- Put schema changes in a new migration in `lib/data/migrations.ts`. Never edit an old migration.
- Never log tokens, secrets or OAuth codes.
- Encrypt new secret columns with `seal` from `lib/auth/crypto.ts`, and add them to `lib/auth/reencrypt.ts`.
- Ask GitHub for no OAuth scope beyond `codespace` unless a feature needs it and the user opts in.

## License

By contributing, you agree that your work is licensed under the [MIT License](LICENSE).
