# Vertical AI Agent SaaS Starter (`yuva-agent-starter`)

A production-grade, modular, and domain-agnostic starter template for bootstrapping Vertical AI Agent SaaS applications.

Built on **Hexagonal Architecture (Ports & Adapters)**, this template provides battle-tested infrastructure packages for credit billing, context budgeting, streaming runtime, identity auth, and admin auditing.

---

## 🚀 Key Features

- **Hexagonal Agent Runtime (`@yuva/ai-engine`)**: Multi-provider streaming (OpenAI, DeepSeek, Claude, Ollama, Qwen), dynamic context allocation, token metering, semantic hallucination checks, idempotency, and SSE terminal replay.
- **Atomic Credit Ledger (`@yuva/billing-core`)**: Pre-reserve, settle on completion, and auto-release on failure with strict database concurrency controls.
- **Dynamic Context Planner (`@yuva/context-engine`)**: Intelligent token budgeting, priority scoring, and message truncation.
- **Enterprise Auth & Security (`@yuva/auth-core`)**: Signed session tokens, Clerk identity binding, rate limiting, and response payload redaction.
- **Zero Domain Leakage**: 100% decoupling between infrastructure engines and domain business logic.

---

## 📁 Repository Structure

```text
yuva-agent-starter/
├── packages/
│   ├── ai-engine/         # Generic Agent Runtime & Stream Emitters
│   ├── context-engine/    # Dynamic Token Budgeting & Priority Planner
│   ├── billing-core/      # Atomic Credit Ledger & Reservation State Machine
│   ├── auth-core/         # Token Security & Clerk Auth Middleware
│   └── admin-core/        # Financial Audit & Admin Control Guards
├── starter-app/
│   ├── server/
│   │   ├── domain/        # 🎯 Customization Point: Domain Adapter, Prompts, Pricing
│   │   ├── routes/        # Express API Routes (chatStream, analyze, health)
│   │   ├── db/            # Standard PostgreSQL pool (pg)
│   │   └── index.js       # Composition Root
│   └── tests/             # Unit & Integration Tests
└── scripts/
    ├── verify-boundaries.mjs # Domain Leakage Boundary Checker
    └── schema.sql         # Production PostgreSQL Schema
```

---

## ⚡ Quickstart

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` inside `starter-app/`:

```bash
cp starter-app/.env.example starter-app/.env
```

Set your database and OpenAI/DeepSeek API credentials:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/starter_agent_db
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
```

### 3. Initialize Database

Run the provided PostgreSQL schema against your database:

```bash
psql $DATABASE_URL -f scripts/schema.sql
```

### 4. Run Development Server

```bash
npm run dev
```

The server will start at `http://localhost:3000`.

---

## 🎨 How to Build Your Vertical AI Agent SaaS

To customize this starter for your specific vertical domain (e.g. Legal, Medical, Astrology, Finance, Tarot):

1. **Implement Domain Facts (`starter-app/server/domain/adapter.js`)**:
   - Update `computeFacts(input)` to run your deterministic calculations or domain heuristics.
2. **Define Prompt Grounding (`starter-app/server/domain/prompts.js`)**:
   - Customize `formatSystemPrompt()` and `formatAnalysisPrompt()` to inject domain facts and constrain model behavior.
3. **Configure Pricing (`starter-app/server/domain/pricing.config.js`)**:
   - Set credit costs for quick analysis and conversational streaming queries.

---

## 🧪 Testing & Quality Gates

Run all package unit tests and starter integration tests:

```bash
npm test
```

Verify that no domain-specific code leaks into the core engine packages:

```bash
npm run verify:boundaries
```

---

## 📜 License

MIT
