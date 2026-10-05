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
