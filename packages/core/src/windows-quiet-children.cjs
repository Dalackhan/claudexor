"use strict";
// Preloaded with `node --require` before a Windows npm vendor entry in a piped
// background capture (prepareHarnessCommand). The vendor's own spawn/spawnSync
// calls default `windowsHide` to true; a value the caller chose stays. Calls
// Node would reject reach it unchanged, so it reports its own argument error.
// Plain CommonJS: the selected vendor Node can be older than Claudexor's.
const childProcess = require("child_process");
const { syncBuiltinESMExports } = require("module");

const isOptions = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

for (const name of ["spawn", "spawnSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (file, args, options) {
    const argv = Array.prototype.slice.call(arguments);
    // Node takes options from the second argument when it is not an array or nullish.
    const index = Array.isArray(args) || args == null ? 2 : 1;
    const selected = argv[index];
    if (index === 2 && selected === undefined) argv[2] = { windowsHide: true };
    else if (isOptions(selected) && selected.windowsHide === undefined) {
      // Preserve descriptors and prototype without assigning through inherited
      // read-only properties or dropping non-enumerable options on older Node.
      argv[index] = Object.create(Object.getPrototypeOf(selected), {
        ...Object.getOwnPropertyDescriptors(selected),
        windowsHide: { value: true, enumerable: true, writable: true, configurable: true },
      });
    }
    return Reflect.apply(original, this, argv);
  };
  Object.defineProperty(childProcess[name], "name", { value: original.name, configurable: true });
}
// ESM `import { spawn } from "node:child_process"` reads these exports too.
syncBuiltinESMExports();
