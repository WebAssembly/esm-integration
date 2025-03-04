# WebAssembly/ES Module Integration

This page describes WebAssembly as an ES Module. With this proposal, WebAssembly may be loaded with a JavaScript `import` statement, or a `<script type=module>` tag.

This proposal is at Phase 3 in [WebAssembly's process](https://github.com/WebAssembly/meetings/blob/master/process/phases.md).

## Motivation

### Improve Ergonomics of WebAssembly Module Instantiation

Currently, there is an imperative JS API for instantiating WebAssembly modules. This requires users to manually fetch a module file, wire up imports, and run `WebAssembly.instantiate` or `WebAssembly.instantiateStreaming`.

```js
let req = fetch("./myModule.wasm");

let imports = {
  aModule: {
    anImport
  }
};

WebAssembly
  .instantiateStreaming(req, imports)
  .then(
    obj => obj.instance.exports.foo()
  );
```

A declarative API would improve the ergonomics by making this work happen implicitly.

```js
import { foo } from "./myModule.wasm";
foo();
```

Then by integrating with [Source Phase Imports](https://github.com/tc39/proposal-source-phase-imports), arbitrary instantiations with custom imports can still be supported.

```js
import source myModule from "./myModule.wasm";

const { foo: foo1 } = new WebAssembly.Instance(myModule, { ...imports1 });
foo1();

const { foo: foo2 } = new WebAssembly.Instance(myModule, { ...imports2 });
foo2();
```

For dynamically loaded modules, dynamic `import()` integration is also supported for both phases.

```js
const { foo: foo1 } = await import("./myModule.wasm");

const myModule = await import.source("./myModule.wasm");
const { foo: foo2 } = await WebAssembly.instantiate(myModule, { ...imports });
```

### Unify WebAssembly Tooling Implementations

The need for WebAssembly modules integrated with the ES module graph has been broadly identified by JavaScript tools. For example, support for WebAssembly modules has been implemented in [webpack](https://webpack.js.org/configuration/module/#ruletype), a [Rollup plugin](https://github.com/rollup/plugins/tree/master/packages/wasm) and [Parcel](https://en.parceljs.org/webAssembly.html).

By standardizing the integration, tools can support building WebAssembly applications providing ergonomic workflows that work with static analysis for working with Wasm on JavaScript platforms in a unified way.

For server runtimes, [Deno has implemented](https://deno.com/blog/v2.1#first-class-wasm-support) this proposal and [Node.js' implementation is behind a flag](https://nodejs.org/docs/latest/api/esm.html#wasm-modules) (both pending source phase supports), while [ES Module Shims](https://github.com/guybedford/es-module-shims#wasm-modules) provides a full browser polyfill.

## Implementation

### Source Phase Imports

[Source phase imports](https://github.com/tc39/proposal-source-phase-imports) expose the source phase of the module loading process, corresponding to a `WebAssembly.Module` source.

For WebAssembly, the benefit of this import phase is being able to support multiple instantiation and custom instantiation or imports, while still utilizing the ESM integration for portable module resolution and fetching.

Source phase objects exposed by the module system must contain `AbstractModuleSource` in their prototype chain, therefore to support these imports for WebAssembly, the prototype of `WebAssembly.Module` is updated accordingly.

### Host Instance Linking

While the source phase import model provides a flexible ESM integration for custom multi-instantiation, integration with the host linking model provides the ability to get directly executed Wasm modules.

While many WebAssembly modules may not be functional under this linking model, it allows for a subset of Wasm modules to support direct instancing with access to the JS module graph, that can still be useful in many scenarios.

### Import & Export Embedding

Fetching and parsing modules is a recursive process, which can be thought of as the following steps, defined in the host specification:

1. Figure out what the module specifier is pointing to, and fetch the module.
1. Parse the module, to find further dependencies.
1. Fetch and parse all modules that are imported by this parsed module, if they aren't already in the cache.

If any syntax error is reached, the algorithm fails, throwing the error.

Module parsing identifies the named exports that this module defines. In WebAssembly, exports can be functions, WebAssembly.Table objects, WebAssembly.Memory objects, and WebAssembly.Global objects. When future WebAssembly types are exposed through the [WebAssembly JS API](https://webassembly.github.io/spec/js-api/index.html), the intention is to allow them to be exported via WebAssembly ESM modules as well.

In the proposed HTML integration of WebAssembly modules, the [module name](https://webassembly.github.io/spec/core/syntax/modules.html#syntax-import) in an import is interpreted the same as a JavaScript module specifier: basically, as a URL. The [import maps](https://github.com/wicg/import-maps/) proposal adds more expressiveness to module specifiers.

### "Snapshotting" imports

When imports are provided to WebAssembly modules in the host instance linking model from JavaScript, they are provided directly upfront.

- This handling of imports could be called a "snapshotting" process: Later updates to the imported values won't be reflected within the WebAssembly module.
- Circular WebAssembly module bindings are not supported for direct exports: One of them will run first, and that one will find that the exports of the other aren't yet initialized, leading to a ReferenceError. Indirect exports (reexports) can be supported early in Wasm cycles, where a WebAssembly module exports the same binding it imports.

See the FAQ for more explanation of the rationale for this design decision, and what features it enables which would be difficult or impossible otherwise.

### Live binding exports

WebAssembly modules support live exports bindings for mutable globals by reflecting the infallible ToJsValue() representation of their mutable global exports on their JavaScript environment bindings record.

For bindings that are exported from bindings that were initially imported i.e. indirect exports or reexports:

1. WebAssembly modules that have indirect exports to JavaScript modules, these values are snapshotted at the time of execution of the WebAssembly module and reflected as captured bindings and not live bindings on the exports, even if the underlying JavaScript module might have modifications to the binding later on.

2. WebAssembly modules that have indirect exports to WebAssembly modules, where those modules directly export mutable globals, support the live mutable global reference without capturing the import.

## FAQ

### Does the source phase replace the instance linking?

Originally the ESM integration only provided the direct host instance linking model, which could be considered to be a restrictive form of linking for only some use cases for Wasm.

Supporting the [source phase](https://github.com/tc39/proposal-source-phase-imports) ESM integration is therefore a more general form of the ESM integration that shares the host resolver, while retaining linking flexibility for Js host embedding of Wasm.

While the source phase does not replace the instance linking model, is does offer a more general and flexible ESM integration as an addition.

### How does this relate to the Component Model?

The [Component Model](https://github.com/WebAssembly/component-model) has its own [ESM integration embedding](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md#ESM-integration), which is designed to extend the ESM integration specified here.

In components it is possible to import both other components and core modules through the host linker, and it is possible to obtain them either as instances or uninstantiated modules. This linking model of the component model is therefore fully compatible with the linking model of the ESM integration, where these represent the host instance linking and source phases respectively and components effectively as a third module type. Components are distinguished from core Wasm in their leading bytes. Components may be more likely to support a highly usable host instance linking model ESM integration than core Wasm, while their source phase imports in turn would also be useful in virtualization workflows in JS embeddings.

### Why does this proposal not use import attribtues?

[Import attributes](https://github.com/tc39/proposal-import-attributes) parameterize module imports in the module system. Currently HTML specifies a `"type"` attribute which is a requirement for CSS or JSON module imports due to their having different security privileges over full execution.

When importing WebAssembly from JavaScript, no `"type"` should be required since they share the same security privilege level in the ESM integration and in order to ensure transparent interoperability of the formats.

Future Wasm extensions may include supporting attributes for imports from WebAssembly modules.

### How would host instantiation work, in some concrete examples?

See some examples of these semantics in [EXAMPLES.md](./EXAMPLES.md).

### Does this proposal expose named exports from WebAssembly?

Yes. In this proposal, each WebAssembly export has its own named binding. To expose a default export from a WebAssembly module, simply make an export called `default`.

### How are imports and exports converted from JavaScript values?

The conversion is based on the type that the import and export was declared as, which is inside the WebAssembly module. The conversion algorithm is the same as the JS API's [instantiate a WebAssembly module](https://webassembly.github.io/spec/js-api/index.html#instantiate-a-webassembly-module) algorithm.

### When one WebAssembly module imports another one, will there be overhead due to converting back and forth to JS values?

Bindings between WebAssembly modules, even those that are indirect through indirect exports (reexports) are directly linked, without needing to go through JS wrapping and unwrapping.

### Why are WebAssembly modules instantiated during the "Evaluation" phase?

WebAssembly module instantiation is when imports are passed in. Even if it's possible to make a trampoline for functions in some cases, or mutate a global, there's no way to indirectly access Memory or Tables. It may be possible to hoist the definition of Globals, Memory or Tables when they are created from WebAssembly, but it's not possible to manipulate those objects when exported from JavaScript, which may initialize these based on the execution of arbitrary JavaScript code.

This is even more accute in the context of the [WebAssembly GC proposal](https://github.com/WebAssembly/gc/blob/master/proposals/gc/Overview.md): When WebAssembly modules may import and export types, these types similarly need to be available when the module is instantiated. At they same time, they are exported as a value from another module.

If instantiation took place earlier (e.g., during the Parse or Link phases), then these imports would not yet be available, and so it would not be possible to properly instantiate the module.

### Even if not some imports have a snapshot, could we use a trampoline for functions?

The snapshotting semantics may be the biggest difference between this proposal and the semantics of WebAssembly module support in tooling. As explained above, live bindings are simply not possible for many types that WebAssembly may import. One frequent feature request is for functions among WebAssembly modules to be imported in a circular way.

The idea here would be to use a trampoline: in the Link phase, create a function and initialize a binding for it which would look at whether the underlying import has been initialized yet, and calls it if so.

The main problem with this proposal is, for detailed reasons, it would be very difficult to eliminate the various kinds of overhead associated with this trampoline. In practice, it may behave like a nested function call. In a future with many small WebAssembly modules, doubling the cross-module function call overhead does not sound very attractive, when there's been so much work put into reducing function call overhead.

Instead of including this check in the default semantics of functions, a trampoline can be explicitly constructed which does this check and passes control on to the maybe-initialized function. Initially, this trampoline can be constructed by bundlers. In a potential follow-on proposal, the trampoline may be generated natively. See https://github.com/WebAssembly/esm-integration/issues/17 for further discussion.

### What does snapshotting imports mean for importing globals?

Imports are only snapshotted when they resolve to a JavaScript module. For imports that resolve to WebAssembly modules, these are always directly bound.

When a WebAssembly module imports a Global, that resolves to a module after resolving the binding through any indirect exports (reexports):
- If the resolved module is a JavaScript module, then the exporting module may either export a direct value or a `WebAssembly.Global` of the same type.
- If the resolved module is a WebAssembly module, then the exporting module must export a global that is an extern subtype of the importing global.

### Can Web APIs be imported via modules?

In general, Web APIs are exposed through properties of the JavaScript global object, and are not available through ES Modules. See [this WebIDL](https://github.com/heycam/webidl/issues/676) issue for some early discussion about exposing Web APIs through modules.

To start using this proposal ahead of that change, create a JavaScript module which exports the appropriate Web APIs that you need.

### Is WebAssembly.instantiateStreaming still recommended for custom instantiation?

In many cases, the source phase import can replace instantiate streaming workflows, allowing for better compatibility with JS tools when it is fully supported.

In addition, for dynamically loaded Wasm modules, `import()` and `import.source()` can be used to obtain these in a way that integrates with the security policy of the module system (and CSP in browsers).

If custom compilation options are needed or if custom streams need to be provided then the JS and Web APIs can provide a useful fallback, where instantiateStreaming and compileStreaming are the preferred direct APIs to use.

### Where is the specification for this proposal?

If you want to dig into the details, see [the updated WebAssembly JS API](https://webassembly.github.io/esm-integration/js-api/index.html#esm-integration) and [th HTML integration PR](https://github.com/whatwg/html/pull/10380).
