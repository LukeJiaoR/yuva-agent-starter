# Architecture & Ports Specification

This repository follows **Hexagonal Architecture (Ports & Adapters)** to decouple infrastructure orchestration from domain-specific business rules.

---

## 🏛️ Hexagonal Topology

```text
                     +---------------------------------------+
                     |             Incoming HTTP             |
                     |         (POST /api/chat/stream)       |
                     +-------------------+-------------------+
                                         |
                                         v
+---------------------------------------------------------------------------------+
|                                 AgentRuntime                                    |
|                                                                                 |
|   +-------------------+   +--------------------+   +------------------------+   |
|   |   billingPort     |   |    domainPort      |   |      contextPort       |   |
|   |  - getRequest     |   |  - prepare         |   |  - resolveContext      |   |
|   |  - reserve        |   +--------------------+   +------------------------+   |
|   |  - settle         |                                                         |
|   |  - release        |   +--------------------+   +------------------------+   |
|   +-------------------+   |    promptPort      |   |     validationPort     |   |
|                           |  - formatPrompt    |   |  - validate            |   |
|   +-------------------+   +--------------------+   +------------------------+   |
|   |    streamPort     |                                                         |
|   |  - createEmitter  |   +--------------------+   +------------------------+   |
|   |  - streamText     |   |    memoryPort      |   |     telemetryPort      |   |
|   |  - replayExisting |   +--------------------+   +------------------------+   |
|   +-------------------+                                                         |
+---------------------------------------------------------------------------------+
```

---

## 🔌 The 7 Runtime Ports

| Port | Responsibility | Implemented By |
|---|---|---|
| **`domainPort`** | Validates incoming domain input, computes deterministic facts, resolves entities. | `DomainKnowledgeAdapter` |
| **`contextPort`** | Calculates token budgets, priorities, and truncates historical messages. | `@yuva/context-engine` |
| **`promptPort`** | Formats system and user prompts with injected verified facts. | `DomainPrompts` |
| **`billingPort`** | Pre-reserves credits, settles upon completion, releases upon failure, handles replay. | PostgreSQL `credit_usage_requests` |
| **`streamPort`** | Manages SSE headers, writes formatted stream events, handles LLM streaming. | `@yuva/ai-engine` `StreamEmitter` |
| **`validationPort`** | Performs semantic post-generation validation before terminal delivery. | Custom domain validator |
| **`telemetryPort`** | Traces request lifecycle and failure classifications. | Logger / OpenTelemetry |

---

## 🔄 Lifecycle Sequence

1. **Idempotency Check**: `billingPort.getRequest()` checks if the request was previously settled (SSE replay) or is currently generating (HTTP 202).
2. **Domain Preparation**: `domainPort.prepare()` computes deterministic facts and generates an immutable snapshot.
3. **Credit Reservation**: `billingPort.reserve()` checks balances and reserves credits with row-level locks.
4. **Context & Prompt Resolution**: `contextPort.resolveContext()` builds the token budget; `promptPort.formatPrompt()` creates the prompt.
5. **SSE Stream Execution**: `streamPort.createEmitter()` sends the `start` event, followed by `text_delta` chunks.
6. **Semantic Validation**: `validationPort.validate()` checks output safety.
7. **Credit Settlement**: `billingPort.settle()` meters tokens and debits credits.
8. **Terminal Delivery**: `streamPort` emits `usage` and `done` events.
