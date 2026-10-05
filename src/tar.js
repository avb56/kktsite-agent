// tar.gz без зависимостей: упаковка (scripts/pack.mjs — сборка выпуска) и
// распаковка (update.js — обновление агента). В Node нет ни tar, ни zip, а
// системного tar может не быть (старые Windows) или он другой (bsdtar на
// macOS пишет свои заголовки) — поэтому свой, на формат, который пишем сами.
//
// Формат: ustar, длинные пути — расширенным заголовком pax (path=…).
// Распаковка понимает ещё GNU-заголовок длинного имени (L) и префикс ustar —
// на случай архива, собранного системным tar. Файлы, каталоги; ссылки и
// прочее пропускаются. Путь с «..» или абсолютный — ошибка: архив не может
// писать за пределы каталога распаковки.

import { createReadStream, createWriteStream, mkdirSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pipeline } from './fsx.js';
import { Readable, Writable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';

const N_BLOCK = 512;

// ——— упаковка ———

function oHeader({ sName, nSize, nMode, cType, nMtime }) {
  const o = Buffer.alloc(N_BLOCK);
  const fStr = (s, nOff, nLen) => o.write(s, nOff, nLen, 'utf8');
  const fOct = (n, nOff, nLen) => fStr(n.toString(8).padStart(nLen - 1, '0') + '\0', nOff, nLen);
  fStr(sName, 0, 100);
  fOct(nMode, 100, 8);
  fOct(0, 108, 8); // uid
  fOct(0, 116, 8); // gid
  fOct(nSize, 124, 12);
  fOct(nMtime, 136, 12);
  o.fill(' ', 148, 156); // контрольная сумма считается с пробелами на её месте
  fStr(cType, 156, 1);
  fStr('ustar\0', 257, 6);
  fStr('00', 263, 2);
  let nSum = 0;
  for (const n of o) nSum += n;
  fStr(nSum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return o;
}

const oPad = (nSize) => Buffer.alloc((N_BLOCK - (nSize % N_BLOCK)) % N_BLOCK);

function aPaxRecord(sKey, sValue) {
  // Длина записи включает саму себя: «<len> key=value\n».
  const sBody = ` ${sKey}=${sValue}\n`;
  let nLen = Buffer.byteLength(sBody) + 1;
  while (String(nLen).length + Buffer.byteLength(sBody) !== nLen) nLen = String(nLen).length + Buffer.byteLength(sBody);
  return Buffer.from(`${nLen}${sBody}`);
}

async function* aTarBlocks(sSrcDir, sPrefix) {
  const nMtime = Math.floor(Date.now() / 1000);
  const aStack = [''];
  while (aStack.length) {
    const sRel = aStack.pop();
    const sAbs = join(sSrcDir, sRel);
    const oStat = statSync(sAbs);
    const sName = posix.join(sPrefix, sRel.split(sep).join('/')) + (oStat.isDirectory() ? '/' : '');
    const bFile = oStat.isFile();
    if (!bFile && !oStat.isDirectory()) continue;
    if (Buffer.byteLength(sName) > 99) {
      const oPax = aPaxRecord('path', sName);
      yield oHeader({ sName: 'PaxHeader', nSize: oPax.length, nMode: 0o644, cType: 'x', nMtime });
      yield oPax;
      yield oPad(oPax.length);
    }
    // Права: исполняемость сохраняется (node, install.sh), остальное — стандартно.
    const nMode = oStat.isDirectory() ? 0o755 : (oStat.mode & 0o111 ? 0o755 : 0o644);
    yield oHeader({ sName: sName.slice(0, 99), nSize: bFile ? oStat.size : 0, nMode, cType: bFile ? '0' : '5', nMtime });
    if (bFile) {
      for await (const oChunk of createReadStream(sAbs)) yield oChunk;
      yield oPad(oStat.size);
    } else {
      // Обратный порядок в стеке — чтобы в архиве шло по алфавиту.
      for (const sChild of readdirSync(sAbs).sort().reverse()) aStack.push(join(sRel, sChild));
    }
  }
  yield Buffer.alloc(N_BLOCK * 2); // конец архива
}

/** Упаковать каталог sSrcDir в sOutFile (tar.gz); внутри — каталог sPrefix. */
export async function pPackTarGz(sSrcDir, sOutFile, sPrefix) {
  await pipeline(Readable.from(aTarBlocks(sSrcDir, sPrefix)), createGzip({ level: 9 }), createWriteStream(sOutFile));
}

// ——— распаковка ———

function sCString(oBuf, nOff, nLen) {
  const nEnd = oBuf.indexOf(0, nOff);
  return oBuf.toString('utf8', nOff, nEnd === -1 || nEnd > nOff + nLen ? nOff + nLen : nEnd);
}
const nOctal = (oBuf, nOff, nLen) => parseInt(sCString(oBuf, nOff, nLen).trim() || '0', 8);

/** Безопасный путь внутри sDestDir; nStrip — сколько верхних каталогов отбросить. */
function sSafePath(sDestDir, sName, nStrip) {
  const aParts = sName.split('/').filter((s) => s && s !== '.');
  if (sName.startsWith('/') || /^[A-Za-z]:/.test(sName) || aParts.includes('..')) {
    throw new Error(`Недопустимый путь в архиве: ${sName}`);
  }
  const aKept = aParts.slice(nStrip);
  if (!aKept.length) return null;
  const sPath = resolve(sDestDir, ...aKept);
  if (relative(sDestDir, sPath).startsWith('..')) throw new Error(`Недопустимый путь в архиве: ${sName}`);
  return sPath;
}

/**
 * Распаковать tar.gz в sDestDir потоком (архив с node — сотня мегабайт, в
 * память целиком не читаем). nStrip — отбросить верхние каталоги (как --strip-components).
 */
export async function pExtractTarGz(sArchive, sDestDir, { nStrip = 0 } = {}) {
  const sDest = resolve(sDestDir);
  mkdirSync(sDest, { recursive: true });
  let oPending = Buffer.alloc(0);
  let oEntry = null; // { nLeft, nPad, oOut, sPath, nMode, bFile, bMeta, aMeta }
  let sNextName = null; // имя из pax / GNU L для следующей записи
  let bEnd = false;

  // Ошибка записи файла запоминается одним обработчиком на поток и
  // проверяется на каждом шаге (обработчик на каждый drain копился бы).
  let oWriteError = null;
  const fThrowWriteError = () => { if (oWriteError) throw oWriteError; };
  const pWriteChunk = async (oOut, oChunk) => {
    if (!oOut.write(oChunk)) {
      // Ждём drain или close (ошибка записи) — и снимаем оба обработчика:
      // сработавший once снимается сам, второй копился бы на каждом чанке.
      await new Promise((fResolve) => {
        const fDone = () => { oOut.off('drain', fDone); oOut.off('close', fDone); fResolve(); };
        oOut.on('drain', fDone);
        oOut.on('close', fDone);
      });
    }
    fThrowWriteError();
  };
  // Ждать close, а не finish (колбэк end): finish — данные отданы, а
  // дескриптор файла ещё открыт. Запуск только что распакованного node в этот
  // момент Linux отклоняет — ETXTBSY (CI, 01.10.2026: самопроверка обновления).
  const pClose = async (oOut) => {
    await new Promise((fResolve) => { oOut.once('close', fResolve); oOut.end(); });
    fThrowWriteError();
  };

  async function pHandleHeader(oHeader) {
    if (oHeader.every((n) => n === 0)) { bEnd = true; return; }
    let nSum = 0;
    for (let n = 0; n < N_BLOCK; n += 1) nSum += n >= 148 && n < 156 ? 32 : oHeader[n];
    if (nSum !== nOctal(oHeader, 148, 8)) throw new Error('Архив повреждён: контрольная сумма заголовка');
    const cType = String.fromCharCode(oHeader[156] || 48);
    const nSize = nOctal(oHeader, 124, 12);
    const sPrefix = sCString(oHeader, 345, 155);
    let sName = sNextName ?? (sPrefix ? `${sPrefix}/` : '') + sCString(oHeader, 0, 100);
    const nPad = (N_BLOCK - (nSize % N_BLOCK)) % N_BLOCK;
    if (cType === 'x' || cType === 'L' || cType === 'g') {
      oEntry = { nLeft: nSize, nPad, bMeta: cType, aMeta: [] };
      return;
    }
    sNextName = null;
    const sPath = cType === '0' || cType === '5' ? sSafePath(sDest, sName, nStrip) : null;
    if (sPath && cType === '5') mkdirSync(sPath, { recursive: true });
    let oOut = null;
    if (sPath && cType === '0') {
      mkdirSync(dirname(sPath), { recursive: true });
      oOut = createWriteStream(sPath);
      oOut.on('error', (oError) => { oWriteError = oError; });
    }
    oEntry = { nLeft: nSize, nPad, oOut, sPath, nMode: nOctal(oHeader, 100, 8), bFile: cType === '0' };
    if (!nSize) await pFinishEntry();
  }

  async function pFinishEntry() {
    const o = oEntry;
    if (o.bMeta === 'x') {
      const sText = Buffer.concat(o.aMeta).toString('utf8');
      const aMatch = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(sText);
      if (aMatch) sNextName = aMatch[1];
    } else if (o.bMeta === 'L') {
      sNextName = sCString(Buffer.concat(o.aMeta), 0, Infinity);
    } else if (o.oOut) {
      await pClose(o.oOut);
      if (process.platform !== 'win32') chmodSync(o.sPath, o.nMode & 0o111 ? 0o755 : 0o644);
    }
    if (!o.nPad) oEntry = null;
    else oEntry = { nSkip: o.nPad };
  }

  const oSink = new Writable({
    async write(oChunk, _sEnc, fDone) {
      try {
        oPending = oPending.length ? Buffer.concat([oPending, oChunk]) : oChunk;
        while (oPending.length && !bEnd) {
          if (oEntry?.nSkip) {
            const nTake = Math.min(oEntry.nSkip, oPending.length);
            oPending = oPending.subarray(nTake);
            oEntry.nSkip -= nTake;
            if (!oEntry.nSkip) oEntry = null;
          } else if (oEntry) {
            const nTake = Math.min(oEntry.nLeft, oPending.length);
            const oPart = oPending.subarray(0, nTake);
            oPending = oPending.subarray(nTake);
            oEntry.nLeft -= nTake;
            if (oEntry.bMeta) oEntry.aMeta.push(Buffer.from(oPart));
            else if (oEntry.oOut) await pWriteChunk(oEntry.oOut, oPart);
            if (!oEntry.nLeft) await pFinishEntry();
          } else {
            if (oPending.length < N_BLOCK) break;
            const oHeader = oPending.subarray(0, N_BLOCK);
            oPending = oPending.subarray(N_BLOCK);
            await pHandleHeader(oHeader);
          }
        }
        fDone();
      } catch (oError) {
        fDone(oError);
      }
    },
    final(fDone) {
      fDone(oEntry && !bEnd ? new Error('Архив оборван') : null);
    },
  });
  await pipeline(createReadStream(sArchive), createGunzip(), oSink);
}
