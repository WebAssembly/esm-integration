// META: global=window,dedicatedworker,jsshell,shadowrealm

promise_test(async () => {
  const wasmModule = await import("./resources/js-string-constants.wasm");

  assert_equals(wasmModule.getEmpty(), "");
  assert_equals(wasmModule.getHello(), "hello");
  assert_equals(wasmModule.getEmoji(), "\u{1F600}");
  assert_equals(wasmModule.getHelloLength(), 5);
  assert_equals(wasmModule.hello, "hello");
}, "String constants should be imported from wasm:js/string-constants in ESM integration");
