export type { SyncStep } from "../sync/useDeviceSync";

export interface SuccessionView {
  successorPersonId: string | null
  eligibleEditorPersonIds: string[]
  votes: Array<{ voterPersonId: string; candidatePersonId: string }>
  quorum: number
  conflicted: boolean
}
