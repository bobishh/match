import type { DuplexStream } from "./transport"

/** Routes already-read handoff confirmations from the connection's sole stream reader. */
export class HandoffConfirmationInbox {
  private waiting: Array<{ stream: DuplexStream; frame: Uint8Array }> = []
  private readers: Array<(value: DuplexStream) => void> = []

  push(stream: DuplexStream, frame: Uint8Array) {
    const buffered: DuplexStream = {
      send: bytes => stream.send(bytes),
      read: async () => frame,
      closeSend: () => stream.closeSend(),
    }
    const reader = this.readers.shift()
    if (reader) reader(buffered)
    else this.waiting.push({ stream: buffered, frame })
  }

  acceptStream = (): Promise<DuplexStream> => {
    const next = this.waiting.shift()
    if (next) return Promise.resolve(next.stream)
    return new Promise(resolve => this.readers.push(resolve))
  }
}
