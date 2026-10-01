## Why

Creating a custom board currently requires creating a preset workspace and then editing its structure. Users who already know their item name, columns, and fields need one creation flow that persists their intended configuration.

## What Changes

- Add a collapsed configuration section to workspace creation, with a summary of item name, columns, and fields.
- Allow editing item name, ordered columns, basic typed fields, required flags, and select options before creation.
- Preserve manual configuration when changing presets unless the user explicitly resets it.
- Validate the complete draft before saving and retain it during validation or persistence failure.
- Keep pending submission visible and prevent duplicate submission.

## Capabilities

### New Capabilities
- `workspace-creation-config`: Progressive configuration and durable creation of custom boards.

### Modified Capabilities
- None.

## Impact

Workspace creation dialog, existing board schema validation, workspace genesis persistence, and browser tests. Existing preset creation remains compatible. Advanced priority rules, document templates, and identity/access settings are outside scope.
