import type { Page } from "@playwright/test"

type CapturedNode = { close: (reason?: string) => Promise<void>; endpointId: string; __matchE2eClosed?: boolean }

declare global {
  interface Window {
    __MATCH_E2E_RECOVERY_NODES__?: CapturedNode[]
    __MATCH_E2E_RECOVERY_CLOSED_NODES__?: number
    __MATCH_E2E_DOCUMENT_RECEIVES__?: Array<{ document: number[]; shouldPersist: boolean; persisted: boolean; responseSent: boolean; failed: boolean }>
  }
}

/**
 * Captures nodes returned by the real Vite-served Iroh transport.  The route
 * changes only this test browser's module response; it never substitutes a
 * transport, connection, or node.
 */
export async function captureRealIrohNodes(page: Page) {
  await page.route("**/src/sync/irohTransport.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: `${source}\n;(() => {\n  const originalStart = irohTransport.start.bind(irohTransport)\n  irohTransport.start = async (...args) => {\n    const node = await originalStart(...args)\n    const originalClose = node.close.bind(node)\n    let closed = false\n    node.close = async (...closeArgs) => {\n      const result = await originalClose(...closeArgs)\n      if (!closed) {\n        closed = true\n        node.__matchE2eClosed = true\n        window.__MATCH_E2E_RECOVERY_CLOSED_NODES__ = (window.__MATCH_E2E_RECOVERY_CLOSED_NODES__ ?? 0) + 1\n      }\n      return result\n    }\n    ;(window.__MATCH_E2E_RECOVERY_NODES__ ??= []).push(node)\n    return node\n  }\n})()`,
    })
  })
}

export async function closeLatestRealIrohNode(page: Page, endpoint?: string) {
  await page.evaluate(async currentEndpoint => {
    const node = window.__MATCH_E2E_RECOVERY_NODES__?.findLast(candidate =>
      !candidate.__matchE2eClosed && (!currentEndpoint || candidate.endpointId.startsWith(currentEndpoint)))
    if (!node) throw new Error("No real Iroh node was captured")
    await node.close("E2E unexpected transport close")
  }, endpoint)
}

/** Counts actual persisted-document responses emitted by the receiving live scope. */
export async function captureSavedAcknowledgements(page: Page) {
  await page.route("**/browserScopeSync.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    const preparedPersist = /persisted = !prepared\.shouldPersist \|\| \(?await this\.host\.persistDocument\(toBytes\(prepared\.document\), prepared\.proof\)\)? !== false;?/
    const directPersist = /const persisted = !effect\.shouldPersist \|\| \(?await this\.host\.persistDocument\(toBytes\(effect\.document\), effect\.proof\)\)? !== false;?/
    const acknowledgement = /(const completion = this\.runtime\.completeDocumentReceive\(persisted\);?\s*)if \(completion\.response\) await stream\.send\(toBytes\(completion\.response\)\);?/g
    if (!preparedPersist.test(source) || !directPersist.test(source) || [...source.matchAll(acknowledgement)].length !== 2) {
      throw new Error("Could not instrument both real document receive paths")
    }
    const captureAttempt = (value: "prepared" | "effect") =>
      `const attempt = { document: Array.from(${value}.document), shouldPersist: Boolean(${value}.shouldPersist), persisted: false, responseSent: false, failed: false };\n;(window.__MATCH_E2E_DOCUMENT_RECEIVES__ ??= []).push(attempt);`
    const instrumented = source
      .replace(preparedPersist, match => `${captureAttempt("prepared")}\ntry { ${match}; attempt.persisted = persisted } catch (error) { attempt.failed = true; throw error }`)
      .replace(directPersist, match => `${captureAttempt("effect")}\nlet persisted = false; try { ${match.replace("const persisted =", "persisted =")}; attempt.persisted = persisted } catch (error) { attempt.failed = true; throw error }`)
      .replace(acknowledgement, "$1if (completion.response) { await stream.send(toBytes(completion.response)); attempt.responseSent = true }")
    await route.fulfill({
      response,
      body: instrumented,
    })
  })
}

export async function documentReceiveAttempts(page: Page) {
  return page.evaluate(() => window.__MATCH_E2E_DOCUMENT_RECEIVES__ ?? [])
}

export async function realIrohNodeOwnership(page: Page) {
  return page.evaluate(() => ({
    created: window.__MATCH_E2E_RECOVERY_NODES__?.length ?? 0,
    closed: window.__MATCH_E2E_RECOVERY_CLOSED_NODES__ ?? 0,
    active: (window.__MATCH_E2E_RECOVERY_NODES__?.length ?? 0) - (window.__MATCH_E2E_RECOVERY_CLOSED_NODES__ ?? 0),
  }))
}
