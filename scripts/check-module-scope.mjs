// A function written at column 0 is meant to be at module scope. A patch hunk
// applied at the wrong offset can leave it inside another function's body: the
// file still parses, `node --check` is happy, tests that never load the module
// still pass, and the first call from module scope throws "<name> is not
// defined" in the user's editor. Turntrail 0.18.2 shipped exactly that.
//
// So: evaluate each CommonJS module of the extension without its module
// wrapper, so that every module-scope function declaration becomes a global
// of the sandbox, then check that every column-0 function is one of them.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Module = require('module');

// Enough of the VS Code API for the modules to load.
const stubVscode = {
  EventEmitter: class {
    constructor() {
      this.event = () => {};
    }
    fire() {}
  },
  window: {},
  workspace: {},
  commands: { executeCommand: () => {} },
  env: {},
  Uri: { parse: (value) => value },
  ViewColumn: { Active: 1 },
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1 }
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return stubVscode;
  return load.call(this, request, ...rest);
};

// An alternative directory can be named, to check a copy of the modules.
const src = process.argv[2]
  ? path.resolve(process.argv[2]) + path.sep
  : fileURLToPath(new URL('../packages/vscode/src/', import.meta.url));
const files = fs.readdirSync(src).filter((name) => name.endsWith('.cjs')).sort();
const declared = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;

let failed = 0;
for (const name of files) {
  const filePath = path.join(src, name);
  const source = fs.readFileSync(filePath, 'utf8');
  // The webviews' page scripts sit inside template literals and are checked
  // by check-webview-scripts; a function written at column 0 there is not a
  // module function. Blank the literals out, keeping their line breaks so the
  // reported line numbers stay right.
  const scanned = source.replace(/`(?:[^`\\]|\\[\s\S])*`/g, (literal) => `\`${literal.slice(1, -1).replace(/[^\n]/g, '')}\``);
  const expected = [...scanned.matchAll(declared)].map((match) => match[1]);
  if (expected.length === 0) continue;

  const moduleRequire = createRequire(filePath);
  const sandbox = {
    require: moduleRequire,
    module: { exports: {} },
    exports: {},
    __filename: filePath,
    __dirname: path.dirname(filePath),
    process,
    console,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    queueMicrotask,
    structuredClone,
    fetch: globalThis.fetch,
    performance
  };
  sandbox.exports = sandbox.module.exports;
  const context = vm.createContext(sandbox);

  try {
    new vm.Script(source, { filename: filePath }).runInContext(context);
  } catch (error) {
    failed++;
    console.error(`${name}: could not be evaluated for the scope check - ${error.message}`);
    continue;
  }

  const missing = expected.filter((fn) => typeof context[fn] !== 'function');
  if (missing.length > 0) {
    failed++;
    for (const fn of missing) {
      const line = source.slice(0, source.search(new RegExp(`^(?:async\\s+)?function\\s*\\*?\\s*${fn}\\s*\\(`, 'm'))).split('\n').length;
      console.error(`${name}:${line}: function ${fn} is written at column 0 but is not at module scope`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} module(s) have a function that is not where it reads as being.`);
  process.exit(1);
}
console.log(`Module scope verified for ${files.length} extension module(s).`);
