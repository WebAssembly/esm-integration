## Examples and explanation of import/export handling

Some imports are challenging to handle in the current WebAssembly specification. In this section, we will discuss each kind of export and what the specification described above means for how it is handled.

### wasm imports <- JS exports

When the Wasm module is evaluated, the exported value of the JS module is used in a way which is based on the import type declared in the WebAssembly module.

| import type | behavior |
|-------------|----------|
| global      | If the exported value is a `WebAssembly.Global` object, throw an exception if types mismatch, otherwise take that object as the import. Otherwise, if the imported type is `const`, cast the imported value to the appropriate numeric type, and create a new const global to hold the result. Otherwise, throw an exception. |
| memory      | Check that the exported value is a `WebAssembly.Memory` object which meets the type imported; use it if so, otherwise, throw an exception |
| table       | Check that the exported value is a `WebAssembly.Table` object which meets the type imported; use it if so, otherwise, throw an exception |
| function    | If the exported value is a WebAssembly exported function based on the same types,  throw an exception if types mismatch, otherwise make use of it. Otherwise, [create a host function](https://webassembly.github.io/spec/js-api/index.html#create-a-host-function) out of the JS function which includes the casts implied by its type. |

While WebAssembly only has the concept of globals, JS could export either a regular JS value or a `WebAssembly.Global`.

The sequence of operations for a wasm module which depends on a JS module is as follows:

1. wasm module is parsed
1. JS module is parsed
1. JS module is instantiated. Function declaration exports are initialized. Other exports are set to undefined or are in TDZ.
1. wasm module has an exports lexical environment created. Imports are bound to memory locations but values are not snapshotted yet.
1. JS module is evaluated. All of its remaining exports (i.e. non-function values) are initialized. Any top-level statements are executed.
1. wasm module is instantiated and its start function runs. All imports are snapshotted. All exports are initialized.

Note: because these are snapshots of values, this does not maintain the live-binding semantics that exists between JS modules. For example, let's say JS module exports a function, called `foo`. The WebAssembly module imports `foo`. Then, after evaluation, the JS module sets `foo` to a different function. Other JS modules would see this update. However, WebAssembly modules will not.

#### Examples

##### Function imports

```wasm
;; main.wat --> main.wasm
(module
  (import "./counter.js" "getCount" (func $getCount (func (result i32))))
)
```
```js
// counter.js
let count = 42;

function getCount() {
    return count;
}
export {getCount};
```

##### Value imports

Constant:
```wasm
;; main.wat --> main.wasm
(module
  (import "./counter.js" "count" (global i32))
)
```
```js
// counter.js
let count = 42;
export {count};
```

Mutable:
```wasm
;; main.wat --> main.wasm
(module
  (import "./counter.js" "count" (global (mut i32)))
  (func (export "incrementCount")
    (global.set 0
      (i32.add
        (global.get 0)
        (i32.const 1))))
)
```
```js
// counter.js
export const count = new WebAssembly.Global({
  value: 'i32',
  mutable: true,
}, 42);
```

##### External type imports

```wasm
;; main.wat --> main.wasm
(module
  (import "./buffer.js" "buffer" (memory 1))
  (func (export "getFirstByte")
    (result i32)

    (i32.and
      (i32.load (i32.const 0))
      (i32.const 255)))
)
```
```js
// buffer.js
export const buffer = new WebAssembly.Memory({ initial: 1, maximum: 1 });

const length = 10;
const view = new Uint8Array(buffer.buffer, 0, length);
for (let index = 0; index < length; index++)
    view[index] = Math.random() > 0.5 ? 1 : 0;
```

### JS imports <- wasm exports

| export type | imported value            |
|-------------|---------------------------|
| global      | `WebAssembly.Global` object |
| memory      | `WebAssembly.Memory` object |
| table       | `WebAssembly.Table` object  |
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

```js
// main.js
import {count, increment} from "./counter.wasm";
console.log(count.value); // logs 5
increment();
console.log(count.value); // logs 6
```
```wasm
;; counter.wat --> counter.wasm
(module
  (func (export "increment")
    (global.set 0
      (i32.add
        (global.get 0)
        (i32.const 1))))
  (global (export "count") (mut i32) i32.const 5)
)
```

### wasm imports <- wasm exports

Wasm exports can be imported as accurate, immutable bindings to other wasm modules. Types between imports and exports must match. Types are checked in the "evaluation" phase, when they undergo Wasm instantiation.

#### Example

```wasm
;; main.wat --> main.wasm
(module
  (import "./counter.wasm" "count" (global i32))
  (import "./counter.wasm" "increment" (func $increment (result i32)))
)

;; counter.wat --> counter.wasm
(module
  (func (export "increment")
    (global.set 0
      (i32.add
        (global.get 0)
        (i32.const 1))))
  (global (export "count") (mut i32) i32.const 5)
)
```

### wasm imports <- JS re-exports <- wasm exports

Any wasm exports that are re-exported via a JS module will be available to the other wasm module as accurate, immutable bindings. The wasm export gets wrapped into a JS object (e.g. `WebAssembly.Global`) and then unwrapped to the wasm import in the importing wasm module. When imported from JS, the first and second Wasm modules will yield the same object identities for the multiply exported Wasm objects.

#### Example

```wasm
;; main.wat --> main.wasm
(module
  (import "./a.js" "memoryExport" (memory 0))
)
```
```js
// a.js
export {memoryExport} from "./b.wasm";
```
```wasm
;; b.wat --> b.wasm
(module
  (memory 1)
  (export "memoryExport" (memory 0))
)
```

### JS <-> wasm cycle (where JS is higher in the module graph)

#### JS exports
| export type | value (not a `WebAssembly.Global`)* | global | memory | table | function |
|-|-------------------------------|--------|--------|-------|----------|
| | `Error` | `Error`  | `Error`  | `Error` | snapshot if it is a function declaration, otherwise `Error` |

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

```js
// a.js
import {memoryExport} from "./b.wasm";
export function functionExport() {
    // do something with memory and DOM
}
```
```wasm
;; b.wat --> b.wasm
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
| | If the value is a Number or BigInt, it will be converted appropriately. Otherwise `Error`. | snapshot  | snapshot  | snapshot | snapshot |

1. wasm module is parsed
1. JS module is parsed
1. JS module is instantiated. 
1. wasm module has a lexical environment created for its exports. All exports are initially in TDZ.
1. JS module is evaluated. wasm exports lead to a ReferenceError if used.
1. wasm module is instantiated and evaluated; wasm-exported bindings are updated to their appropriate JS API-exposed values. 

#### Examples

```wasm
;; a.wat --> a.wasm
(module
  (memory 1)
  (export "memoryExport" (memory 0))
  (import "./b.js" "functionExport" (func $functionExport (result i32)))
)
```
```js
// b.js
import {memoryExport} from "./a.wasm";
export function functionExport() {
    // do something with memory and DOM
}
```

