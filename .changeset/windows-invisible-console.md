---
"@claudexor/core": patch
"@claudexor/cli": patch
"@claudexor/harness-agy": patch
"@claudexor/harness-codex": patch
---

On Windows, background harness runs and captures start the vendor with an invisible
console instead of none, so the shells, `git`, MCP servers and other console programs
a run starts inherit it instead of opening windows of their own. Agy keeps the
console-less start because its print mode treats an openable console input as
interactive. Cancellation still stops the whole tree with `taskkill /T`, and a
background child now also ends when the daemon process dies. The no-Terminal sign-in
children (URL disclosure and the device-code app-server) open no console window, and
Codex quota and model discovery, the install version proof and the `login --help`
probe start their direct child hidden. The Node preload that defaulted `windowsHide`
inside npm wrappers is removed: the inherited console covers those children.
