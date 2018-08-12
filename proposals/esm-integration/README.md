# ES Module Integration

This page describes a proposal for integration with ES modules. For additional context, you can [watch the proposal presentation](https://youtu.be/qR_b5gajwug) or see the slides ([with notes](https://linclark.github.io/wasm-es-modules/slides/2018-03-24/#/0?presenter), [without notes](https://linclark.github.io/wasm-es-modules/slides/2018-03-24/#/)).

## Motivation

The proposal has two goals:

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

WebAssembly modules currently can't take part in these graphs. This means that developers who want to use WebAssembly modules have to manually trigger instantiation, which may not have completed by the time the JS module graph returns, breaking the mental model of modules.

## Proposed solution

Both goals can be addressed by enabling WebAssembly modules to be loaded using the ES module system. 

This system has three phases:

1. Construction — Module files are fetched and parsed and the module record is constructed.
1. Instantiation — Exports and imports are wired up to memory locations. Functions are also initialized here.
1. Evaluation — Top-level module code is evaluated so that non-function exports can be assigned their values.

The work completed in these phases is defined in two different specs:

- A host-specific specification (i.e. the HTML spec) defines how to load modules.
- The ES module spec provides methods for loaders to use to parse, instantiate, and evaluate modules. The spec defines both an Abstract Module Record and a concrete subclass of this for JS modules, called the Source Text Module Record.

This proposal will create a new WebAssembly Module subclass of the Abstract Module Record. For this, the 3 phases will be specified as follows (with the possible introduction of a sub-phase in Instantiation):

### Construction

During construction, all files for modules in the graph are downloaded and are parsed into Module Records. 

Three things happen for each module during the Construction phase.

1. Finding the file — Based on the module specifier, the host figures out where to get the file from using its module resolution algorithm. Module resolution algorithms differ between hosts. There is ongoing work to fix incompatibilities between Node.js and browser module resolution with the [package-name-maps](https://github.com/domenic/package-name-maps) proposal.
1. Loading the file — The host fetches the file using the module path generated in module resolution. For browsers, the loading algorithm is specified in the [HTML spec](https://html.spec.whatwg.org/#fetch-a-module-script-tree). The WebAssembly MIME type will need to be added to this spec, but loading should largely work without change for WebAssembly modules. 
1. Parsing the file — The runtime parses the file into a Module Record. For JavaScript, this work is specified in the [`ParseModule` method](https://tc39.github.io/ecma262/#sec-parsemodule) of the Source Text Module Record. This proposal will add a `ParseModule` method to the WebAssembly spec. The runtime creates the logical equivalent of `WebAssembly.Module` during this phase, and fills in the `RequestedModules` field of the module.

### Instantiation

When `Module.Instantiate` is called on a JavaScript module, a Lexical Environment is set up. Space for exports is allocated and the memory locations are bound to the export name. Additionally, any imports from dependencies are resolved. In JS, functions are initialized at this point. All other values are undefined until evaluation.

When `Module.Instantiate` is called on a WebAssembly module, the module will go through the same process. However, unlike in JavaScript, functions will not be initialized at this point. Initialization for all values happens during evaluation.

WebAssembly exports can be any one of the [external types] (https://webassembly.github.io/spec/core/exec/modules.html#external-typing), which currently include:

- functions
- tables
- memories
- globals

WebAssembly does not currently have a type that can handle arbitrary JS values. This means that JS value imports can not be handled with live bindings and will be snapshotted when they are imported. This means that if a JS module changes one of its exports to point to a different object, a WebAssembly module importing that object will not see the change.

It may be possible to provide live bindings for JS values if an `any` type is added to WebAssembly.

### Evaluation

During evaluation, the code is evaluated to assign values to the exported bindings. In JS, this means running the top-level module code.

For WebAssembly, evaluation consists of:
- initializing all exports and snapshotting all imports
- filling in memory using the data segment
- filling in tables using elem segments
- running the start function, which corresponds to running the top-level module code

Because JS modules that the WebAssembly module imports from are already evaluated at this point, their values will be available for WebAssembly to snapshot.

#### A note on snapshotting

For JavaScript ES modules, an export name is bound to a slot on the Module Record. For all of the values that we currently allow, this slot will contain a reference to another memory location, which contains the object (e.g. the `WebAssembly.Global` object that is being imported).

The term "snapshot" means that WebAssembly will snapshot the reference. This does result in an observable difference between the way JavaScript and WebAssembly handle updates. In JavaScript modules, it is possible for the exporting module to update an export to point to a different object. Other JavaScript modules that are importing that export will then get the new object. In contrast, while WebAssembly modules will see changes to the object that the export was first bound to (e.g. when the exporting module calls `WebAssembly.Global.prototype.set` to change the value), the WebAssembly module will never see updated bindings.

## Examples and explanation of import/export handling

Some imports are challenging to handle in the current WebAssembly specification. In this section, we will discuss each kind of export and what the specification described above means for how it is handled.

### wasm imports <- JS exports

| export type | value (not a WebAssembly.Global)* | global | memory | table | function |
|-------------|------------------|--------|--------|-------|----------|
|              | Error                         | snapshot  | snapshot  | snapshot | snapshot |

\*While WebAssembly only has the concept of globals, JS could export either a regular JS value or a `WebAssembly.Global`.

The sequence of operations for a wasm module which depends on a JS module is as follows:

1. wasm module is parsed
1. JS module is parsed
1. JS module is instantiated. Function exports are initialized. Non-function exports are set to undefined.
1. wasm module is instantiated. Imports are bound to memory locations but values are not snapshotted yet.
1. JS module is evaluated. All of its remaining exports (i.e. non-fuction values) are initialized. 
1. wasm module is evaluated. All exports are initialized. All imports are snapshotted.

Note: because these are snapshots of values, this does not maintain the live-binding semantics that exists between JS modules. For example, let's say JS module exports a function, called `foo`. The WebAssembly module imports `foo`. Then, after evaluation, the JS module sets `foo` to a different function. Other JS modules would see this update. However, WebAssembly modules will not.

#### Examples

##### Function imports

```
// main.wasm
(module
  (import "./counter.js" "getCount" (func $getCount (func (result i32))))
)

// counter.js
let count = 42;

function getCount() {
    return count;
}
export {getCount};
```

##### Value imports

@TODO add example of WebAssembly.Global being updated

```
// main.wasm
(module
  (import "./counter.js" "count" (global i32))
)

// counter.js
let count = 42;
export {count};
```

##### External type imports

@TODO add example of JS exporting memory

### JS imports <- wasm exports

| export type | global       | memory       | table        | function     |
|-------------|--------------|--------------|--------------|--------------|
|   | live binding | live binding | live binding | live binding |

While these are live bindings, the binding can not be reassigned as it can in JS. But the value that it points to (e.g. `.value` in the case of `WebAssembly.Global`) can change.

1. JS module is parsed
1. wasm module is parsed
1. wasm module is instantiated. All exports are set to undefined.
1. JS module is instantiated. Imports are bound to the same memory locations.
1. wasm module is evaluated. Functions are initialized. Memories and tables are initialized and filled with data/elem sections. Globals are initialized and initializer expressions are evaluated.
1. JS module is evaluated. All values are available.

Currently, the value of the export for something like `WebAssembly.Global` would be accessed using the `.value` property on the JS object. However, when host bindings are in place, these could be annotated with a host binding that turns it into a real live binding that points directly to the value's address.

#### Example

```
// main.js
import {count, increment} from "./counter.wasm";
console.log(count.value); // logs 5
increment();
console.log(count.value); // logs 6

// counter.wasm
(module
  (func $increment
    get_global 0
    i32.const 1
    i32.add
    set_global 0)
  (global (mut i32) i32.const 5)
  (export "count" (global 0))
  (export "increment" (func $increment)))
```

### wasm imports <- wasm exports

| export type | global       | memory       | table        | function     |
|-------------|--------------|--------------|--------------|--------------|
|   | live binding | live binding | live binding | live binding |

Wasm exports can be imported as live bindings to other wasm modules.

#### Example

```
// main.wasm
(module
  (import "./counter.wasm" "count" (global i32))
  (import "./counter.wasm" "increment" (func $increment (result i32)))
)

// counter.wasm
(module
  (func $increment
    get_global 0
    i32.const 1
    i32.add
    set_global 0)
  (global (mut i32) i32.const 5)
  (export "count" (global 0))
  (export "increment" (func $increment)))
```

### wasm imports <- JS re-exports <- wasm exports

| export type | global       | memory       | table        | function     |
|-------------|--------------|--------------|--------------|--------------|
|   | live binding | live binding | live binding | live binding |

Any wasm exports that are re-exported via a JS module will be available to the other wasm module as live bindings. The memory location gets wrapped into a JS object (e.g. `WebAssembly.Global`) and then unwrapped to the memory location in the importing wasm module.

#### Example

```
// main.wasm
(module
  (import "./a.js" "memoryExport" (memory 0))
)

// a.js
export {memoryExport} from "./b.wasm";

// b.wasm
(module
  (memory 1)
  (export "memoryExport" (memory 0))
)
```

### JS <-> wasm cycle (where JS is higher in the module graph)

#### JS exports
| export type | value (not a WebAssembly.Global)* | global | memory | table | function |
|-|-------------------------------|--------|--------|-------|----------|
| | Error                         | Error  | Error  | Error | snapshot |

#### wasm exports
| export type | global       | memory       | table        | function     |
|-|--------------|--------------|--------------|--------------|
| | live binding | live binding | live binding | live binding |

1. JS module is parsed
1. wasm module is parsed
1. wasm module is instantiated. All exports are set to undefined.
1. JS module is instantiated. All imports (including functions) from the wasm module are memory locations holding undefined.
1. wasm module is evaluated. Snapshots of imports are taken. Exports are initialized.
1. JS module is evaluated. 

#### Example

```
// a.js
import {memoryExport} from "./b.wasm";
export function functionExport() {
    // do something with memory and DOM
}

// b.wasm
(module
  (memory 1)
  (export "memoryExport" (memory 0))
  (import "./a.js" "functionExport" (func $functionExport (result i32)))
)
```

### wasm <-> JS cycle (where wasm is higher in the module graph)

#### wasm exports
| export type | global       | memory       | table        | function     |
|-|--------------|--------------|--------------|--------------|
| | live binding | live binding | live binding | live binding |

#### JS exports
| export type | value (not a WebAssembly.Global)* | global | memory | table | function |
|-|-------------------------------|--------|--------|-------|----------|
| | Error                         | snapshot  | snapshot  | snapshot | snapshot |

1. wasm module is parsed
1. JS module is parsed
1. JS module is instantiated. 
1. wasm module is instantiated. All exports (including functions) from the wasm module are memory locations holding undefined.
1. JS module is evaluated. wasm exports are still undefined
1. wasm module is evaluated. 

#### Examples

```
// a.wasm
(module
  (memory 1)
  (export "memoryExport" (memory 0))
  (import "./b.js" "functionExport" (func $functionExport (result i32)))
)

// b.js
import {memoryExport} from "./a.wasm";
export function functionExport() {
    // do something with memory and DOM
}
```

### wasm <-> wasm cycle

| export type | global | memory | table | function |
|-|--------|--------|-------|----------|
| | Error  | Error  | Error | Error    |

@TODO explain why we need to throw on WebAssembly cycles
