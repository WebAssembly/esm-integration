![Build Status](https://github.com/WebAssembly/spec/actions/workflows/main.yml/badge.svg)

# ES Module Integration Proposal for WebAssembly

This repository is a clone of github.com/WebAssembly/spec/. It is meant for discussion, prototype specification and implementation of a proposal to add ES module integration to WebAssembly.

The [specifics of the ES Module integration Proposal are found in this subfolder](/proposals/esm-integration).

A formatted version of the spec, including this proposal, is available here: [webassembly.github.io/esm-integration](https://webassembly.github.io/esm-integration).

> Note: It is possible to implement the Wasm-ESM integration in two stages. In the first stage only source phase imports of Wasm are supported (`import source fibModule from "./fib.wasm"`). In the second stage, evaluation phase imports would be supported too (`import { fib } from "./fib.wasm"`). If initially implementing just source phase imports, the `GetExportedNames`, `ResolveExport`, `InitializeEnvironment`, and `ExecuteModule` abstract operations can be implemented as abstract operations unconditionally throwing a `SyntaxError` exception. In this case, module fetch and CSP integration is still required to be implemented as specified in this proposal. Implementers are encouraged to ship both stages at once, but it is deemed OK for implementers to initially ship the first stage and then quickly follow up with the second stage, if this aids "time to ship" in implementations.

Original README from upstream repository follows...

# spec

This repository holds the sources for the WebAssembly draft specification
(to seed a future
[WebAssembly Working Group](https://lists.w3.org/Archives/Public/public-new-work/2017Jun/0005.html)),
a reference implementation, and the official testsuite.

A formatted version of the spec is available here:
[webassembly.github.io/spec](https://webassembly.github.io/spec/),

Participation is welcome. Discussions about new features, significant semantic
changes, or any specification change likely to generate substantial discussion
should take place in
[the WebAssembly design repository](https://github.com/WebAssembly/design)
first, so that this spec repository can remain focused. And please follow the
[guidelines for contributing](Contributing.md).

# citing

For citing WebAssembly in LaTeX, use [this bibtex file](wasm-specs.bib).
