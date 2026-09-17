# Documentation

Use these guides in order when creating a product:

1. [Quickstart](quickstart.md): run the included app locally.
2. [Creating a project](creating-a-project.md): generate an independent repository.
3. [Customization](customization.md): replace the example domain safely.
4. [API reference](api.md): call the HTTP and SSE contracts.
5. [Testing](testing.md): run unit, database, HTTP, and build checks.
6. [Deployment](deployment.md): prepare a production environment.

The system shape and package boundaries are documented in [Architecture](../ARCHITECTURE.md).

## Supported baseline

- Recommended runtime: Node.js 24
- Compatibility runtime: Node.js 22
- Package manager: npm 10
- Database: PostgreSQL 16+
- Browser UI: current Chrome, Edge, Firefox, and Safari releases

## Source of truth

Executable code, `.env.example`, `scripts/schema.sql`, `scripts/migrations/`, release manifests, and CI are authoritative. If a guide differs from the implementation, treat that as a documentation bug and update both in the same change.

Pricing and lifecycle contracts: [Operations, pricing and settlement](architecture/pricing-and-settlement.md).

Core ownership and extension seams: [Core ownership](architecture/core-ownership.md).

Core release and upgrade procedure: [Private versioned artifacts](releases.md).

Consumer upgrade evidence and ownership: [Consumer migrations](maintenance/consumer-migration.md).

Runtime configuration, service lifecycle and backup/restore: [Operations](maintenance/operations.md).

Durable usage and provenance: [Usage](architecture/usage.md).
