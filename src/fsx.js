// То, чего нет в Node 12 (сборка агента для Windows 7, scripts/pack.mjs
// --bundle-node12), — с теми же именами и сигнатурами, что в новом Node:
// там, где оно есть, используется встроенное.
//
//   rmSync(path, { recursive, force }) — fs.rmSync появился в 14.14;
//   pipeline(...streams) → Promise     — node:stream/promises появился в 15.0.

import * as fs from 'node:fs';
import { join } from 'node:path';
import * as stream from 'node:stream';
import { promisify } from 'node:util';

function rmFallback(sPath, { recursive = false, force = false } = {}) {
  let oStat;
  try {
    oStat = fs.lstatSync(sPath);
  } catch (oError) {
    if (force && oError.code === 'ENOENT') return;
    throw oError;
  }
  if (!oStat.isDirectory()) {
    fs.unlinkSync(sPath);
    return;
  }
  if (!recursive) throw Object.assign(new Error(`Это каталог: ${sPath}`), { code: 'ERR_FS_EISDIR' });
  for (const sName of fs.readdirSync(sPath)) rmFallback(join(sPath, sName), { recursive, force });
  fs.rmdirSync(sPath);
}

export const rmSync = fs.rmSync ? fs.rmSync : rmFallback;
export { rmFallback };

export const pipeline = promisify(stream.pipeline);
