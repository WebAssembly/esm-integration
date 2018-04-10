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

During instantiation, exports and imports are wired up to each other. In JS, functions are initialized at this point. All other values are undefined until evaluation.

For WebAssembly, instantiation will include initialization for all [external types](https://webassembly.github.io/spec/core/exec/modules.html#external-typing). External types currently include:

- functions
- tables
- memories
- globals

Because WebAssembly does not currently have a type that can handle arbitrary JS values, JS value imports can not be handled with live bindings and would be snapshotted when they are imported. This means that in the short term, non-function imports coming from JS modules would be assigned a value of `undefined`, which will currently result in an error. 

It may be possible to provide live bindings for JS values if an `any` type is added to WebAssembly. At this point the restriction prohibiting `undefined` imports could also be lifted. However, we would still want to throw an error for non-function imports in this case. 

The reason we want to throw an error in this case is two fold:

- **Reduce confusion for developers.** Since non-function imports work in JS->JS dependency chains, it is unintuitive that they would be undefined in JS->wasm dependency chains. Throwing an error makes clear what's happening.
- **Allow for future support.** It may be possible to support non-function imports to wasm modules if an `any` type is added. We close off this avenue if we allow users to import values that can be undefined, though, as code may start depending on that behavior.

One important limitation of this approach to instantiation is that function imports won't work in JS in JS<->wasm cycles where the JS module is higher in the graph. In that case, the WebAssembly module is instantiated before the JS module, which means that functions haven't been initialized and would throw the same error as non-function imports. 

Because of this, instantiation may need to be split into two separate sub-phases for WebAssembly. In this approach, the current instantiation algorithm would be run in the first sub-phase, ensuring that all JS functions are initialized. Then, in the second sub-phase, WebAssembly would be able to snapshot these function exports.

### Evaluation

During evaluation, the code is evaluated to assign values to the exported bindings. In JS, this means running the top-level module code.

For WebAssembly, evaluation consists of:
- filling in memory using the data segment
- filling in tables using elem segments
- running the start function, which corresponds to running the top-level module code

## Examples and explanation of import/export handling

Some imports are challenging to handle in the current WebAssembly specification. In this section, we will discuss each kind of export and what the specification described above means for how it is handled.

### wasm imports <- JS exports

| export type | value (not a WebAssembly.Global)* | global | memory | table | function |
|-------------|------------------|--------|--------|-------|----------|
|              | Error                         | Error  | Error  | Error | snapshot of reference |

\*While WebAssembly only has the concept of globals, JS could export either a regular JS value or a `WebAssembly.Global`.

The sequence of operations for a wasm module which depends on a JS module is as follows:

1. wasm module is parsed
1. JS module is parsed
1. JS module is instantiated. Functions are initialized. Non-function imports are set to undefined.
1. wasm module is instantiated. A snapshot is taken of all imports. Functions are copied. All non-function imports are undefined and thus throw an error.

Errors will happen automatically because the imports would be undefined, and WebAssembly currently does not support importing undefined values.

#### Examples

##### Function imports

```
// main.wasm
(module
  (import "./counter.js" "getCount" (func $getCount (result i32)))
)

// counter.js
let count = 42;

function getCount() {
    return count;
}
export {getCount};
```

##### Value imports

The following will result in an error.

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

The following will result in an error.

@TODO add example of JS exporting memory

### JS imports <- wasm exports

| export type | global       | memory       | table        | function     |
|-------------|--------------|--------------|--------------|--------------|
|   | const live binding | const live binding | const live binding | const live binding |

These are const live bindings because the binding can not be reassigned, but the value that it points to (e.g. in the case of `WebAssembly.Global`) can change. However, as the export is initialized during the wasm module instantiation, the JS side can bind to the memory location, so it gets a value even in the presence of cycles.

1. JS module is parsed
1. wasm module is parsed
1. wasm module is instantiated. Memories and tables are initialized but are not yet filled with data/elem sections. Globals are initialized and initializer expressions are evaluated. 
1. JS module is instantiated. All imports from wasm module are available as const live bindings. They are already initialized at this point.

Currently, the value of the export for something like `WebAssembly.Global` would be accessed using the `.value` property on the JS object. However, when host bindings are in place, these could be annotated with a host binding that turns it into a real live binding that points directly to the value's address. **If we did this, we would have first-class mutable live bindings.**

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
|   | live binding | const live binding | const live binding | const live binding |

Wasm exports can be imported as live bindings to other wasm modules.

#### Example

```
main.wasm
(module
  (type $t0 (func (result i32)))
  (import "./counter.wasm" "count" (global i32))
  (import "./counter.wasm" "increment" (func $increment (type $t0)))
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
|   | live binding | const live binding | const live binding | const live binding |

Any wasm exports that are re-exported via a JS module will be available to the other wasm module as live bindings. The memory location gets wrapped into a JS object (e.g. `WebAssembly.Global`) and then unwrapped to the memory location in the importing wasm module.

#### Example

@TODO add example

### JS <-> wasm cycle (where JS is higher in the module graph)

#### JS exports
| export type | value (not a WebAssembly.Global)* | global | memory | table | function |
|-|-------------------------------|--------|--------|-------|----------|
| | Error                         | Error  | Error  | Error | snapshot of reference (Note: will be an Error if we don't split instantiation into two phases) |

#### wasm exports
| export type | global       | memory       | table        | function     |
|-|--------------|--------------|--------------|--------------|
| | const live binding | const live binding | const live binding | const live binding |

1. JS module is parsed
1. wasm module is parsed
1. wasm module is instantiated. All imports from the JS module are undefined. Because JS module instantiation hasn't happened yet, the functions are also undefined.
1. JS module is instantiated. All imports from the wasm module are const live bindings.

#### Examples

@TODO add example

### wasm <-> JS cycle (where wasm is higher in the module graph)

#### wasm exports
| export type | global       | memory       | table        | function     |
|-|--------------|--------------|--------------|--------------|
| | const live binding | const live binding | const live binding | const live binding |

#### JS exports
| export type | value (not a WebAssembly.Global)* | global | memory | table | function |
|-|-------------------------------|--------|--------|-------|----------|
| | Error                         | Error  | Error  | Error | snapshot of reference |

#### Examples

@TODO add example

### wasm <-> wasm cycle

| export type | global | memory | table | function |
|-|--------|--------|-------|----------|
| | Error  | Error  | Error | Error    |

@TODO explain why we need to throw on WebAssembly cycles

#### Examples

@TODO add example
