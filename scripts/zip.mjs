// zip для Windows-архива выпуска (pack-windows.mjs) — свой, без зависимостей.
//
// Зачем свой: zip от bsdtar (`tar -a -cf x.zip`, прежний pack.mjs) Проводник
// Windows не открывал (заметка пользователя, 30.09.2026) — bsdtar пишет его
// потоком: с дескрипторами данных после содержимого и расширениями zip64.
// Здесь — самый простой вариант формата, который читает любой распаковщик:
//   — размеры и CRC32 — в локальном заголовке (файл сжимается целиком до записи);
//   — без zip64: архив меньше 4 ГБ и меньше 65535 записей, иначе — ошибка;
//   — deflate, а если сжатие не помогло — хранить как есть;
//   — имена — через «/» и только ASCII: флаг UTF-8 понимают не все
//     распаковщики (Info-ZIP показал кириллицу кракозябрами), а в архиве
//     выпуска других имён нет — встретилось иное, это ошибка сборки;
//   — «создан в MS-DOS», атрибуты: каталог 0x10, файл 0x20 (архивный).

import { createWriteStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const N_MAX = 0xffffffff;

function aDosTime(oDate) {
  const nTime = (oDate.getHours() << 11) | (oDate.getMinutes() << 5) | Math.floor(oDate.getSeconds() / 2);
  const nDate = ((Math.max(oDate.getFullYear(), 1980) - 1980) << 9) | ((oDate.getMonth() + 1) << 5) | oDate.getDate();
  return [nTime, nDate];
}

/** Записи каталога: [{ sName, sAbs | null (каталог) }], по алфавиту, каталоги перед содержимым. */
function aEntries(sSrcDir, sPrefix) {
  const aList = [];
  const fWalk = (sRel) => {
    const sAbs = join(sSrcDir, sRel);
    const bDir = statSync(sAbs).isDirectory();
    const sName = posix.join(sPrefix, sRel.split(sep).join('/')) + (bDir ? '/' : '');
    aList.push({ sName, sAbs: bDir ? null : sAbs });
    if (bDir) for (const sChild of readdirSync(sAbs).sort()) fWalk(join(sRel, sChild));
  };
  fWalk('');
  return aList;
}

function pWrite(oOut, oBuf) {
  return new Promise((fResolve, fReject) => {
    oOut.write(oBuf, (oError) => (oError ? fReject(oError) : fResolve()));
  });
}

/** Упаковать каталог sSrcDir в zip sOutFile; внутри — каталог sPrefix. */
export async function pWriteZip(sSrcDir, sOutFile, sPrefix) {
  const aList = aEntries(sSrcDir, sPrefix);
  if (aList.length >= 0xffff) throw new Error(`Слишком много записей для zip без zip64: ${aList.length}`);
  const [nTime, nDate] = aDosTime(new Date());
  const oOut = createWriteStream(sOutFile);
  const aCentral = [];
  let nOffset = 0;

  for (const { sName, sAbs } of aList) {
    if (!/^[\x20-\x7e]+$/.test(sName)) throw new Error(`Имя не ASCII — в zip выпуска не годится: ${sName}`);
    const oName = Buffer.from(sName, 'ascii');
    const nFlags = 0;
    let oData = Buffer.alloc(0);
    let nMethod = 0;
    let nCrc = 0;
    let nSize = 0;
    if (sAbs) {
      const oRaw = readFileSync(sAbs);
      nSize = oRaw.length;
      nCrc = crc32(oRaw);
      const oDeflated = deflateRawSync(oRaw, { level: 9 });
      [oData, nMethod] = oDeflated.length < oRaw.length ? [oDeflated, 8] : [oRaw, 0];
    }
    if (nOffset + 30 + oName.length + oData.length > N_MAX || nSize > N_MAX) {
      throw new Error('Архив больше 4 ГБ — для zip без zip64 не годится');
    }

    const oLocal = Buffer.alloc(30);
    oLocal.writeUInt32LE(0x04034b50, 0);
    oLocal.writeUInt16LE(20, 4); // нужна версия 2.0
    oLocal.writeUInt16LE(nFlags, 6);
    oLocal.writeUInt16LE(nMethod, 8);
    oLocal.writeUInt16LE(nTime, 10);
    oLocal.writeUInt16LE(nDate, 12);
    oLocal.writeUInt32LE(nCrc >>> 0, 14);
    oLocal.writeUInt32LE(oData.length, 18);
    oLocal.writeUInt32LE(nSize, 22);
    oLocal.writeUInt16LE(oName.length, 26);
    oLocal.writeUInt16LE(0, 28);
    await pWrite(oOut, oLocal);
    await pWrite(oOut, oName);
    if (oData.length) await pWrite(oOut, oData);

    const oCentral = Buffer.alloc(46);
    oCentral.writeUInt32LE(0x02014b50, 0);
    oCentral.writeUInt16LE(20, 4); // создан: MS-DOS, версия 2.0
    oCentral.writeUInt16LE(20, 6);
    oCentral.writeUInt16LE(nFlags, 8);
    oCentral.writeUInt16LE(nMethod, 10);
    oCentral.writeUInt16LE(nTime, 12);
    oCentral.writeUInt16LE(nDate, 14);
    oCentral.writeUInt32LE(nCrc >>> 0, 16);
    oCentral.writeUInt32LE(oData.length, 20);
    oCentral.writeUInt32LE(nSize, 24);
    oCentral.writeUInt16LE(oName.length, 28);
    oCentral.writeUInt16LE(0, 30); // extra
    oCentral.writeUInt16LE(0, 32); // комментарий
    oCentral.writeUInt16LE(0, 34); // диск
    oCentral.writeUInt16LE(0, 36); // внутренние атрибуты
    oCentral.writeUInt32LE(sAbs ? 0x20 : 0x10, 38);
    oCentral.writeUInt32LE(nOffset, 42);
    aCentral.push(oCentral, oName);

    nOffset += oLocal.length + oName.length + oData.length;
  }

  const oCentralDir = Buffer.concat(aCentral);
  if (nOffset + oCentralDir.length > N_MAX) throw new Error('Архив больше 4 ГБ — для zip без zip64 не годится');
  const oEnd = Buffer.alloc(22);
  oEnd.writeUInt32LE(0x06054b50, 0);
  oEnd.writeUInt16LE(0, 4);
  oEnd.writeUInt16LE(0, 6);
  oEnd.writeUInt16LE(aList.length, 8);
  oEnd.writeUInt16LE(aList.length, 10);
  oEnd.writeUInt32LE(oCentralDir.length, 12);
  oEnd.writeUInt32LE(nOffset, 16);
  oEnd.writeUInt16LE(0, 20);
  await pWrite(oOut, oCentralDir);
  await pWrite(oOut, oEnd);
  await new Promise((fResolve, fReject) => oOut.end((oError) => (oError ? fReject(oError) : fResolve())));
}
