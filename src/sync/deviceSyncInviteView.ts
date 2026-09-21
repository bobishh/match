import QRCode from "qrcode"
import type { DeviceSyncState } from "./deviceSyncState"

export async function showInviteQr(
  state: DeviceSyncState,
  inviteUrl: string,
): Promise<void> {
  state.inviteUrl.value = inviteUrl
  state.qrCode.value = await QRCode.toDataURL(inviteUrl, {
    width: 240,
    margin: 2,
    errorCorrectionLevel: "M",
  })
}
