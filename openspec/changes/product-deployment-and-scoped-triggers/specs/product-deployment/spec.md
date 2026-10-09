## ADDED Requirements

### Requirement: Products work independently
Tincanban SHALL remain usable as a local-first product without a Rusty service, automation Worker, hosted account or network connection for local board operations. Rusty SHALL deploy as a separate blind encrypted-object service. Automation SHALL remain optional and independently deployable.

#### Scenario: Start with the board only
- **WHEN** a user opens a valid local Tincanban build without configured services
- **THEN** the user can create, edit, persist and reopen a board locally
- **AND** no service URL, server account or automation setup is required.

#### Scenario: Add blind storage by address
- **GIVEN** an independently running current-version Rusty service
- **WHEN** the user enters its public address and approves its pinned identity
- **THEN** pairing completes through signed discovery and explicit service/owner approval
- **AND** the UI does not request an admin token, service private key, recovery secret or imported key file.

#### Scenario: Automation absent
- **WHEN** no trigger runtime is configured or available
- **THEN** local board operations and Rusty replication remain usable
- **AND** the UI reports automation as unavailable without implying board failure.

### Requirement: Deployment paths are reproducible and separate
The product SHALL provide Docker images for native/container products and a tested Cloudflare static adapter for Tincanban with equivalent application behavior. Cloudflare Workers SHALL serve the production Tincanban frontend; Wrangler and its application CI SHALL own frontend releases. Kamal SHALL remain the release owner for native Rusty and sink services and their accessories. An optional second-stage Helm/Kubernetes adapter SHALL deploy those same native images and API/protocol contracts. Wrangler SHALL own Worker artifacts, bindings and Worker-managed domains/routes; Terraform/OpenTofu SHALL own declared cloud infrastructure and ordinary DNS records. Exactly one release tool SHALL own each resource in an environment.

#### Scenario: Build static adapters
- **WHEN** the same immutable Tincanban source revision is built for Docker/nginx and Cloudflare static hosting
- **THEN** both serve the same application routes, configured base path, health contract and fingerprinted assets
- **AND** neither publishes server credentials or Worker secrets in browser assets.

#### Scenario: Import existing infrastructure
- **GIVEN** production resources already exist outside Terraform/OpenTofu state
- **WHEN** the first infrastructure plan is prepared
- **THEN** resources are imported and the plan shows no unexpected replacement or deletion
- **AND** apply remains blocked until the reviewed plan, state recovery and locking are ready.

#### Scenario: Optional Kubernetes adapter
- **GIVEN** the same immutable Tincanban and Rusty container images used by the Docker/Kamal path
- **WHEN** an operator installs the optional Helm charts in an isolated Kubernetes environment
- **THEN** health, configuration, persistence and external API/protocol behavior match the container contracts
- **AND** Helm deploys no Cloudflare Worker resources or Durable Objects.

#### Scenario: No dual workload owners
- **GIVEN** Kamal currently owns a production workload
- **WHEN** an operator evaluates migration to Helm
- **THEN** migration first transfers ownership in an explicit reviewed procedure
- **AND** Kamal and Helm never concurrently reconcile the same workload, route or persistent volume.

#### Scenario: Isolated test environments
- **WHEN** CI or staging runs product integration tests
- **THEN** it uses isolated hostnames, Worker/DO state, Rusty volumes and test credentials
- **AND** test traffic cannot mutate production boards or storage.

### Requirement: Release and recovery preserve durable user data
Every release SHALL record source revision, immutable artifact identity, protocol/schema version and infrastructure plan. Before destructive reset, volume replacement or incompatible migration, operators SHALL verify an independent backup and restore path. The user's Jobs board and authority evidence MUST be preserved before any reset.

#### Scenario: Restore before replacing a volume
- **GIVEN** Rusty storage is scheduled for reset or replacement
- **WHEN** no independent backup has passed an isolated restore and object-integrity check
- **THEN** the reset is blocked
- **AND** existing data remains untouched.

#### Scenario: Verify restored board
- **GIVEN** a backup includes board history, authorization evidence and encrypted storage metadata
- **WHEN** it is restored in an isolated environment
- **THEN** inventory and object hashes match the backup manifest
- **AND** a second authorized client can reopen and validate the Jobs board before production cutover.

#### Scenario: Roll back incompatible data change
- **GIVEN** a release writes a durable format an older artifact cannot read
- **WHEN** the application release is rolled back
- **THEN** writers stop and the operator restores a matching data backup or completes a forward-compatible migration
- **AND** the older artifact is never pointed at unknown newer state.

### Requirement: Runtime scaling respects storage and execution ownership
Rusty SHALL enforce one active writer for a local persistent volume. Multiple Rusty replicas MUST NOT write the same local volume. Scaling beyond one Rusty writer SHALL require deterministic scope sharding with one exclusive volume per shard, or a separately specified and tested transactional shared-storage backend with fencing and recovery. Automation SHALL serialize writes by workspace using a durable fenced generation. Capacity limits and backpressure SHALL be observable and SHALL NOT discard accepted durable work.

#### Scenario: Second Rusty writer
- **WHEN** a second Rusty process tries to open the same writable state volume
- **THEN** it fails before accepting writes.

#### Scenario: Scale Rusty replicas
- **GIVEN** an operator requests more than one Rusty replica
- **WHEN** the deployment uses a local-volume backend without a proven shared-storage protocol
- **THEN** deployment validation requires explicit non-overlapping scope shards and one exclusive volume per shard
- **AND** rejects configurations that mount one writable Rusty volume into multiple replicas.

#### Scenario: Independent workspace scaling
- **WHEN** different workspaces execute concurrently
- **THEN** they may use independent coordinators within measured runtime limits
- **AND** one workspace cannot be processed by two live fencing generations.

#### Scenario: Capacity exhausted
- **WHEN** configured storage, queue or inference capacity is exhausted
- **THEN** the service applies a bounded retryable backpressure response
- **AND** it preserves events already acknowledged as durable.

### Requirement: New runtime uses one protocol with explicit migration
New deployments SHALL support only the current versioned blind-storage and trigger protocol. They MUST reject unknown or old protocol versions before transmitting document data and MUST NOT silently downgrade to plaintext, Editor or legacy modes. Migration from an older installation SHALL be explicit, resumable and data-preserving.

#### Scenario: Unknown protocol
- **WHEN** a service offers only an unknown or unsupported version
- **THEN** the client refuses pairing before sending workspace content and reports the required upgrade or migration.

#### Scenario: Interrupted migration
- **GIVEN** migration from an older service has not verified encrypted coverage and second-client recovery
- **WHEN** migration stops or resumes
- **THEN** the operation remains visibly incomplete and idempotently resumes from preserved IDs
- **AND** the old service is not labeled blind or automatically retired.
