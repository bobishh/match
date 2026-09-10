import { z } from "zod"
import { isValidRank } from "./rank"

const id = z.string().min(1)
const rank = z.string().refine(isValidRank, "Invalid canonical rank")
export const placementSchema = z.strictObject({ parentId: z.string().nullable(), rank })
const entityBaseSchema = z.strictObject({
  id, title: z.string(), placement: placementSchema,
  deleted: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
})
const common = entityBaseSchema.shape
export const boardSchema = z.strictObject({
  ...common, kind: z.literal("board"), entityName: z.string().refine(value => Boolean(value.trim())).optional(),
  preset: z.strictObject({ key: z.enum(["job-search", "blank"]), version: z.literal(1), bindings: z.record(z.string(), z.string()) }).nullable(),
})
export const columnSchema = z.strictObject({ ...common, kind: z.literal("column"), displayHint: z.enum(["normal", "collapsed"]) })
export const fieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const taskSchema = z.strictObject({ ...common, kind: z.literal("task"), body: z.string(), values: z.record(z.string(), fieldValueSchema) })
export const fieldOptionSchema = z.strictObject({ id: z.string(), title: z.string(), rank, deleted: z.boolean() })
const fieldBase = { ...common, kind: z.literal("field"), required: z.boolean() }
export const fieldSchema = z.discriminatedUnion("valueType", [
  z.strictObject({ ...fieldBase, valueType: z.enum(["text", "url", "date", "datetime", "boolean"]) }),
  z.strictObject({ ...fieldBase, valueType: z.literal("number"), min: z.number().nullable(), max: z.number().nullable() }),
  z.strictObject({ ...fieldBase, valueType: z.literal("select"), options: z.record(z.string(), fieldOptionSchema) }),
])
export const fileReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("blob"), sha256: z.string(), byteLength: z.number().int().nonnegative(), mimeType: z.string(), fileName: z.string() }),
  z.strictObject({ type: z.literal("local-file"), fileId: z.string(), fileName: z.string() }),
])
export const documentSchema = z.strictObject({
  ...common, kind: z.literal("document"), documentKind: z.enum(["cv", "cover_letter", "note", "attachment"]),
  format: z.enum(["markdown", "html", "pdf", "path"]), content: z.string().nullable(), file: fileReferenceSchema.nullable(),
})
export const templateSchema = z.strictObject({ ...common, kind: z.literal("document_template"), markdown: z.string() })
export const legacyTemplateSchema = z.strictObject({ ...common, kind: z.literal("template"), markdown: z.string(), templateKind: z.string().optional() })
export const artifactSchema = z.strictObject({
  ...common, kind: z.literal("artifact"), artifactKind: z.enum(["cv", "cover_letter"]), templateId: z.string(),
  pdf: fileReferenceSchema, sourceMarkdown: fileReferenceSchema.nullable(),
})
export const entitySchema = z.discriminatedUnion("kind", [
  boardSchema, columnSchema, taskSchema, fieldSchema, documentSchema, templateSchema, legacyTemplateSchema, artifactSchema,
])
export const workspaceSchema = z.strictObject({
  kind: z.literal("workspace"), formatVersion: z.literal(2), id, title: z.string(), deleted: z.boolean(), ownerPersonId: z.string(),
  entities: z.record(z.string(), entitySchema),
  migration: z.strictObject({ migrationId: z.string(), sourceFormat: z.literal("match-0.0.1"), sourceHeads: z.array(z.string()) }).nullable(),
  leads: z.array(z.unknown()).optional(), documents: z.array(z.unknown()).optional(),
  templates: z.array(z.unknown()).optional(), artifacts: z.array(z.unknown()).optional(),
})
export type Placement = z.infer<typeof placementSchema>
export type EntityBase = z.infer<typeof entityBaseSchema>
export type Board = z.infer<typeof boardSchema>
export type Column = z.infer<typeof columnSchema>
export type FieldValue = z.infer<typeof fieldValueSchema>
export type Task = z.infer<typeof taskSchema>
export type FieldOption = z.infer<typeof fieldOptionSchema>
export type FieldDefinition = z.infer<typeof fieldSchema>
export type FileReference = z.infer<typeof fileReferenceSchema>
export type AttachedDocument = z.infer<typeof documentSchema>
export type DocumentTemplate = z.infer<typeof templateSchema>
export type LegacyWritingTemplate = z.infer<typeof legacyTemplateSchema>
export type PdfArtifact = z.infer<typeof artifactSchema>
export type WorkspaceEntity = z.infer<typeof entitySchema>
export type WorkspaceDocumentV2 = z.infer<typeof workspaceSchema>
