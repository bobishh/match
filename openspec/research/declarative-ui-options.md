# Declarative workspace UI options

Research date: 2026-09-09. Status: **research only; deferred**. This note introduces no dependency, implementation task, or requirement for the current workspace/data-model change.

## Recommendation

Keep the first generic workspace implementation in native Vue. Later, test a small, versioned view configuration selecting known views and fields. Consider `@json-render/vue` only if users need composition of several reusable panels. Consider JSON Forms or FormKit separately if custom-field forms become expensive to maintain. Defer A2UI until an actual agent-to-UI interoperability requirement exists.

These are architectural judgments from the documented capabilities below, not benchmark results. No package was installed or executed for this research.

## Existing match constraints

The inspected [package.json](../../package.json) declares Vue `^3.5.18`, TypeScript and Automerge; none of the evaluated UI packages is installed. [src/types.ts](../../src/types.ts) currently defines fixed lead statuses and a workspace containing lead, document, template and artifact arrays. [README.md](../../README.md) describes a local-first browser application with IndexedDB and P2P sync. Generic entities and configurable fields belong to the proposed data model, not the current implementation.

Three separate layers should stay distinct:

1. **Domain schema:** typed entities, field definitions, parent relationships and commands.
2. **View configuration:** which existing data to show, which fields to display, grouping and sorting.
3. **UI language:** arbitrary composition, bindings, conditions, events and layout primitives.

Layer 2 can make the same workspace useful for jobs, projects or reading lists without committing to layer 3. None of these libraries supplies match's CRDT semantics, identity, access control or conflict policy.

## Comparison

| Option | Verified Vue capability | Useful scope | Cost or limitation for match | Assessment |
| --- | --- | --- | --- | --- |
| Small native Vue configuration | Vue supports dynamic component selection via `<component :is="...">`. [Vue documentation](https://vuejs.org/guide/essentials/component-basics.html#dynamic-components) | Choose maintained kanban/list components; configure visible fields, sort and a small filter vocabulary. | Match owns validation and configuration migrations; it should resist growing into a general expression language. | Smallest later experiment. |
| `json-render` | Official `@json-render/vue` renderer provides typed component registries, slots, named action handlers, validation, unknown-component fallback and an external controlled store. [Vue API](https://json-render.dev/docs/api/vue) | Compose approved match components from a JSON description. Catalogs define available components and actions. [Catalog](https://json-render.dev/docs/catalog) | Match still implements useful board components and command adapters. General binding/state APIs must be constrained to avoid a second authoritative data store. | Strongest candidate for broader layout composition. |
| JSON Forms | Official Vue 3 bindings; vanilla and Vuetify renderer sets. Integration page currently labels Vue integration preview. [Vue integration](https://jsonforms.io/docs/integrations/vue/) | Generate editors from JSON Schema plus separate UI schema; validation and conditional visibility. Vue component exposes data/error change events. [Vue API](https://jsonforms.io/api/vue/) | Form engine, not a kanban or workspace shell. Needs an adapter from match field definitions and a draft-to-command submission boundary. | Evaluate when complex custom-field editors become a demonstrated need. |
| FormKit Schema | Official repository lists `@formkit/vue` as Vue 3 bindings. [FormKit repository](https://github.com/formkit/formkit) | Serializable form/component trees, conditional sections, loops and restricted expressions. [Schema documentation](https://formkit.com/essentials/schema) | Own schema and form-node state. Broad DOM/component features require a restricted catalog for shared definitions. Main documentation currently defaults to React examples; select Vue-specific API documentation during a spike. | Form-focused alternative; no reason to adopt alongside JSON Forms. |
| A2UI | Maintained renderer list includes React, Lit, Angular and Flutter; no maintained Vue renderer listed. [Official renderers](https://a2ui.org/renderers/) A separate community project advertises Vue 3 and protocol v0.9. [Community renderer](https://shawnwang15.github.io/a2ui-vue/en/) | Incremental surfaces delivered by agents, with protocol-defined lifecycle, bindings and action feedback. | Adds a surface/message protocol. Community Vue compatibility with the official current protocol needs verification; listed v0.9 alone does not establish v0.9.1 parity. | Too much protocol for saved workspace preferences; revisit for agent interoperability. |

`json-render` documents peer requirements of Vue `^3.5.0` and Zod `^4.0.0`; match's declared Vue range aligns, while Zod would be an added dependency. This establishes declared compatibility, not successful integration. [Installation](https://json-render.dev/docs/installation)

## Smallest useful later experiment

After the generic workspace model works, render one fixture dataset as both a kanban and a list using existing Vue components. Let a small JSON configuration select the renderer and visible field IDs. A second domain fixture should require only different data/configuration, without changing component code.

Illustrative shape only; this is not an approved persistence schema. Angle-bracket strings below stand for existing UUID references.

```json
{
  "version": 1,
  "kind": "kanban",
  "boardId": "<board-uuid>",
  "cardFieldIds": ["<company-field-uuid>", "<priority-field-uuid>"],
  "sort": "manual"
}
```

Store references rather than copying column definitions into the view. A view must not change entity ownership, hierarchy or visibility semantics. If later shared through Automerge, keep view definitions addressable by stable IDs and update properties incrementally. Keep local transient state such as focus and an unfinished form draft outside the shared definition.

All renderer actions would call existing domain commands. Renderers would consume derived readable data; their temporary state would not become a second replication model. If a form library reports an entire edited object, its adapter would submit changed fields rather than replace the workspace.

Potential later acceptance evidence, not tasks for the current change:

- **Given** two supported configurations over the same workspace, **when** the user switches views and edits a card, **then** both views show the same persisted entity and history.
- **Given** a configuration referencing a deleted column or field, **when** it renders, **then** existing soft-delete rules remain effective and unavailable configuration is explained without reviving or discarding data.
- **Given** an unknown view version or component, **when** an older client opens it, **then** it preserves the definition and offers a built-in fallback.
- **Given** a failed or pending command, **when** the renderer handles it, **then** the user sees its state and unsaved input remains recoverable.

For imported/shared definitions, a later design should permit only registered components, named commands and bounded data selectors. It should not execute supplied JavaScript, compile supplied Vue templates, load remote modules or expose credentials through binding paths. These are proposed boundaries for this feature, not a claim that a renderer package automatically enforces match's permissions.

## Adoption gates

Stay with native configuration while the requirement is selecting a view, fields, sort and filters. Revisit a UI language only after two concrete workflows require materially different compositions that this configuration cannot express.

Promote `json-render/vue` only if a pinned-version spike demonstrates all of the following: reuse of actual match components; offline rendering; command-based writes with one Automerge source of truth; safe unknown-version fallback; accessible happy and failure states; acceptable measured bundle/render cost against the native baseline. Set numerical budgets before running that comparison, based on match's representative workspace size and supported devices.

Choose a form package only when it measurably reduces custom-field editor code while preserving validation, drafts and partial updates. Choose A2UI only when an external agent/runtime actually needs its protocol. No current evidence requires any of these dependencies.
