// META: global=window,dedicatedworker,jsshell,shadowrealm

promise_test(async () => {
  const wasmModuleSource = await import.source("./resources/js-string-constants.wasm");

  assert_true(wasmModuleSource instanceof WebAssembly.Module);

  const instance = new WebAssembly.Instance(wasmModuleSource, {});

  assert_equals(instance.exports.getEmpty(), "");
  assert_equals(instance.exports.getHello(), "hello");
  assert_equals(instance.exports.getEmoji(), "\u{1F600}");
  assert_equals(instance.exports.getHelloLength(), 5);
  assert_equals(instance.exports.hello.value, "hello");
}, "String constants should be supported in source phase imports");

promise_test(async () => {
  const wasmModuleSource = await import.source("./resources/js-string-constants.wasm");

  const imports = WebAssembly.Module.imports(wasmModuleSource);

  assert_equals(imports.length, 0);
}, "Source phase import should not reflect string constant imports");
