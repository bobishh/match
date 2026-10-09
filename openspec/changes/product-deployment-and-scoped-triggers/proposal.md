## Why

Tincanban, Rusty and automation now run as separate products, but their deployment, upgrade and recovery paths are not one reproducible lifecycle. The current integration also grants the Worker workspace-wide read access. People need a useful local-first board before deploying a service, a URL-only path to add blind storage, and explicit, narrow trigger authority that survives retries and concurrent edits.

## What Changes

- Specify independently usable Tincanban, Rusty blind storage and automation products with reproducible local, test and production deployment paths.
- Add declarative, versioned triggers over typed stable CRDT slices. Each trigger names its bounded input projection and exact permitted commands; a CRDT selector is a lens-like stable reference, not a raw pointer or a grant to arbitrary document state.
- Require owner approval, recipient-side causal authorization, idempotent durable execution, reviewable audit and monotonic revocation for trigger actions.
- Replace browser entry of Rusty operator tokens and import-key files with address-based discovery and an explicit service/owner pairing flow.
- Define one current protocol for new deployments. Migration from older deployments is an explicit export, validation and import operation; runtime legacy modes and silent fallback are not part of the target product.
- Define an infrastructure lifecycle using Terraform/OpenTofu for cloud resources, Kamal and container images for Tincanban/Rusty, optional Helm/Kubernetes adapters for the same container contracts, and Wrangler for Workers. Current state is documented separately from this target.
- Require backups and verified recovery before any reset, replacement or destructive data migration, including preserving the user's Jobs board.

## Capabilities

### New Capabilities

- `product-deployment`: Independent product use, repeatable deployment, upgrades, rollback, data durability and recovery across Docker, Cloudflare static hosting, Kamal, optional Helm/Kubernetes, Terraform/OpenTofu and Wrangler.
- `scoped-triggers`: Typed CRDT slice references, minimized trigger projections, exact delegated operations, causal preconditions, durable retries, audit and revocation.

### Modified Capabilities

None. This proposal specifies a broader target lifecycle; it does not claim that missing infrastructure or narrow-projection authorization already exists.

## Impact

This proposal spans tincanban's static build and Rusty integration UI, standalone `../mesh-lighthouse`, Cloudflare Worker runtime in `workers/automation`, and deployment configuration in `../hetzner_playground`. It is a specification change only. Existing implementation evidence is in [blind-keeper-and-scoped-automation](../blind-keeper-and-scoped-automation/implementation.md).
