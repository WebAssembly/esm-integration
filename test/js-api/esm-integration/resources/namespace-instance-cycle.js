import * as wasmNamespace from "./namespace-instance-cycle.wasm";

export function fn() {}

export let earlyError = null;
try {
  WebAssembly.namespaceInstance(wasmNamespace);
} catch (e) {
  earlyError = e;
}
