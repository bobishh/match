export function deviceAccessRevoked(catalog: unknown, personId: string, deviceId: string): boolean {
  const records = (catalog as { deviceRevocations?: Array<{ record: { payload: { personId: string; deviceId: string } } }> } | undefined)?.deviceRevocations ?? []
  return records.some(value => value.record.payload.personId === personId && value.record.payload.deviceId === deviceId)
}
