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

When `Module.Instantiate` is called on a JavaScript module, a Lexical Environment is set up. Space for exports is allocated and the memory locations are bound to the export name. Additionally, any imports from dependencies are resolved. In JS, function declarations are initialized at this point. All other values are undefined or in [TDZ](http://2ality.com/2015/10/why-tdz.html) (i.e. would lead to a ReferenceError on access) until evaluation.

When `Module.Instantiate` is called on a WebAssembly module, the module will go through the same process. A Lexical Environment is set up, and all exports (for functions, tables, memories and globals) have a binding created for them, which is initialized to TDZ. This process is not WebAssembly module instantiation--WebAssembly validation is not run at this point, and the start function is not executed. Unlike in JavaScript, functions will not be initialized at this point. Function exports, like other exports, start out as TDZ. Initialization of these bindings to take them out of TDZ for all values happens during evaluation.

WebAssembly exports can be any one of the [external types](https://webassembly.github.io/spec/core/exec/modules.html#external-typing), which currently include:

- functions
- tables
- memories
- globals

WebAssembly does not currently have a type that can handle arbitrary JS values. This means that JS value imports can not be handled with live bindings and will be snapshotted when they are imported. This means that if a JS module changes one of its exports to point to a different object, a WebAssembly module importing that object will not see the change.

It may be possible to provide live bindings for JS values if an [`anyref`](https://github.com/WebAssembly/reference-types) type is added to WebAssembly.

### Evaluation

During evaluation, the code is evaluated to assign values to the exported bindings. In JS, this means running the top-level module code.

WebAssembly has explicit types for both imports and exports. The type of exports is used to populate the lexical environment with a JavaScript value based on the WebAssembly export, from the [WebAssembly JS API](https://webassembly.github.io/spec/js-api/index.html). The type of imports is used to type check or convert imports to the required WebAssembly type.

For WebAssembly, evaluation consists of:
- validating the WebAssembly module
- snapshotting all imports:
    - If any import is in TDZ, throw a ReferenceError exception
    - Type-check/coerce each imported value against the declared import type, per step 8 of the [*instantiate a WebAssembly module*](https://webassembly.github.io/spec/js-api/index.html#instantiate-a-webassembly-module) algorithm.
    - Initialize ("snapshot") the imported bindings to the checked/coerced value
- initializing the Wasm module, performing [Wasm module instantiation](https://webassembly.github.io/spec/core/appendix/embedding.html#embed-instantiate-module)
    - filling in memory using the data segment
    - filling in tables using elem segments
    - running the start function, which corresponds to running the top-level module code
- initializing all exports in the Lexical Environment to their analogous Wasm/JS API objects, per step 4 of the [*instantiate a WebAssembly module*](https://webassembly.github.io/spec/js-api/index.html#instantiate-a-webassembly-module) algorithm.

Because JS modules that the WebAssembly module imports from are already evaluated at this point, their values will be available for WebAssembly to snapshot (as long as the WebAssembly module was not in a cycle with the JS module, with the WebAssembly module's evaluation preceding the JS module's evaluation).

#### A note on snapshotting

For JavaScript ES modules, an export name is bound to a slot on the Module Record. For all of the values that we currently allow, this slot will contain a reference to another memory location, which contains the object (e.g. the `WebAssembly.Global` object that is being imported).

The term "snapshot" means that WebAssembly will snapshot the reference. This does result in an observable difference between the way JavaScript and WebAssembly handle updates. In JavaScript modules, it is possible for the exporting module to update an export to point to a different object. Other JavaScript modules that are importing that export will then get the new object. In contrast, while WebAssembly modules will see changes to the object that the export was first bound to (e.g. when the exporting module calls `WebAssembly.Global.prototype.set` to change the value), the WebAssembly module will never see updated bindings.

## Examples and explanation of import/export handling

Some imports are challenging to handle in the current WebAssembly specification. In this section, we will discuss each kind of export and what the specification described above means for how it is handled.

### wasm imports <- JS exports

When the Wasm module is evaluated, the exported value of the JS module is used in a way which is based on the import type declared in the WebAssembly module.

| import type | behavior |
|-------------|----------|
| global      | If the exported value is a WebAssembly.Global object, throw an exception if types mismatch, otherwise take that object as the import. Otherwise, if the imported type is `const`, cast the imported value to the appropriate numeric type, and create a new const global to hold the result. Otherwise, throw an exception. |
| memory      | Check that the exported value is a WebAssembly.Memory object which meets the type imported; use it if so, otherwise, throw an exception |
| table       | Check that the exported value is a WebAssembly.Table object which meets the type imported; use it if so, otherwise, throw an exception |
| function    | If the exported value is a WebAssembly exported function based on the same types, make use of it. Otherwise, [create a host function](https://webassembly.github.io/spec/js-api/index.html#create-a-host-function) out of the JS function which includes the casts implied by its type. |

While WebAssembly only has the concept of globals, JS could export either a regular JS value or a `WebAssembly.Global`.

The sequence of operations for a wasm module which depends on a JS module is as follows:

1. wasm module is parsed
1. JS module is parsed
1. JS module is instantiated. Function declaration exports are initialized. Other exports are set to undefined or are in TDZ.
1. wasm module has an exports lexical environment created. Imports are bound to memory locations but values are not snapshotted yet.
1. JS module is evaluated. All of its remaining exports (i.e. non-fuction values) are initialized. Any top-level statements are executed.
1. wasm module is instantiated and its start function runs. All imports are snapshotted. All exports are initialized.

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

| export type | imported value            |
|-------------|---------------------------|
| global      | WebAssembly.Global object |
| memory      | WebAssembly.Memory object |
| table       | WebAssembly.Table object  |
| function    | WebAssembly exported function |

Wasm bindings cannot be reassigned as it can in JS, so the exported value will not change in their object identity. But the value that it points to (e.g. `.value` in the case of `WebAssembly.Global`) can change.

1. JS module is parsed
1. wasm module is parsed
1. wasm module has a lexical environment created for its exports. All exports are initially in TDZ.
1. JS module is instantiated. Imports are bound to the same memory locations.
1. wasm module is instantiated evaluated. Functions are initialized. Memories and tables are initialized and filled with data/elem sections. Globals are initialized and initializer expressions are evaluated. The start function runs.
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

Wasm exports can be imported as accurate, immutable bindings to other wasm modules. Types between imports and exports must match. Types are checked in the "evaluation" phase, when they undergo Wasm instantiation.

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

Any wasm exports that are re-exported via a JS module will be available to the other wasm module as accurate, immutable bindings. The wasm export gets wrapped into a JS object (e.g. `WebAssembly.Global`) and then unwrapped to the wasm import in the importing wasm module. When imported from JS, the first and second Wasm modules will yield the same object identities for the multiply exported Wasm objects.

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
| | 0 if a const import and not in TDZ, otherwise Error | Error  | Error  | Error | snapshot if it is a function declaration, otherwise Error |

#### wasm exports
| export type | global       | memory       | table        | function     |
|-|--------------|--------------|--------------|--------------|
| | accurate binding | accurate binding | accurate binding | accurate binding |

1. JS module is parsed
1. wasm module is parsed
1. wasm module has a lexical environment created for its exports. All exports are initially in TDZ.
1. JS module is instantiated. All imports (including functions) from the wasm module are memory locations holding undefined.
1. wasm module is instantiated and evaluated. Snapshots of imports are taken. Export bindings are initialized.
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
| | accurate binding | accurate binding | accurate binding | accurate binding |

#### JS exports
| export type | value (not a WebAssembly.Global)* | global | memory | table | function |
|-|-------------------------------|--------|--------|-------|----------|
| | Error                         | snapshot  | snapshot  | snapshot | snapshot |

1. wasm module is parsed
1. JS module is parsed
1. JS module is instantiated. 
1. wasm module has a lexical environment created for its exports. All exports are initially in TDZ.
1. JS module is evaluated. wasm exports lead to a ReferenceError if used.
1. wasm module is instantiated and evaluated; wasm-exported bindings are updated to their appropriate JS API-exposed values. 

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

In this initial version of Wasm/ESM integration, a wasm<->wasm cycle is an error. There are two possible paths to possible circular Wasm module imports, described in the next section.

#### Break up instantiation into two phrases -- infeasible

A core design point of this proposal is that WebAssembly modules are instantiated one by one. The WebAssembly module instantiation path includes validation, type checking, reading imports, exposing exports and running the "start" function. By contrast, the JavaScript specification is broken up into two phases, one to identify and initialize the imports/exports, and one to make use of them. The difference is motivated, in part, by the fact that updating the bindings on the JavaScript end has fixed behavior--because the language is dynamically typed, the process is just updating a binding. By contrast, in WebAssembly, that binding needs to have its type checked.

In a planned WebAssembly feature, the [GC v1](https://github.com/WebAssembly/gc/blob/master/proposals/gc/MVP.md) proposal, WebAssembly will get the ability to import types from other modules. With this, at the time that types are being checked, it is essential that that type be available. To accommodate this proposal, circular modules which import types from each other are impossible. Instantiation must be one phase which happens together, including importing the actual types (not just abstract bindings over the types) to use in module type checking.

#### Use a trampoline to implement live bindings of functions -- possible follow-on proposal

Since instantiation is one-by-one, if we allow circular modules, it will not be possible to call a function from a module that has not yet been instantiated. So, from a start function, it would be necessary to check whether a function has been instantiated yet or not. WebAssembly is based on a design philosophy of no additional runtime overhead from dynamic checks. Including a check like this by default and trying to optimize it out sometimes would go contrary to that philosophy.

Instead of including this check in the default semantics of functions, a trampoline can be explicitly constructed which does this check and passes control on to the maybe-initialized function. Initially, this trampoline can be constructed by build tools like webpack. In a potential follow-on proposal, the trampoline may be generated natively, as part of the host-bindings proposal. See https://github.com/WebAssembly/esm-integration/issues/17 for details.
