# WebAssembly/ES Module Integration

This page describes  WebAssembly as an ES module. With this proposal, WebAssembly could be loaded from a JavaScript `import` statement, or a `<script type=module>` tag.

This proposal is at Stage 1 in [WebAssembly's process](https://github.com/WebAssembly/meetings/blob/master/process/phases.md).

## Motivation

### Improve ergonomics of WebAssembly module instantiation

Currently, there is an imperative JS API for instantiating WebAssembly modules. This requires users to manually fetch a module file, wire up imports, and run `WebAssembly.instantiate` or `WebAssembly.instantiateStreaming`.

```
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

```
import {foo} from "./myModule.wasm";
foo();
```

### Enable WebAssembly modules to take part in JavaScript module graphs

With the introduction of ES modules, the JS spec provides a way to express module dependency graphs.

These graphs are expressed with import and export statements.

```
// main.js

import {count, incrementCount} from "./dep.js"
```

```
//dep.js

let count = 10;

function incrementCount() {
    count++;
}

export {count, incrementCount};
```

WebAssembly modules currently can't take part in these graphs. This means that developers who want to use WebAssembly modules have to manually use the WebAssembly JS API. However, the API to compile and instantiate a WebAssembly module is asynchronous, so without [top-level await](https://github.com/tc39/proposal-top-level-await), it's not possible to export things which came out of WebAssembly module instantiation, in a way that's available to importers when the import completes.

### Unify various WebAssembly module implementations

The need for WebAssembly modules integrated with the ES module graph has been broadly identified by JavaScript module implementations. For this reason, support for WebAssembly modules has been implemented in various bundlers ([webpack](https://webpack.js.org/configuration/module/#ruletype), a [Rollup plugin](https://github.com/rollup/rollup-plugin-wasm), [Parcel](https://parceljs.org/webAssembly.html) and [Browserify](https://github.com/browserify/rustify)), browser-based module shims ([System.js](https://guybedford.com/systemjs-2.0#web-assembly-integration)), and experimental Node.js module loaders (including [esm](https://github.com/standard-things/esm) and [the Node.js ecmascript-modules branch](https://github.com/nodejs/ecmascript-modules/pull/46)).

Unfortunately, the semantics implemented by various tools differs, and the ideas in these implementations are not always consistent with future feature plans from the WebAssembly Community Group. This proposal attempts to find a common, future-proof for WebAssembly modules, suitable for implementation in both tools and browsers. Hopefully, over time, tools can transition to use the native browser implementation, once support reaches sufficient levels.

## Semantics in terms of module stages

These goals can be addressed by enabling WebAssembly modules to be loaded using the ES module system, as a standard.

This system has three phases:

1. Fetch and parse — A module record is constructed from Module resources.
1. Link — Exports and imports are wired up to memory locations.
1. Evaluate — Top-level module code is run, assigning the value to exports.

The work completed in these phases is defined in two different specifications:

- The ECMAScript spec provides methods for loaders to use to parse, link, and evaluate modules.
- A host-specific spec (e.g., HTML) drives the algorithms defined by ECMAScript, and it describes how to fetch and cache modules.

WebAssembly fits into these steps as follows:

### Fetch and Parse

Fetching and parsing modules is a recursive process, which can be thought of as the following steps, defined in the host specification:
1. Figure out what the module specifier is pointing to, and fetch the module.
1. Parse the module, to find further dependencies.
1. Fetch and parse all modules that are imported by this parsed module, if they aren't already in the cache.

If any syntax error is reached, the algorithm fails, throwing the error.

In WebAssembly's case, during this phase, "parsing" means parsing the binary format and [validating the module](https://webassembly.github.io/spec/js-api/index.html#dom-webassembly-validate). For comparison, in JavaScript, the [ParseModule](https://tc39.github.io/ecma262/#sec-parsemodule) checks if the module has syntax errors.

In both cases, module parsing identifies the new, named exports that this module defines. In WebAssembly, exports can be functions, WebAssembly.Table objects, WebAssembly.Memory objects, and WebAssembly.Global objects. When future WebAssembly types are exposed through the [WebAssembly JS API](https://webassembly.github.io/spec/js-api/index.html), the intention is to allow them to be exported via WebAssembly ESM modules as well.

In the proposed HTML integration of WebAssembly modules, the [module name](https://webassembly.github.io/spec/core/syntax/modules.html#syntax-import) in an import is interpreted the same as a JavaScript module specifier: basically, as a URL. The [import maps](https://github.com/wicg/import-maps/) proposal adds more expressiveness to module specifiers.

### Link

Module records include names of imports and exports. The "link" phase checks whether the named imports correspond to things that are exported, and if so, hooking up the imports of one module to the exports of another module.

The ECMAScript specification holds the module's export in a lexical scope, as potentially mutable variables. The importing module will have the ability to read, but not write, the variables in this lexical scope.

At the end of the link phase, the variables in the module's lexical scope are generally uninitialized. From JavaScript, accessing an uninitialized import causes a ReferenceError. JavaScript function declarations are initialized during the Link phase, as part of function hoisting, but WebAssembly function exports are not initialized until the Evaluation phase.

### Evaluate

During evaluation, the code is evaluated to assign values to the exported bindings. In JS, this means running the top-level module code.

In WebAssembly, evaluating a module consists of the following steps:
1. Read each imported value and converting it into the WebAssembly type which the import was declared as.
1. Instantiate the WebAssembly module with those imports, and run the module's start function.
1. Convert the WebAssembly module's exports to JavaScript values, and initialize the exports in the lexical scope to these values.

#### "Snapshotting" imports

Some impacts of reading the imports up-front:
- The handling of imports could be called a "snapshotting" process: Later updates to the imported values won't be reflected within the WebAssembly module.
- Circular WebAssembly modules are not supported: One of them will run first, and that one will find that the exports of the other aren't yet initialized, leading to a ReferenceError.

See the FAQ for more explanation of the rationale for this design decision, and what features it enables which would be difficult or impossible otherwise.

## FAQ

### How would this work, in some concrete examples?

See some examples of these semantics in [EXAMPLES.md](./EXAMPLES.md).

### Does this proposal expose named exports from WebAssembly?

Yes. In this proposal, each WebAssembly export has its own named binding. To expose a default export from a WebAssembly module, simply make an export called `default`.

### How are imports and exports converted from JavaScript values?

The conversion is based on the type that the import and export was declared as, which is inside the WebAssembly module. The conversion algorithm is the same as the JS API's [instantiate a WebAssembly module](https://webassembly.github.io/spec/js-api/index.html#instantiate-a-webassembly-module) algorithm.

### When one WebAssembly module imports another one, will there be overhead due to converting back and forth to JS values?

Note that exports of ES Module Records always have values that can be directly treated as JavaScript values. Although we're talking about conversions to and from JavaScript for these exports, it's expected that, in native implementations, the conversion to and from Javascript would "cancel out" and not lead to the use of wrappers in practice.

### Why are WebAssembly modules instantiated during the "Evaluation" phase?

WebAssembly module instantiation is when imports are passed in. Even if it's possible to make a trampoline for functions in some cases, or mutate a global, there's no way to indirectly access Memory or Tables. It may be possible to hoist the definition of Globals, Memory or Tables when they are created from WebAssembly, but it's not possible to manipulate those objects when exported from JavaScript, which may initialize these based on the execution of arbitrary JavaScript code.

Future WebAssembly proposals may make this issue even more accute in the context of the [WebAssembly GC proposal](https://github.com/WebAssembly/gc/blob/master/proposals/gc/Overview.md): When WebAssembly modules may import and export types, these types similarly need to be available when the module is instantiated. At they same time, they are exported as a value from another module.

If instantiation took place earlier (e.g., during the Parse or Link phases), then these imports would not yet be available, and so it would not be possible to properly instantiate the module.

### Even if not some imports have a snapshot, could we use a trampoline for functions?

The snapshotting semantics may be the biggest difference between this proposal and the semantics of WebAssembly module support in tooling. As explained above, live bindings are simply not possible for many types that WebAssembly may import. One frequent feature request is for functions among WebAssembly modules to be imported in a circular way.

The idea here would be to use a trampoline: in the Link phase, create a function and initialize a binding for it which would look at whether the underlying import has been initialized yet, and calls it if so.

The main problem with this proposal is, for detailed reasons, it would be very difficult to eliminate the various kinds of overhead associated with this trampoline. In practice, it may behave like a nested function call. In a future with many small WebAssembly modules, doubling the cross-module function call overhead does not sound very attractive, when there's been so much work put into reducing function call overhead.

Instead of including this check in the default semantics of functions, a trampoline can be explicitly constructed which does this check and passes control on to the maybe-initialized function. Initially, this trampoline can be constructed by bundlers. In a potential follow-on proposal, the trampoline may be generated natively. See https://github.com/WebAssembly/esm-integration/issues/17 for further discussion.

### What does snapshotting imports mean for importing globals?

When a WebAssembly module imports a Global, there are two possible modes of operation:
- If the Global type is immutable (as declared in the importing module), then the exporting module may either export a numeric value or an immutable Global.
- If the Global type is mutable, then the exporting module must export a mutable Global. The snapshot here is "shallow" in the sense that modifications *within* this particular mutable Global object *will* be visible in the importing module (but, if the exporting module overwrites the entire binding with some unrelated value, this will not be noticed by the importing module).

### Why does this proposal depend on top-level await?

On some platforms, some compilation work may need to happen when instantiating the module, rather than when parsing it, based on the dynamic values of the imports. For example, if a module imports Memory, there may be different instructions generated for different kinds of memory, with the choice made based on what's dynamically available.

Instantiating a WebAssembly module may take a significant amount of time, as it may involve expensive compilation work. For this reason, at some point during evaluation of a WebAssembly module, control is yielded to the event loop, to not block up the main thread. This yield uses the infrastructure of [the TC39 top-level await proposal](https://github.com/tc39/proposal-top-level-await).

### Can Web APIs be imported via modules?

In general, Web APIs are exposed through properties of the JavaScript global object, and are not available through ES Modules. See [this WebIDL](https://github.com/heycam/webidl/issues/676) issue for some early discussion about exposing Web APIs through modules.

To start using this proposal ahead of that change, create a JavaScript module which exports the appropriate Web APIs that you need.

### How can I provide my own imports for a WebAssembly module, rather than have those be supplied by other JavaScript or WebAssembly modules?

The WebAssembly JS API and Web APIs provide explicit control over imports and remain available for this purpose. When possible, we recommend using [WebAssembly.instantiateStreaming](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/instantiateStreaming) to create modules with given imports efficiently.

### Where is the specification for this proposal?

If you want to dig into the details, see [the updated WebAssembly JS API](https://webassembly.github.io/esm-integration/js-api/index.html#esm-integration) and [the proposed HTML integration PR](https://github.com/whatwg/html/pull/4372).

## Past presentations

For additional context, you can [watch the proposal presentation](https://youtu.be/qR_b5gajwug) or see the slides ([with notes](https://linclark.github.io/wasm-es-modules/slides/2018-03-24/#/0?presenter), [without notes](https://linclark.github.io/wasm-es-modules/slides/2018-03-24/#/)).
