use std::{collections::BTreeSet, str::FromStr};

use automerge::{AutoCommit, AutoSerde, ChangeHash};
use meta_mesh_core::{AuthorizedWorkspaceChange, WorkspaceRole};
use serde_json::Value;

/// Match product policy over the exact Automerge state before and after each
/// admitted change. Signed mesh grants are necessary but do not authorize
/// editor changes to board structure or ownership fields.
pub fn validate_change_transitions(
    document: &[u8],
    admitted: &[AuthorizedWorkspaceChange],
) -> Result<(), String> {
    let mut doc =
        AutoCommit::load(document).map_err(|error| format!("Invalid Match document: {error}"))?;
    for change in admitted {
        let hash = ChangeHash::from_str(&change.hash).map_err(|_| "Invalid Match change hash")?;
        let dependencies = doc
            .get_change_by_hash(&hash)
            .ok_or("Admitted Match change is missing from document")?
            .deps()
            .to_vec();
        let before = doc
            .fork_at(&dependencies)
            .map_err(|error| error.to_string())?;
        let after = doc.fork_at(&[hash]).map_err(|error| error.to_string())?;
        let before =
            serde_json::to_value(AutoSerde::from(&before)).map_err(|error| error.to_string())?;
        let after =
            serde_json::to_value(AutoSerde::from(&after)).map_err(|error| error.to_string())?;
        validate_workspace_transition(change.role, &before, &after)?;
    }
    Ok(())
}

/// Same product transition rules used by Match's browser adapter.
pub fn validate_workspace_transition(
    role: WorkspaceRole,
    before: &Value,
    after: &Value,
) -> Result<(), String> {
    if role == WorkspaceRole::Visitor {
        return Err("Visitors can only view this workspace".into());
    }
    let before = before
        .as_object()
        .ok_or("Invalid Match workspace before change")?;
    let after = after
        .as_object()
        .ok_or("Invalid Match workspace after change")?;
    let mut before_root = before.clone();
    let mut after_root = after.clone();
    before_root.remove("title");
    after_root.remove("title");
    let before_entities = before_root
        .remove("entities")
        .and_then(|value| value.as_object().cloned())
        .ok_or("Invalid Match entities before change")?;
    let after_entities = after_root
        .remove("entities")
        .and_then(|value| value.as_object().cloned())
        .ok_or("Invalid Match entities after change")?;
    if before_root != after_root && role != WorkspaceRole::Owner {
        return Err("Only the owner can edit board structure".into());
    }
    let ids = before_entities
        .keys()
        .chain(after_entities.keys())
        .collect::<BTreeSet<_>>();
    for id in ids {
        let old = before_entities.get(id);
        let new = after_entities.get(id);
        if old == new {
            continue;
        }
        if !is_content_change(old, new) {
            if role != WorkspaceRole::Owner {
                return Err("Only the owner can edit board structure".into());
            }
            continue;
        }
        if is_item(new.unwrap()) {
            let parent_id = new
                .unwrap()
                .pointer("/placement/parentId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let parent = after_entities.get(parent_id);
            if !parent.is_some_and(|value| {
                is_item(value) || value.get("kind").and_then(Value::as_str) == Some("column")
            }) {
                return Err("Invalid item parent".into());
            }
        }
    }
    Ok(())
}

fn is_content_change(before: Option<&Value>, after: Option<&Value>) -> bool {
    let Some(after) = after else {
        return false;
    };
    let kind = entity_kind(after);
    matches!(kind, Some("item" | "document" | "artifact"))
        && (before.is_none() || before.and_then(entity_kind) == kind)
}

fn entity_kind(value: &Value) -> Option<&str> {
    if is_item(value) {
        Some("item")
    } else {
        value.get("kind").and_then(Value::as_str)
    }
}

fn is_item(value: &Value) -> bool {
    let Some(value) = value.as_object() else {
        return false;
    };
    ["id", "title", "body"]
        .iter()
        .all(|key| value.get(*key).is_some_and(Value::is_string))
        && ["values", "placement"]
            .iter()
            .all(|key| value.get(*key).is_some_and(Value::is_object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::{ObjType, ROOT, transaction::Transactable};
    use meta_mesh_core::WorkspaceRole;
    use serde_json::json;

    fn board() -> Value {
        json!({"id":"board", "ownerPersonId":"owner", "title":"Jobs", "entities":{
            "column":{"kind":"column", "id":"column", "title":"Inbox"},
            "item":{"id":"item", "title":"Lead", "body":"Old", "values":{}, "placement":{"parentId":"column", "rank":"a"}}
        }})
    }

    #[test]
    fn editor_content_allowed_but_owner_and_structure_changes_denied() {
        let before = board();
        let mut after = before.clone();
        after["entities"]["item"]["body"] = json!("New");
        validate_workspace_transition(WorkspaceRole::Editor, &before, &after).unwrap();
        after["ownerPersonId"] = json!("editor");
        assert!(validate_workspace_transition(WorkspaceRole::Editor, &before, &after).is_err());
        after = before.clone();
        after["entities"]["column"]["title"] = json!("Changed");
        assert!(validate_workspace_transition(WorkspaceRole::Editor, &before, &after).is_err());
    }

    #[test]
    fn item_parent_must_exist_even_for_owner() {
        let before = board();
        let mut after = before.clone();
        after["entities"]["item"]["placement"]["parentId"] = json!("missing");
        assert_eq!(
            validate_workspace_transition(WorkspaceRole::Owner, &before, &after),
            Err("Invalid item parent".into())
        );
    }

    #[test]
    fn validates_each_admitted_automerge_change_at_its_own_heads() {
        let mut document = AutoCommit::new();
        document.put(ROOT, "id", "board").unwrap();
        document.put(ROOT, "ownerPersonId", "owner").unwrap();
        document.put(ROOT, "title", "Jobs").unwrap();
        document.put_object(ROOT, "entities", ObjType::Map).unwrap();
        document.get_heads();

        document.put(ROOT, "title", "Jobs updated").unwrap();
        let title_hash = document.get_heads()[0].to_string();
        document.put(ROOT, "ownerPersonId", "editor").unwrap();
        let owner_hash = document.get_heads()[0].to_string();
        let bytes = document.save();

        validate_change_transitions(
            &bytes,
            &[AuthorizedWorkspaceChange {
                hash: title_hash,
                role: WorkspaceRole::Editor,
            }],
        )
        .unwrap();
        assert_eq!(
            validate_change_transitions(
                &bytes,
                &[AuthorizedWorkspaceChange {
                    hash: owner_hash,
                    role: WorkspaceRole::Editor,
                }]
            ),
            Err("Only the owner can edit board structure".into())
        );
    }
}
