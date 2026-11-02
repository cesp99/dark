// Loads a classic-script source file (which assigns to globalThis) into an isolated vm context.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../e2e/lib.mjs';

export function loadScript(rel, extraGlobals = {}) {
  const ctx = vm.createContext({ URL, console, ...extraGlobals });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  return ctx;
}
