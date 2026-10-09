# Implemented address-only Rusty connection

The Sync dialog now has one Rusty section: Address and Connect. The operator-token form, private Rusty access import/export, v1 KeeperDiscovery panel and standalone Keeper login route are no longer reachable from the product. Existing participant/device mesh functions remain separate.

The browser requests a short-lived service-signed challenge and signs the exact scope policy with its certified device key. Native Rusty verifies the configured owner root, explicit controller-device allowlist, certificate chain, challenge bindings, expiry, revision and one-time consumption. Scope keys stay in identity-private browser storage; encrypted replication uses the existing signed durable receipt protocol. This does not implement capability sharing between existing owner devices or field-private trigger projections.

Remove persists a pending revocation before contacting Rusty. A verified service receipt removes the local connection; a failed request retains the pending record across reload and retries. Removing Rusty does not remove the local board or purge server ciphertext.

## Verification

- Enrollment client unit test first failed because the module was absent; after implementation it verifies real signatures, scoped authorization, revocation and wrong-scope challenge rejection.
- Native acceptance suite: 9 passing tests, including exact canonical signed-envelope receipt commitment.
- Browser acceptance against native Rusty: address-only connection, encrypted on-disk object, server-unavailable removal, reload, retry, persisted server revocation and local board preservation.
- Workerd/browser integration: one Lead, scoped Interview and Rejected transitions, replay handling and ciphertext inspection pass through the new enrollment/UI path. Inference in this local suite is deterministic; real production Clef proof remains separate existing evidence.
- Type check, production build, focused lint, dead-code check and strict OpenSpec validation pass. Broad deployment adapters and scoped cryptographic projections remain unchecked target work in tasks.md.

## Jobs preservation

Before changing deployment, the current Jobs export and a complete archive of the stopped legacy Rusty volume were saved outside the repository in a private directory. The browser profile, active blind volume and legacy volume are preserved. Ordinary board export is not a replacement for identity keys, signed authority evidence or a verified second-client restore.

## Production acceptance completed

Native owner/device enrollment and the single Rusty UI were deployed on the existing production origins without recreating volumes or changing service identity. In the user's existing Chrome profile, Jobs reopened with 71 active cards and 4 documents. Address-only connection completed and survived reload. Remove returned a verified receipt; the persisted native scope policy advanced to revision 2 with revoked=true. Jobs was then reconnected using a fresh scope and remained at 71 cards / 4 documents; the final connection is active. Both scoped server objects have only encrypted-object fields. Private, no-key-material evidence is saved outside the repository alongside preservation backups.

The separate unavailable-server removal path passed against the native isolated browser fixture, including pending state across reload and successful retry. This production check does not prove cross-device sharing of private Rusty access, a second-device disaster restore or cryptographically field-private trigger projections.

## Production frontend routing — 2026-10-09

Five frontend releases now run on Cloudflare Workers Static Assets at their unchanged origins: main/CV, Tincanban, Toss, Twang and Quitter. www redirects to the main hostname. Tincanban/Toss/Twang use Worker Custom Domains; main/Quitter use Worker Routes over their retained proxied origin A records, because blog and event API requests still need the native Hetzner origin. Rusty, analytics and the automation Worker DNS records were verified unchanged. No application volumes or browser storage were recreated. Ecky has a separate domain and is outside this domain migration.

Release assets were captured from the running production containers, preserving older hashed JavaScript/WASM chunks rather than rebuilding dirty source trees. Infrastructure now contains independent Wrangler manifests, a capture script, an explicit frontend release command, image/file-hash manifests, pre/post DNS snapshots and retained origin routing for rollback. See [frontend release and recovery instructions](../../../../hetzner_playground/cloudflare/README.md).

Production checks cover each Worker frontend, native blog/RSS/API forwarding, WebAssembly MIME types, unchanged backend DNS and missing-script 404. Isolated browser checks cover Tincanban boot, lazy settings, reload/local persistence and other frontend rendering, including Toss's Continue action. Deep links are served internally from the root asset without losing the requested URL. This migration does not activate the main form against Jobs, implement field-private projections, replace Kamal's backend ownership, add Terraform state or prove a second-device disaster restore.
