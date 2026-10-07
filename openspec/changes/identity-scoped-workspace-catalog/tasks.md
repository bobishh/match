# Tasks

- [x] Filter available and archived workspace lists by active personal-root references.
- [x] Prevent startup from adding every local document to the active identity's root.
- [x] Repair mismatched legacy `genesis` refs without deleting local document bytes or explicit invitation refs.
- [x] Register validated workspace invitation memberships in the personal root.
- [x] Add unit checks for identity filtering, visitor refs, legacy root shapes, and stale genesis repair.
- [x] Add and run bounded identity/catalog TLC scenario.
- [ ] Pass real device-enrollment BDD for pending and post-adoption catalog scope, local-data preservation, reload, and remote write propagation.
- [ ] Verify full enrollment BDD including post-reload cross-device write propagation; current focused run reaches catalog assertions but fails its final existing remote-write assertion.
