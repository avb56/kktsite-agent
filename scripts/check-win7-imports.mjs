// Сборка для Windows 7: ни один .node не должен тянуть функции Windows 8+.
// Иначе на Windows 7 модуль не грузится — «The specified procedure could not be
// found» (0.2.10: node_atol_wrapper.node с GetSystemTimePreciseAsFileTime из
// std::mutex статической STL MSVC; агент не запускался).
//
//   node scripts/check-win7-imports.mjs <файл.node | каталог> …
//
// Читает таблицу импорта PE (обычную и отложенную) сам — dumpbin не нужен.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Функции KERNEL32 и др., которых нет в Windows 7 SP1 (появились в 8 / 8.1 / 10).
const A_WIN8_PLUS = new Set([
  'GetSystemTimePreciseAsFileTime', 'CreateFile2', 'GetCurrentThreadStackLimits', 'SetThreadDescription',
  'GetThreadDescription', 'PrefetchVirtualMemory', 'WaitOnAddress', 'WakeByAddressSingle', 'WakeByAddressAll',
  'GetOverlappedResultEx', 'CopyFile2', 'MapViewOfFileFromApp',
  'VirtualAllocFromApp', 'GetPackageFamilyName', 'GetCurrentPackageId', 'SetProcessMitigationPolicy',
  'GetProcessMitigationPolicy', 'GetSystemTimeAdjustmentPrecise', 'QueryUnbiasedInterruptTimePrecise',
  'DiscardVirtualMemory', 'OfferVirtualMemory', 'ReclaimVirtualMemory', 'GetFirmwareType', 'GetCurrentThreadStackLimits',
  'SetThreadInformation', 'GetThreadInformation', 'GetProcessInformation', 'SetProcessInformation',
]);

/** Импорт PE: [{ dll, fn }] (по порядковому номеру — fn = '#N'). */
export function aPeImports(oBuf) {
  if (oBuf.readUInt16LE(0) !== 0x5a4d) throw new Error('не PE (нет MZ)');
  const nPe = oBuf.readUInt32LE(0x3c);
  if (oBuf.readUInt32LE(nPe) !== 0x4550) throw new Error('не PE (нет PE\\0\\0)');
  const nSections = oBuf.readUInt16LE(nPe + 6);
  const nOptSize = oBuf.readUInt16LE(nPe + 20);
  const nOpt = nPe + 24;
  const b64 = oBuf.readUInt16LE(nOpt) === 0x20b;
  const nDirs = nOpt + (b64 ? 112 : 96);
  const aSec = [];
  for (let i = 0, n = nOpt + nOptSize; i < nSections; i++, n += 40) {
    aSec.push({ va: oBuf.readUInt32LE(n + 12), size: Math.max(oBuf.readUInt32LE(n + 8), oBuf.readUInt32LE(n + 16)), raw: oBuf.readUInt32LE(n + 20) });
  }
  const fOff = (nRva) => {
    const o = aSec.find((s) => nRva >= s.va && nRva < s.va + s.size);
    if (!o) throw new Error(`RVA ${nRva.toString(16)} вне секций`);
    return nRva - o.va + o.raw;
  };
  const fStr = (nRva) => { const n = fOff(nRva); return oBuf.toString('latin1', n, oBuf.indexOf(0, n)); };
  const fThunks = (nRva) => {
    const a = [];
    if (!nRva) return a;
    for (let n = fOff(nRva); ; n += b64 ? 8 : 4) {
      const v = b64 ? oBuf.readBigUInt64LE(n) : BigInt(oBuf.readUInt32LE(n));
      if (!v) return a;
      const bOrd = b64 ? v >> 63n : v >> 31n;
      a.push(bOrd ? `#${Number(v & 0xffffn)}` : fStr(Number(v & 0x7fffffffn) + 2));
    }
  };
  const aOut = [];
  const nImp = oBuf.readUInt32LE(nDirs + 8);
  if (nImp) {
    for (let n = fOff(nImp); oBuf.readUInt32LE(n + 12); n += 20) {
      const sDll = fStr(oBuf.readUInt32LE(n + 12));
      for (const fn of fThunks(oBuf.readUInt32LE(n) || oBuf.readUInt32LE(n + 16))) aOut.push({ dll: sDll, fn });
    }
  }
  const nDelay = oBuf.readUInt32LE(nDirs + 13 * 8);
  if (nDelay) {
    for (let n = fOff(nDelay); oBuf.readUInt32LE(n + 4); n += 32) {
      const sDll = fStr(oBuf.readUInt32LE(n + 4));
      for (const fn of fThunks(oBuf.readUInt32LE(n + 16))) aOut.push({ dll: sDll, fn, delay: true });
    }
  }
  return aOut;
}

function* aFiles(sPath) {
  if (statSync(sPath).isDirectory()) {
    for (const s of readdirSync(sPath)) yield* aFiles(join(sPath, s));
  } else if (sPath.endsWith('.node')) yield sPath;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-win7-imports.mjs')) {
  let nBad = 0, nFiles = 0;
  for (const sArg of process.argv.slice(2)) {
    for (const sFile of aFiles(sArg)) {
      const oBuf = readFileSync(sFile);
      // Готовые сборки пакетов под другие ОС (prebuilds linux, darwin) — не PE.
      if (oBuf.readUInt16LE(0) !== 0x5a4d) continue;
      nFiles++;
      const aBad = aPeImports(oBuf).filter((o) => !o.delay && A_WIN8_PLUS.has(o.fn));
      if (aBad.length) {
        nBad++;
        console.error(`${sFile}: функции Windows 8+ — ${aBad.map((o) => `${o.dll}!${o.fn}`).join(', ')}`);
      }
    }
  }
  if (!nFiles) { console.error('Нет модулей .node для Windows'); process.exit(1); }
  if (nBad) { console.error('На Windows 7 эти модули не загрузятся («The specified procedure could not be found»)'); process.exit(1); }
  console.log(`Импорт ${nFiles} модулей .node — только функции Windows 7`);
}
