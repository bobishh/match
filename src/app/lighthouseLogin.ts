import { approveLighthouseLogin, prepareLighthouseLogin } from "../sync/lighthouseLogin"

export type LighthouseLoginApproval = {
  keeperName: string
  keeperOrigin: string
  matchName: string
  matchPersonId: string
  approve(): Promise<string>
}

export async function prepareLighthouseLoginApproval(origin: string, challengeId: string): Promise<LighthouseLoginApproval> {
  const request = await prepareLighthouseLogin(origin, challengeId)
  return {
    keeperName: request.discovery.displayName,
    keeperOrigin: request.discovery.origin,
    matchName: request.profile.identity.displayName,
    matchPersonId: request.profile.identity.personId,
    approve: () => approveLighthouseLogin(request),
  }
}
