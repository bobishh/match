import { type LocalProfile} from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import type { WorkspaceGrant } from "../domain/model"
import { BrowserMeshHandshake, MeshHandshakeCodec, type MeshHandshakePayload } from "@meta-uber/mesh-runtime"
import { createPeerAdvertisement,
  verifyWorkspaceMemberBundle, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceBreakGlassClaim } from "./meshRecords"
import { type PeerStore, type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import type { SyncConnection, DuplexStream } from "./transport"
import { DurableMeshBase, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, breakGlassClaims, ownerAuthorities, revokedPersonIds } from "./durableMeshBase"
import { DurableMeshLifecycle } from "./durableMeshLifecycle"

type InstallSessionArguments = [
  workspaceId: string,
  deviceId: string,
  instanceId: string,
  remoteIssuedAt: string,
  remoteRouteSequence: number | undefined,
  direction: "incoming" | "outgoing",
  connection: SyncConnection,
  heartbeatSupported?: boolean,
  incrementalSupported?: boolean,
  connectionId?: string,
  ownershipReceiptSupported?: boolean,
  remotePersonId?: string,
  ownerWorkspaceSupported?: boolean,
  remoteEndpoint?: string,
]

type IncomingPeer = {
  deviceId: string
  instanceId: string
  issuedAt: string
  routeSequence?: number
  personId: string
  endpoint: string
}

export abstract class DurableMeshHandshake extends DurableMeshLifecycle {
  protected readonly handshakeCodec = new MeshHandshakeCodec()
  private readonly browserHandshake = new BrowserMeshHandshake<WorkspaceMeshCredential, IncomingPeer>({
    credentials: () => this.store.listWorkspaceCredentials(),
    secret: credential => credential.transportSecret,
    workspaceId: credential => credential.workspaceId,
    mergeAuthority: (credential, request) => this.mergeIncomingAuthority(credential, request),
    verifyPeer: (credential, bundle) => this.verifyIncomingPeer(credential, bundle),
    revoked: (credential, personId) => revokedPersonIds(credential).has(personId),
    revocations: credential => revocations(credential),
    ownBundle: credential => this.ownBundle(credential),
    response: (credential, remotePersonId) => this.incomingResponse(credential, remotePersonId),
    putVerifiedBundle: (credential, bundle) => this.putVerifiedBundle(credential, bundle),
    install: ({ credential, remote, connection, features, connectionId }) => this.installSession(
      credential.workspaceId, remote.deviceId, remote.instanceId, remote.issuedAt, remote.routeSequence,
      "incoming", connection as SyncConnection, features.heartbeatSupported, features.incrementalSupported,
      connectionId, features.ownershipReceiptSupported, remote.personId, features.ownerWorkspaceSupported, remote.endpoint),
    afterInstalled: ({ credential, remote, request, connection, features }) => this.afterIncomingInstall(
      credential, remote, request.ownerWorkspaceIds, connection as SyncConnection, features.ownerWorkspaceSupported),
    trace: (event, detail, level) => this.trace(event, detail, level),
    failed: (stage, error) => this.reportProtocolFailure(stage, error),
  }, this.handshakeCodec)

  protected abstract installSession(...args: InstallSessionArguments): Promise<boolean>

  async acceptOnInvitationNode(connection: SyncConnection, stream: DuplexStream, frame: Uint8Array) {
    await this.acceptConnection(connection, undefined, { stream, frame }, this.connectionId("incoming"))
    const entry = [...this.sessions.values()].find(item => item.connection === connection)
    if (!entry) return
    const unsubscribe = this.options.workspace.subscribe?.(() => {
      void this.publishAll()
    })
    try { await entry.session.done } finally { unsubscribe?.() }
  }

  protected async acceptConnection(connection: SyncConnection, signal?: AbortSignal,
    initial?: { stream: DuplexStream; frame: Uint8Array }, connectionId = this.connectionId("incoming")) {
    await this.browserHandshake.accept(connection, initial, connectionId, signal)
  }

  protected async mergeIncomingAuthority(credential: WorkspaceMeshCredential, request: {
    ownershipTransfers?: WorkspaceOwnershipTransfer[]; breakGlassClaims?: WorkspaceBreakGlassClaim[];
    successionPolicy?: WorkspaceSuccessionPolicy; successionVotes?: WorkspaceSuccessionVote[]; successionClaims?: WorkspaceSuccessionClaim[]
  }): Promise<WorkspaceMeshCredential> {
    if (Array.isArray(request.ownershipTransfers)) credential = await this.mergeOwnershipTransfers(credential, request.ownershipTransfers)
    if (Array.isArray(request.breakGlassClaims)) credential = await this.mergeBreakGlassClaims(credential, request.breakGlassClaims)
    await this.mergeSuccessionState(credential, request.successionPolicy, request.successionVotes ?? [], request.successionClaims ?? [])
    return await this.store.getWorkspaceCredential(credential.workspaceId) ?? credential
  }

  protected async verifyIncomingPeer(credential: WorkspaceMeshCredential, bundle: WorkspaceMemberBundle): Promise<IncomingPeer> {
    const remote = await verifyWorkspaceMemberBundle(bundle, { workspaceId: credential.workspaceId,
      ownerPersonId: credential.ownerPersonId, ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[], ownerHistory: ownerAuthorities(credential).slice(1) })
    const payload = remote.advertisement.payload
    return { deviceId: payload.deviceId, instanceId: payload.instanceId ?? "legacy", issuedAt: payload.issuedAt,
      routeSequence: payload.routeSequence, personId: payload.personId, endpoint: payload.endpoint }
  }

  protected async incomingResponse(credential: WorkspaceMeshCredential, remotePersonId: string): Promise<MeshHandshakePayload> {
    const profile = await this.options.getProfile()
    const ownerWorkspaceIds = credential.ownerPersonId === profile.identity.personId && remotePersonId === profile.identity.personId
      ? await this.ownerWorkspaceIds(profile) : undefined
    return this.validateHandshake({ workspaceId: credential.workspaceId, peer: await this.ownBundle(credential),
      ownershipTransfers: ownershipTransfers(credential), successionPolicy: successionPolicy(credential),
      breakGlassClaims: breakGlassClaims(credential), successionVotes: successionVotes(credential), successionClaims: successionClaims(credential),
      ownerWorkspaceIds, capabilities: this.handshakeCodec.capabilities() }, credential.workspaceId)
  }

  protected async afterIncomingInstall(credential: WorkspaceMeshCredential, remote: IncomingPeer,
    ownerWorkspaceIds: string[] | undefined, connection: SyncConnection, ownerWorkspaceSupported: boolean): Promise<void> {
    await this.refreshWorkspaceGossip(credential.workspaceId)
    if (ownerWorkspaceSupported) await this.offerMissingOwnerWorkspaces(connection, credential.transportSecret, ownerWorkspaceIds, remote.personId)
  }

  protected validateHandshake(raw: unknown, workspaceId: string): MeshHandshakePayload {
    return this.handshakeCodec.validate(raw, workspaceId)
  }

  protected async ownBundle(credential: WorkspaceMeshCredential) {
    const profile = await this.options.getProfile()
    const peers = await this.peerInstances(credential.workspaceId)
    const own = peers.find(peer => peer.deviceId === profile.device.deviceId && peer.instanceId === this.instanceId) ??
      peers.find(peer => peer.deviceId === profile.device.deviceId && !peer.instanceId) ??
      await this.store.getPeer(credential.workspaceId, profile.device.deviceId)
    if (!own?.advertisement) throw new Error("Missing local peer advertisement")
    return own.advertisement as WorkspaceMemberBundle
  }

  protected async refreshOwnBundle(credential: WorkspaceMeshCredential, profile: LocalProfile,
    endpoint: string, certificates: DeviceCertificate[]) {
    const peerInstances = await this.peerInstances(credential.workspaceId)
    let current = peerInstances.find(peer => peer.deviceId === profile.device.deviceId && peer.instanceId === this.instanceId) ??
      peerInstances.find(peer => peer.deviceId === profile.device.deviceId && !peer.instanceId) ??
      await this.store.getPeer(credential.workspaceId, profile.device.deviceId)
    // Device enrollment keeps the browser's device key while replacing its person identity.
    // Never let the old identity win PeerStore's timestamp merge for the same device key.
    if (current && current.personId !== profile.identity.personId) {
      await this.store.removePeer(credential.workspaceId, profile.device.deviceId)
      current = null
    }
    let bundle = current?.advertisement as WorkspaceMemberBundle | undefined
    if (bundle) {
      try {
        await verifyWorkspaceMemberBundle(bundle, {
          workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
          ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
          ownerHistory: ownerAuthorities(credential).slice(1),
          allowStaleRoute: true,
        })
      } catch {
        await this.store.removePeer(credential.workspaceId, profile.device.deviceId)
        current = null
        bundle = undefined
      }
    }
    const localGrant = credential.localGrant as WorkspaceGrant | undefined
    const reusable = this.isReusableOwnBundle(bundle, current, credential, profile, endpoint, certificates, localGrant)
    if (reusable) return bundle
    const sequenceStore = this.store as PeerStore & {
      nextInstanceAdvertisementSequence?: (instanceId: string) => Promise<number>
    }
    const routeSequence = sequenceStore.nextInstanceAdvertisementSequence
      ? await sequenceStore.nextInstanceAdvertisementSequence(this.instanceId)
      : Date.now()
    const now = Date.now()
    const next = await createPeerAdvertisement(profile, credential.workspaceId, endpoint, {
      certificates,
      grant: localGrant,
      ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
      ...(this.instanceId ? { instanceId: this.instanceId } : {}),
      routeSequence,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DurableMeshBase.ROUTE_LEASE_MS).toISOString(),
    })
    await this.putVerifiedBundle(credential, next)
    return next
  }

  protected certificateSignatures(items: DeviceCertificate[] | undefined): string {
    return (items ?? []).map(item => item.signature).sort().join("\0")
  }

  protected isReusableOwnBundle(bundle: WorkspaceMemberBundle | undefined, current: WorkspacePeerRecord | null | undefined,
    credential: WorkspaceMeshCredential, profile: LocalProfile, endpoint: string, certificates: DeviceCertificate[],
    localGrant: WorkspaceGrant | undefined): boolean {
    if (!bundle || !bundle.advertisement.payload.issuedAt || !bundle.advertisement.payload.expiresAt) return false
    const payload = bundle.advertisement.payload
    const role = credential.ownerPersonId === profile.identity.personId ? "owner" : localGrant?.payload.role
    return this.bundleRouteMatches(payload, current, endpoint, role) &&
      this.bundleIdentityMatches(bundle, payload, credential, profile) &&
      this.bundleProofsMatch(bundle, credential, certificates, localGrant)
  }

  protected bundleRouteMatches(payload: WorkspaceMemberBundle["advertisement"]["payload"], current: WorkspacePeerRecord | null | undefined,
    endpoint: string, role: WorkspacePeerRecord["role"] | undefined): boolean {
    if (!payload.expiresAt) return false
    return Date.parse(payload.expiresAt) > Date.now() + DurableMeshBase.ROUTE_RENEW_MS && current?.endpoint === endpoint &&
      current.role === role && (!this.instanceId || payload.instanceId === this.instanceId)
  }

  protected bundleIdentityMatches(bundle: WorkspaceMemberBundle, payload: WorkspaceMemberBundle["advertisement"]["payload"],
    credential: WorkspaceMeshCredential, profile: LocalProfile): boolean {
    const agent = (typeof navigator !== "undefined" ? navigator.userAgent : "").trim().slice(0, 256) || undefined
    return payload.deviceName === profile.device.displayName.slice(0, 256) && payload.userAgent === agent &&
      bundle.publicKey === profile.identity.publicKey && bundle.ownerPublicKey === credential.ownerPublicKey
  }

  protected bundleProofsMatch(bundle: WorkspaceMemberBundle, credential: WorkspaceMeshCredential,
    certificates: DeviceCertificate[], localGrant: WorkspaceGrant | undefined): boolean {
    return bundle.grant?.signature === localGrant?.signature &&
      this.certificateSignatures(bundle.certificates) === this.certificateSignatures(certificates) &&
      this.certificateSignatures(bundle.ownerCertificates) === this.certificateSignatures(credential.ownerCertificates as DeviceCertificate[])
  }

  protected async pruneInvalidStoredPeers(credential: WorkspaceMeshCredential, localDeviceId: string) {
    for (const peer of await this.store.listPeers(credential.workspaceId)) {
      if (peer.deviceId === localDeviceId || peer.revokedAt || !peer.advertisement) continue
      try {
        await verifyWorkspaceMemberBundle(peer.advertisement, {
          workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
          ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
          ownerHistory: ownerAuthorities(credential).slice(1),
          allowStaleRoute: true,
        })
      } catch {
        await this.store.removePeer(credential.workspaceId, peer.deviceId)
        this.clearRouteReconnects(`${credential.workspaceId}:${peer.deviceId}:`)
      }
    }
  }

}
