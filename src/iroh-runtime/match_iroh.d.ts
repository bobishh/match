/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

type ReadableStreamType = "bytes";

export class BrowserAcceptor {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    accept(): Promise<BrowserConnection | undefined>;
    close(): Promise<void>;
}

export class BrowserConnection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    acceptStream(): Promise<BrowserStream>;
    close(): Promise<void>;
    openStream(): Promise<BrowserStream>;
    readonly remoteEndpointId: string;
}

export class BrowserNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    accept(): Promise<BrowserAcceptor>;
    close(reason?: string | null): Promise<void>;
    dial(remote_endpoint: string): Promise<BrowserConnection>;
    static start(secret?: Uint8Array | null): Promise<BrowserNode>;
    readonly endpointId: string;
}

export class BrowserStream {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    closeSend(): Promise<void>;
    read(): Promise<Uint8Array>;
    send(bytes: Uint8Array): Promise<void>;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export function start_browser_node(secret?: Uint8Array | null): Promise<BrowserNode>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_browseracceptor_free: (a: number, b: number) => void;
    readonly __wbg_browserconnection_free: (a: number, b: number) => void;
    readonly __wbg_browsernode_free: (a: number, b: number) => void;
    readonly __wbg_browserstream_free: (a: number, b: number) => void;
    readonly browseracceptor_accept: (a: number) => any;
    readonly browseracceptor_close: (a: number) => any;
    readonly browserconnection_acceptStream: (a: number) => any;
    readonly browserconnection_close: (a: number) => any;
    readonly browserconnection_openStream: (a: number) => any;
    readonly browserconnection_remoteEndpointId: (a: number) => [number, number];
    readonly browsernode_accept: (a: number) => any;
    readonly browsernode_close: (a: number, b: number, c: number) => any;
    readonly browsernode_dial: (a: number, b: number, c: number) => any;
    readonly browsernode_endpointId: (a: number) => [number, number];
    readonly browsernode_start: (a: number, b: number) => any;
    readonly browserstream_closeSend: (a: number) => any;
    readonly browserstream_read: (a: number) => any;
    readonly browserstream_send: (a: number, b: number, c: number) => any;
    readonly start_browser_node: (a: number, b: number) => any;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke___wasm_bindgen_d74c8ca32befd6e5___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_d74c8ca32befd6e5___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke___js_sys_b85a05835744ecf1___Function_fn_wasm_bindgen_d74c8ca32befd6e5___JsValue_____wasm_bindgen_d74c8ca32befd6e5___sys__Undefined___js_sys_b85a05835744ecf1___Function_fn_wasm_bindgen_d74c8ca32befd6e5___JsValue_____wasm_bindgen_d74c8ca32befd6e5___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke___wasm_bindgen_d74c8ca32befd6e5___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke___web_sys_b848516d5210e283___features__gen_CloseEvent__CloseEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke___web_sys_b848516d5210e283___features__gen_RtcDataChannelEvent__RtcDataChannelEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke___web_sys_b848516d5210e283___features__gen_MessageEvent__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke___web_sys_b848516d5210e283___features__gen_RtcDataChannelEvent__RtcDataChannelEvent______true__5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke___web_sys_b848516d5210e283___features__gen_RtcDataChannelEvent__RtcDataChannelEvent______true__6: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke_______true__1_: (a: number, b: number) => void;
    readonly wasm_bindgen_d74c8ca32befd6e5___convert__closures_____invoke_______true__2_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
