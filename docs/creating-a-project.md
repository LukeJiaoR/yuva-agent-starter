# Creating a project

The generator turns this repository into an independent starting point. Run it from a clone of `yuva-agent-starter`:

```bash
npm run create -- customer-support-agent \
  --domain "Customer support" \
  --domain-key support \
  --description "An evidence-grounded support assistant" \
  --install
```

## Options

| Option | Meaning |
| --- | --- |
| positional name | npm package name and default output directory |
| `--target <path>` | Explicit destination directory |
| `--domain <label>` | Human-readable vertical or use case |
| `--domain-key <key>` | Lowercase key stored in API configuration |
| `--description <text>` | Web app description |
| `--install` | Run `npm ci` after copying |

The destination must be absent or empty. The generator refuses to write inside the starter source tree and never copies `.git`, dependency directories, local secrets, builds, or coverage output.

## Generated configuration

- Root `package.json` and lockfile receive the new package name.
- `starter-app/.env` is created from the safe development example.
- `starter-web/.env` receives the local product name and description.
- `starter-web/.env.production` receives the same public Vite values for container and production builds. It must never contain secrets because `VITE_*` values are shipped to browsers.
- `.starter.json` records the starter source and domain metadata.

## First-run checklist

```bash
cd customer-support-agent
npm ci                    # omit if --install was used
docker compose up -d postgres
npm run db:setup
npm run dev
```

Then complete the [customization checklist](customization.md), replace the README with product-specific instructions, create a fresh Git repository, and run `npm run check` before the first commit.
