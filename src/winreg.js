// Windows: какой драйвер ДТО 10 установлен — 64- или 32-разрядный.
//
// 64-битный процесс не загрузит 32-битную DLL (и наоборот), поэтому агент
// должен быть той же разрядности, что драйвер Атола на кассе (заметка
// пользователя, 30.09.2026: на кассах встречается 32-битный драйвер на 64-битной
// Windows). Установщик Атола пишет каталог установки в
// HKLM\SOFTWARE\ATOL\Drivers\10.0\KKT, значение INSTALL_DIR; 32-битный — в
// 32-битное представление реестра (WOW6432Node на 64-битной Windows).
// `reg query /reg:64` и `/reg:32` читают каждое представление явно.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const S_KEY = 'HKLM\\SOFTWARE\\ATOL\\Drivers\\10.0\\KKT';

const fRunReg = (aArgs) => execFileSync('reg', aArgs, { stdio: 'pipe', encoding: 'utf8' });

/** 64-битная ли Windows — и из 32-битного процесса тоже (PROCESSOR_ARCHITEW6432). */
export const bWindows64 = (oEnv = process.env) =>
  Boolean(oEnv.PROCESSOR_ARCHITEW6432) || /64/.test(oEnv.PROCESSOR_ARCHITECTURE || '');

/**
 * Разрядности установленного драйвера: ['x64'], ['ia32'], обе или ни одной.
 * На 32-битной Windows 64-битного представления нет, а /reg:64 там отвечает
 * тем же ключом — его не считаем.
 */
export function aAtolDriverArchs({ fRun = fRunReg, oEnv = process.env } = {}) {
  const aViews = bWindows64(oEnv) ? [['/reg:64', 'x64'], ['/reg:32', 'ia32']] : [['/reg:32', 'ia32']];
  const aFound = [];
  for (const [sView, sArch] of aViews) {
    try {
      if (/INSTALL_DIR/i.test(fRun(['query', S_KEY, '/v', 'INSTALL_DIR', sView]))) aFound.push(sArch);
    } catch { /* ключа нет — драйвера этой разрядности нет */ }
  }
  return aFound;
}

/** Какую половину агента ставить: x64, если есть 64-битный драйвер, иначе ia32. */
export function sChooseArch(aDriverArchs) {
  if (aDriverArchs.includes('x64')) return 'x64';
  if (aDriverArchs.includes('ia32')) return 'ia32';
  return '';
}

/** Первые байты файла (заголовок PE); нет файла — null. */
function aReadHead(sFile) {
  let nFd;
  try {
    nFd = openSync(sFile, 'r');
    const a = Buffer.alloc(4096);
    return a.subarray(0, readSync(nFd, a, 0, a.length, 0));
  } catch {
    return null;
  } finally {
    if (nFd !== undefined) closeSync(nFd);
  }
}

/** Разрядность DLL по заголовку PE: 'x64', 'ia32' или '' (нет файла, не PE). */
export function sPeArch(sFile, { fRead = aReadHead } = {}) {
  const a = fRead(sFile);
  if (!a || a.length < 0x40 || a.readUInt16LE(0) !== 0x5a4d) return ''; // MZ
  const nPe = a.readUInt32LE(0x3c);
  if (nPe + 6 > a.length || a.readUInt32LE(nPe) !== 0x4550) return ''; // PE\0\0
  return { 0x8664: 'x64', 0x14c: 'ia32' }[a.readUInt16LE(nPe + 4)] || '';
}

export const S_SHTRIH_DLL = 'classic_fr_drv_ng.dll';

/**
 * Разрядности найденных драйверов Посцентра (classic_fr_drv_ng.dll). Ключа в
 * реестре у него нет — смотрим DLL там, где её ищет обёртка: указанный путь
 * (настройка shtrihDriverPath), PATH и системные каталоги (System32 —
 * 64-битные, SysWOW64 — 32-битные; из 32-битного процесса настоящий System32 —
 * Sysnative).
 */
export function aShtrihDriverArchs({ sPath = '', oEnv = process.env, fArch = sPeArch } = {}) {
  const aFiles = [];
  if (sPath) aFiles.push(/\.dll$/i.test(sPath) ? sPath : join(sPath, S_SHTRIH_DLL));
  for (const sDir of String(oEnv.PATH || oEnv.Path || '').split(';')) if (sDir.trim()) aFiles.push(join(sDir.trim(), S_SHTRIH_DLL));
  const sRoot = oEnv.SystemRoot || oEnv.windir || 'C:\\Windows';
  for (const sDir of ['System32', 'SysWOW64', 'Sysnative']) aFiles.push(join(sRoot, sDir, S_SHTRIH_DLL));
  const aFound = [];
  for (const sFile of aFiles) {
    const sArch = fArch(sFile);
    if (sArch && !aFound.includes(sArch)) aFound.push(sArch);
  }
  return aFound;
}

const bIsDir = (s) => { try { return statSync(s).isDirectory(); } catch { return false; } };

