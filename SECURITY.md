# Security

## Report a suspected vulnerability

Do not post credentials, personal data, private infrastructure details, exploit payloads, or a working reproduction of a vulnerability in a public issue, pull request, or discussion.

Check the repository's [Security page](https://github.com/LukeJiaoR/yuva-agent-starter/security). If GitHub offers **Report a vulnerability**, use that private reporting flow. A private reporting channel is not currently documented in this repository; do not assume a public issue is private.

If no private reporting option is available, open a minimal [issue](https://github.com/LukeJiaoR/yuva-agent-starter/issues) asking the maintainer to provide a private security contact. Include only that you have a security report to share. Wait for a private channel before sending technical details or affected data.

A private report should include the affected commit/core version, impact, prerequisites, and a minimal reproduction using synthetic data. Do not send active credentials. If a credential was exposed, its owner should revoke or rotate it; deleting a file does not remove copies from Git history or releases.

## Run the template safely

- The Compose stack and `.env.example` values are for local development. Do not deploy the sample credentials or expose guest access publicly.
- Keep real environment files and secrets out of Git. `VITE_*` values are public browser configuration.
- Production requires a real identity configuration, controlled CORS origins, HTTPS, scoped database access, and `ALLOW_DEV_GUEST=false`.
- Review domain input, output validation, retention, logging, and provider data handling for your product.
- Use disposable databases and synthetic data for tests. Never copy production data into a public issue or a fixture.
- Follow the [deployment checklist](docs/deployment.md) and [core upgrade process](docs/releases.md). Verify the version and commit actually installed in your application when assessing a fix.

The starter provides reusable mechanisms. Each deployed application remains responsible for its own configuration, integrations, and data handling.
