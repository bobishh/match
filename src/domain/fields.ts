import type {
  CommandResult,
  FieldDefinition,
  FieldValue,
} from "./model"

export function validateFieldValue(
  field: FieldDefinition,
  value: FieldValue | undefined,
  allowDeprecatedOptions = false
): { valid: boolean; issue?: string } {
  const isPresent = value !== undefined && value !== null && value !== ""

  if (!isPresent) {
    if (field.required && !field.deleted) {
      return { valid: false, issue: `${field.title} is required` }
    }
    return { valid: true }
  }

  switch (field.valueType) {
    case "text":
      if (typeof value !== "string") {
        return { valid: false, issue: `${field.title} must be text` }
      }
      return { valid: true }

    case "url":
      if (
        typeof value !== "string" ||
        (!value.startsWith("http://") && !value.startsWith("https://"))
      ) {
        return { valid: false, issue: `${field.title} must be a valid URL starting with http:// or https://` }
      }
      return { valid: true }

    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { valid: false, issue: `${field.title} must be a date formatted as YYYY-MM-DD` }
      }
      return { valid: true }

    case "datetime":
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.test(value) ||
        Number.isNaN(Date.parse(value))
      ) {
        return { valid: false, issue: `${field.title} must be a valid datetime` }
      }
      return { valid: true }

    case "boolean":
      if (typeof value !== "boolean") {
        return { valid: false, issue: `${field.title} must be true or false` }
      }
      return { valid: true }

    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { valid: false, issue: `${field.title} must be a valid finite number` }
      }
      if (field.min !== null && field.min !== undefined && value < field.min) {
        return { valid: false, issue: `${field.title} must be at least ${field.min}` }
      }
      if (field.max !== null && field.max !== undefined && value > field.max) {
        return { valid: false, issue: `${field.title} must be at most ${field.max}` }
      }
      return { valid: true }

    case "select": {
      if (typeof value !== "string") {
        return { valid: false, issue: `${field.title} must be an option ID` }
      }
      const option = field.options[value]
      if (!option) {
        return { valid: false, issue: `${field.title} has an invalid option selected` }
      }
      if (option.deleted && !allowDeprecatedOptions) {
        return { valid: false, issue: `${field.title} option "${option.title}" is no longer available` }
      }
      return { valid: true }
    }

    default:
      return { valid: false, issue: `Unknown field value type` }
  }
}

export function validateTaskValues(
  boardFields: FieldDefinition[],
  values: Record<string, FieldValue>,
  allowDeprecatedOptions = false
): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {}

  for (const field of boardFields) {
    const val = values[field.id]
    const res = validateFieldValue(field, val, allowDeprecatedOptions)
    if (!res.valid) {
      errors[field.id] = res.issue || "Invalid value"
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
  }
}

export function resolveSelectDisplay(
  field: FieldDefinition,
  value: FieldValue
): { label: string; unavailable: boolean } {
  if (field.valueType !== "select") {
    return { label: String(value ?? ""), unavailable: false }
  }
  if (!value) {
    return { label: "", unavailable: false }
  }

  const optionId = String(value)
  const option = field.options[optionId]
  if (!option) {
    return { label: `Unknown (${optionId})`, unavailable: true }
  }
  if (option.deleted) {
    return { label: option.title, unavailable: true }
  }
  return { label: option.title, unavailable: false }
}

export function patchFieldDefinition(
  field: FieldDefinition,
  patch: {
    title?: string
    required?: boolean
    min?: number | null
    max?: number | null
    valueType?: string
  }
): CommandResult<FieldDefinition> {
  if (patch.valueType && patch.valueType !== field.valueType) {
    return {
      ok: false,
      error: {
        code: "field_type_change",
        message: "Cannot change field valueType. Create a replacement field instead.",
      },
    }
  }

  const updated: FieldDefinition = {
    ...field,
    title: patch.title !== undefined ? patch.title.trim() : field.title,
    required: patch.required !== undefined ? patch.required : field.required,
    updatedAt: new Date().toISOString(),
  }

  if (field.valueType === "number") {
    const numField = updated as FieldDefinition & { valueType: "number" }
    if (patch.min !== undefined) numField.min = patch.min
    if (patch.max !== undefined) numField.max = patch.max
  }

  return { ok: true, value: updated }
}
