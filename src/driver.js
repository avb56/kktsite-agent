// Драйвер ДТО 10 через обёртку avb56/node-atol-wrapper.
//
// Обёртка не везёт драйвер с собой: загружает тот, что установлен на кассе
// (инсталлятор Атола), — так агент работает с той версией ДТО, что стоит у
// клиента. Начиная с ДТО 10.10.8.0 драйвер ещё и требует запущенную службу
// АТОЛ Connect (UEM) — без неё open() отвечает «…необходимо запустить службу
// UEMA», и эту ошибку кассир увидит как есть.
//
// Для тестов вместо обёртки подставляется подделка (fSetDriverFactory): сама
// обёртка — нативный модуль, и без драйвера и ККТ её не загрузить.

import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { aAtolDriverArchs, sArchMismatch } from './winreg.js';
import { fSettle } from './shtrih-drv.js';

const require = createRequire(import.meta.url);

let oWrapper = null;
let fFactory = null;
let oInfo = { loaded: false, path: null, version: null, error: null };

/** Подменить создание дескриптора драйвера (тесты). */
export function fSetDriverFactory(fNew, oNewInfo = { loaded: true, path: 'fake', version: 'fake' }) {
  fFactory = fNew;
  oInfo = { error: null, ...oNewInfo };
}

/**
 * Загрузить драйвер: из sPath (каталог или файл), без него — поиском, как у
 * обёрток Атола. Не бросает: агент поднимается и без драйвера, а причина
 * видна в serverInfo и в ответах на попытку подключить ККТ.
 */
export function oLoadDriver(sPath) {
  if (fFactory) return oInfo;
  try {
    oWrapper = require('node-atol-wrapper');
    oInfo = { ...oWrapper.loadLibrary(sPath || undefined), error: null };
    const sWarning = sWorldWritable(oInfo.path);
    if (sWarning) oInfo.warning = sWarning;
  } catch (oError) {
    const sMismatch = sArchHint();
    oInfo = {
      loaded: false,
      path: null,
      version: null,
      error: oError.message + (sMismatch ? `. ${sMismatch}` : ''),
      missing: !sMismatch && bNotInstalled(oError.message),
    };
  }
  return oInfo;
}

// Драйвера Атола просто нет (касса только со Штрихом) — не авария, страница
// об этом не кричит. Windows: нет ключа Атола в реестре; иначе — ни одного
// файла по путям поиска (а не «файл есть, но не грузится»).
export function bNotInstalled(sError, sPlatform = process.platform) {
  if (sPlatform === 'win32') return !aAtolDriverArchs().length;
  // Строки «  <путь>: <ошибка dlopen>». Нет самого файла — ошибка про сам
  // libfptr10 («…libfptr10.so: cannot open shared object file»); файл есть,
  // но не хватает зависимости — про другую библиотеку, это уже не «нет драйвера».
  const aTried = sError.split('\n').slice(1).filter((s) => s.trim());
  return aTried.length > 0 && aTried.every((s) => {
    const sDl = s.slice(s.indexOf(': ') + 2);
    return /^\S*fptr10\S*: cannot open shared object file/.test(sDl) || /\(no such file\)/i.test(sDl);
  });
}

// Windows: драйвер не загрузился, а в реестре — драйвер другой разрядности
// (64-битный процесс не загрузит 32-битную DLL и наоборот). Сказать прямо,
// что делать, вместо «library not found».
function sArchHint() {
  if (process.platform !== 'win32') return '';
  return sArchMismatch('Атола', aAtolDriverArchs());
}

// Windows: драйвера Атола не было при запуске, а потом его поставили — сразу
// сказать: разрядность не та или «перезапустите сервер» (драйвер загружается
// только при запуске). Реестр — не чаще раза в 30 с.
let nCheckedAt = 0;
export const oDriverInfo = () => {
  if (oInfo.missing && process.platform === 'win32' && Date.now() - nCheckedAt > 30000) {
    nCheckedAt = Date.now();
    const aArchs = aAtolDriverArchs();
    if (aArchs.length) {
      oInfo = { ...oInfo, missing: false, error: sArchMismatch('Атола', aArchs) || 'Драйвер Атола установлен после запуска сервера — перезапустите сервер, чтобы он загрузился' };
    }
  }
  return oInfo;
};

// Пакет Атола под Linux ставит библиотеку с правами 666: подменить её может
// любой пользователь ПК, а загрузит её процесс агента. Исправлять чужую
// установку агент не берётся, но молчать об этом нельзя.
function sWorldWritable(sPath) {
  if (!sPath || process.platform === 'win32') return null;
  try {
    return statSync(sPath).mode & 0o002
      ? `Библиотеку драйвера ${sPath} может изменить любой пользователь ПК (права ${(statSync(sPath).mode & 0o777).toString(8)}): так её можно подменить. Рекомендуется chmod 644.`
      : null;
  } catch {
    return null;
  }
}

/**
 * Дескриптор драйвера для одной ККТ: open / processJson / close промисами.
 * Выполнение заданий — асинхронное (processJsonAsync): печать чека занимает
 * секунды, и синхронный вызов на это время останавливал бы весь сервер.
 */
export function oCreateHandle() {
  if (fFactory) return fFactory();
  if (!oWrapper || !oInfo.loaded) {
    throw new Error(oInfo.error || 'Драйвер ДТО 10 не загружен');
  }
  const oFptr = new oWrapper.Fptr10();
  oFptr.create();
  return {
    fOpen(oSettings) {
      oFptr.setSettings(oSettings);
      oFptr.open();
    },
    pProcess(oTask) {
      return new Promise((fResolve, fReject) =>
        // Через setImmediate — как ответ драйвера Посцентра (shtrih-drv.js, fSettle).
        oFptr.processJsonAsync(oTask, fSettle(fResolve, fReject)));
    },
    fClose() {
      try { oFptr.close(); } catch { /* уже закрыт — не ошибка */ }
      oFptr.destroy();
    },
  };
}
