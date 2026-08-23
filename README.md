# Vertical AI Agent SaaS Starter (`yuva-agent-starter`)

A production-grade, modular, and domain-agnostic starter template for bootstrapping Vertical AI Agent SaaS applications.

Built on **Hexagonal Architecture (Ports & Adapters)**, this template provides battle-tested infrastructure packages for credit billing, context budgeting, streaming runtime, identity auth, and admin auditing.

---

## 🚀 Key Architectural Highlights

- **Request-Scoped Agent Streaming (`@yuva/ai-engine`)**: Multi-provider streaming (OpenAI, Anthropic, DeepSeek, Ollama), dynamic context allocation, token metering, Buffered Delivery Hook & Validation Extension Point (createDelivery push/flush protocol), and SSE terminal replay. Zero shared closure state across concurrent requests.
- **Two-Phase Credit Ledger (`@yuva/billing-core`)**: Atomic pre-reservation, completion settlement, and automatic error release with PostgreSQL row locks (`FOR UPDATE`).
- **Dynamic Context Planner (`@yuva/context-engine`)**: Priority-based token budgeting (`allocateContextBudget`) across system facts, user queries, and historical conversation turns.
- **Enterprise Auth & Security (`@yuva/auth-core`)**: Clerk JWT verification, signed session tokens, rate limiting, and response payload redaction.
- **Zero Domain Leakage**: 100% decoupling between infrastructure core packages and domain business logic.

---

## 📁 Repository Structure

```text
yuva-agent-starter/
├── packages/
│   ├── ai-engine/         # Generic Agent Runtime, Stream Emitter & Provider Adapters
│   ├── context-engine/    # Dynamic Token Budgeting & Priority Allocation
│   ├── billing-core/      # Atomic Credit Ledger & Two-Phase Reservation State Machine
│   ├── auth-core/         # Token Security, Clerk Auth Middleware & Response Hardening
│   └── admin-core/        # Financial Audit Logging & Admin Controls
├── starter-app/
│   ├── server/
│   │   ├── domain/        # 🎯 Customization Point: Domain Adapter, Prompts, Pricing
│   │   │   ├── adapter.js         # Deterministic calculations & SHA256 snapshot
│   │   │   ├── pricing.config.js  # Feature pricing & credit costs
│   │   │   └── prompts.js         # Domain prompt templates
│   │   ├── routes/        # Express API Routes (chatStream, analyze, health)
│   │   ├── db/            # Standard PostgreSQL pool (pg)
│   │   └── index.js       # Composition Root
│   └── tests/             # Comprehensive Integration Tests
└── scripts/
    ├── verify-boundaries.mjs # Domain Leakage Boundary Checker
    └── schema.sql         # Production PostgreSQL Schema (Accounts, Grants, Ledger)
```

---

## ⚡ Quickstart

### Prerequisite

- Node.js 24 LTS is the default development and production runtime.
- The reusable core packages are continuously verified on Node.js 22 and 24.

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` inside `starter-app/`:

```bash
cp starter-app/.env.example starter-app/.env
```

Set your database and OpenAI/Anthropic/DeepSeek API credentials:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/starter_agent_db
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
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