/** classic_fr_drv_ng.dll в папке и ниже (архив драйвера: dist\win_…\x86_64\dynamic) — не глубже 6 уровней. */
export function aFindShtrihDll(sDir, { nDepth = 6, fList = (s) => readdirSync(s, { withFileTypes: true }) } = {}) {
  const aFound = [];
  let nDirs = 0; // указали корень диска — не обходить его весь
  const fWalk = (s, n) => {
    if (++nDirs > 2000) return;
    let aEntries = [];
    try { aEntries = fList(s); } catch { return; }
    for (const o of aEntries) {
      if (o.isFile() && o.name.toLowerCase() === S_SHTRIH_DLL) aFound.push(join(s, o.name));
      else if (o.isDirectory() && n > 0 && aFound.length < 20) fWalk(join(s, o.name), n - 1);
    }
  };
  fWalk(sDir, nDepth);
  return aFound;
}

// Библиотеки Microsoft Visual C++ 2015–2022, без которых не грузится сборка
// драйвера Посцентра под MSVC (импорты classic_fr_drv_ng.dll 1.6, сверено
// 26.11.2026); в архив драйвера они не входят.
const A_VC_RUNTIME = ['msvcp140.dll', 'vcruntime140.dll'];

/**
 * Драйвер Посцентра не загрузился (на Windows — «Windows error 126»: нет
 * модуля) — почему, словами: нет самого файла по указанному пути (и где он
 * лежит глубже — в архиве драйвера), или файл есть, но нет Visual C++ нужной
 * разрядности. '' — сказать нечего (путь не задан и файла нет — драйвер просто
 * не ставили). Разрядность DLL проверяет sArchMismatch, до этого.
 */
export function sShtrihLoadHint({ sPath = '', sOwn = process.arch === 'ia32' ? 'ia32' : 'x64', oEnv = process.env,
  fExists = existsSync, fDir = bIsDir, fFind = aFindShtrihDll, fArch = sPeArch } = {}) {
  const sBits = sOwn === 'x64' ? '64' : '32';
  const sArchDir = sOwn === 'x64' ? 'x86_64' : 'i386';
  const sRoot = oEnv.SystemRoot || oEnv.windir || 'C:\\Windows';
  let sFile = '';
  if (sPath) {
    sFile = /\.dll$/i.test(sPath) ? sPath : join(sPath, S_SHTRIH_DLL);
    if (!fExists(sFile)) {
      const sDir = fDir(sPath) ? sPath : '';
      const aFound = sDir ? fFind(sDir).filter((s) => fArch(s) === sOwn) : [];
      if (aFound.length) return `В «${sPath}» нет файла ${S_SHTRIH_DLL} — ${sBits}-разрядный лежит глубже. Укажите папку «${dirname(aFound[0])}»`;
      return `По пути «${sPath}» нет файла ${S_SHTRIH_DLL}. Укажите папку, где лежит сам файл: в архиве драйвера — ${sArchDir}\\dynamic (агент ${sBits}-разрядный)`;
    }
  } else {
    sFile = join(sRoot, 'System32', S_SHTRIH_DLL);
    if (!fExists(sFile)) return '';
  }
  const aMissing = A_VC_RUNTIME.filter((s) => !fExists(join(dirname(sFile), s)) && !fExists(join(sRoot, 'System32', s)));
  if (aMissing.length) {
    return `Файл драйвера есть, но не установлен Microsoft Visual C++ 2015–2022 (${sBits}-разрядный): нет ${aMissing.join(', ')}. `
      + `Поставьте vc_redist.${sOwn === 'x64' ? 'x64' : 'x86'}.exe с сайта Microsoft — агент подхватит драйвер сам в течение 30 с`;
  }
  return `Файл драйвера есть, но Windows не загрузила нужные ему библиотеки — распакуйте папку ${sArchDir}\\dynamic архива драйвера целиком`;
}

/**
 * Драйвер установлен, но другой разрядности, чем агент, — что делать.
 * aOwn — разрядности драйвера Атола (для подсказки про Посцентр: агент
 * переставлять нельзя, если с Атолом он совпадает). '' — разрядность в порядке.
 */
export function sArchMismatch(sDriver, aDriverArchs, { sOwn = process.arch === 'ia32' ? 'ia32' : 'x64', aAtolArchs = [] } = {}) {
  if (!aDriverArchs.length || aDriverArchs.includes(sOwn)) return '';
  const sBits = (s) => (s === 'x64' ? '64' : '32');
  const sHead = `Установлен ${sBits(aDriverArchs[0])}-разрядный драйвер ${sDriver}, а агент ${sBits(sOwn)}-разрядный`;
  if (sDriver !== 'Атола' && aAtolArchs.includes(sOwn)) {
    return `${sHead}: поставьте ${sBits(sOwn)}-разрядный драйвер ${sDriver} — агент той же разрядности, что драйвер Атола.`;
  }
  return `${sHead}: переустановите агента из Windows-архива — установщик выберет нужную разрядность.`;
}
