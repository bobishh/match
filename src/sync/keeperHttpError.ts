export class KeeperHttpError extends Error {
  constructor(readonly status: number, readonly url: string, message: string) {
    super(message)
    this.name = "KeeperHttpError"
  }
}
