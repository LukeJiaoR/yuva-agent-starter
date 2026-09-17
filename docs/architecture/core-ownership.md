# Core ownership and extension contract

Status: adopted for version 1.1.0; consumers migrate via their own PRs.
Owner: repository maintainers. Decision: Epic #15.

The `yuva-agent-starter/packages` tree is the sole editable source of the five
`@yuva/*` components. Consumers install immutable package artifacts by version and
integrity. Product-specific domain code, UI, pricing, schema and deployment state
remain product-owned. Core 1.2.0 adds the completed Epic #1 pricing/recovery contracts; products opt
into the new persistence and composition through their own reviewed changes.

## Reconciled baseline

Compared starter main `55c4495` with product main `4a2f14d` on 2026-09-17.
The former 1.0.0 package labels were unversioned copies, not reliable release IDs.

| Difference | Resolution and evidence |
| --- | --- |
| Runtime prior released request | Preserve `released_retry` and pass existingRequest to product preflight |
| Runtime abort | Preserve product delivery abort callback on upstream failure |
| Deferred delivery | Preserve starter commit callback after settlement; before-settlement failures never commit |
| Buffered OpenAI generation | Use the existing SDK stream reader for gateways requiring streaming; inject stream/modelFactory for testing |
| Model identity | Preserve provider_response/requested_fallback/synthetic_explicit provenance |
| Auth | Preserve injected tokenVerifier through required and optional auth; recognize normalized verifier reason codes without reliance on cross-install instanceof identity |
| Ledger retry | Shared SQL must not reference product-only assistant_text/settled_at; optional transaction-local resetResult hook lets the product reset its own result |
| Other packages | admin-core and context-engine source is identical; public entry points remain compatible |

Cross-consumer runtime tests and auth tests cover the union. Existing ledger
retry tests verify attempt allocations and financial history; staged output tests
verify commit ordering. Package installation tests will protect exports and
isolated dependencies. Product regression is a separate migration gate.

## Components and injection

| Component | Public seam | Default / product responsibility |
| --- | --- | --- |
| auth-core | tokenVerifier, findUser, bootstrapUser, db, env | Clerk default; product owns profile persistence and access rules |
| ai-engine | request/domain/context/prompt/stream/validation/billing/memory/telemetry ports | Product composition supplies required ports; provider factories and fetch are injectable |
| billing-core | db transaction interface, pricing/result callbacks, resetResult | PostgreSQL ledger mechanism; product owns prices, grants and result schema |
| context-engine | units, budget, tokenCounter | Product selects eligible context and privacy rules |
| admin-core | db, actor, action and bounded audit payload | Product owns permissions and management UI |
| Future media | execution and artifact-store ports from Epic #1 contracts | No real media adapter is claimed; OpenAI-compatible images evaluated after #1 |

Ports are trusted server composition, never arbitrary client-selected modules.
Each adapter validates the capabilities and configuration it claims. Missing
required implementations fail explicitly. Do not add a registry/plugin platform
for interfaces already expressed as constructor arguments. Default stacks remain
Node 24 (22 compatible), PostgreSQL 16, Express and React/Vite.

Public exports are package root only (plus package.json for version discovery).
Consumers declare each package they import. The core may import its own files and
declared dependencies, never a product workspace or product singleton. Tests and
source maps may refer to source while the production app imports package names.

## Distribution and schema

This repository is private. Versioned npm tarballs are distributed through a
private GitHub Release, then verified and pinned in the consumer's vendor folder.
Only artifacts are vendored, not editable core source; npm ci requires no GitHub
token in package URLs. The lockfile records package integrity. Source SHA, hashes,
Node versions and schema compatibility travel in a release manifest.

The ledger API remains compatible with both existing product and starter ledger
schemas. Starter operations (introduced by #5) require starter migration 2 only
when used; the complete 1.2.0 starter composition requires migrations 1–6
for operation, usage, budget, settlement and recovery persistence. Existing consumers remain pinned to 1.1.0. Installing a core package never runs SQL, migrates a product database,
changes user prices, or deploys an application. Each product owns its migration
sequence; rollback uses a compatible application version and a tested data restore
plan when needed. A new package release never rewrites historical quotes.

The 1.2.0 release adds settlement/recovery without replacing consumer-owned
schemas or activating media execution. See the versioned release notes.
