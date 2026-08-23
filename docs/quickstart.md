# Quickstart

## Host development

1. Create the local API configuration:

   ```bash
   cp starter-app/.env.example starter-app/.env
   ```

2. Install exactly the locked dependencies:

   ```bash
   npm ci
   ```

3. Start PostgreSQL. The included defaults expect `postgresql://starter:starter@localhost:5432/starter_agent`:

   ```bash
   docker compose up -d postgres
   ```

4. Create the tables and local guest account:

   ```bash
   npm run db:setup
   ```

5. Start the API and web app:

   ```bash
   npm run dev
   ```

6. Open `http://localhost:5173`, enter structured domain parameters, and submit a question.

The default mock provider makes the first run deterministic and credential-free. To reset only the processes, stop `npm run dev` and run it again. Database setup is idempotent.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and web development servers |
| `npm run build` | Build every workspace that has a build script |
| `npm run db:migrate` | Apply the idempotent PostgreSQL schema |
| `npm run db:seed` | Create the development guest and initial credits |
| `npm run db:setup` | Migrate, seed, and check the database |
| `npm run db:check` | Verify required tables and functions |
| `npm run check` | Run all automated release gates |

## Use a real model

Edit `starter-app/.env` and select a provider. For an OpenAI-compatible endpoint:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=replace-me
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

Restart the API after changing environment variables.

## Troubleshooting

- `ECONNREFUSED` from `db:setup`: start PostgreSQL and confirm `DATABASE_URL`.
- `not_ready` from `/ready`: the API is alive but cannot query PostgreSQL.
- `insufficient credits`: rerun `npm run db:seed` in development or add a grant through your product flow.
- Browser CORS error: add the exact web origin to the comma-separated `CORS_ORIGIN` value.
- Port already in use: stop the existing service or change the corresponding `PORT`/Vite setting consistently.
