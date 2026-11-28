// COM-порт для kkt-core — в виде порта Web Serial: open, getInfo, readable /
// writable с getReader / getWriter, close. kkt-core работает с ККТ по Web
// Serial (src/kkt.js, pPortInit) — в браузере кассы и здесь одинаково.
//
// Порт — @serialport/bindings-cpp 10.8 (N-API 6): готовые сборки под Windows,
// Linux и macOS, и Node 12 (сборка агента для Windows 7) он тоже держит.
// Потоков WHATWG в Node 12 нет — reader и writer здесь свои, ровно с теми
// методами, которыми пользуется kkt-core: read, cancel, releaseLock, write.

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const require = createRequire(import.meta.url);

// Запись и закрытие — с пределом. Виртуальный порт без второй стороны
// (ComProxy Вики выключена, Windows, 28.11.2026) запись не завершает вовсе, а
// закрыть такой порт драйвер может не дать: ждущая команда, подключение и
// остановка агента висели без конца. Запись не прошла за N_WRITE_MS — порт
// неисправен: эта и следующие записи — ошибка, чтение обрывается (kkt-core
// прерывает команду). Закрытие не дождались — считаем закрытым.
export const oSerialLimits = { nWriteMs: 10e3, nCloseMs: 3e3 };

function pWithin(pWork, nMs, fOnLate) {
  let nTimer;
  return Promise.race([pWork, new Promise((fResolve, fReject) => {
    nTimer = setTimeout(() => {
      try { fResolve(fOnLate()); } catch (oError) { fReject(oError); }
    }, nMs);
  })]).finally(() => clearTimeout(nTimer));
}

let oBinding = null;
/** Тесты: подменить привязку serialport (list, open). */
export const fUseBinding = (o) => { oBinding = o; };
const oGetBinding = () => (oBinding ??= require('@serialport/bindings-cpp').autoDetect());

/**
 * Порты ПК: [{ path, vendorId, productId, manufacturer, serialNumber }]
 * (vendorId/productId — hex строкой). На Windows — и порты из реестра
 * (HKLM\HARDWARE\DEVICEMAP\SERIALCOMM), которых serialport не видит: он
 * перечисляет только устройства класса «Порты», а виртуальные порты (ComProxy
 * Вики, com0com и т. п.) там бывают не всегда — Фито их видел, агент нет
 * (28.11.2026). У таких портов есть только путь и имя устройства (device).
 */
export async function aListSerialPorts({ fRegQuery = pRegSerialComm } = {}) {
  const aPorts = await oGetBinding().list();
  if (process.platform !== 'win32' && fRegQuery === pRegSerialComm) return aPorts;
  const aMore = aParseSerialComm(await fRegQuery().catch(() => ''))
    .filter((o) => !aPorts.some((p) => p.path.toUpperCase() === o.path.toUpperCase()));
  return [...aPorts, ...aMore].sort((a, b) => nComNo(a.path) - nComNo(b.path));
}

const nComNo = (sPath) => Number(/^COM(\d+)$/i.exec(sPath)?.[1] ?? 1e6);

const pRegSerialComm = () => new Promise((fResolve, fReject) => execFile('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'],
  { timeout: 5e3, windowsHide: true }, (oError, sOut) => (oError ? fReject(oError) : fResolve(String(sOut)))).stdin?.end());

/** Строки `reg query …\SERIALCOMM`: «    \Device\com0com10    REG_SZ    COM10». */
export function aParseSerialComm(sOut) {
  const aOut = [];
  for (const sLine of String(sOut).split(/\r?\n/)) {
    const a = /^\s+(\S.*?)\s+REG_SZ\s+(COM\d+)\s*$/i.exec(sLine);
    if (a) aOut.push({ path: a[2].toUpperCase(), device: a[1].replace(/^\\Device\\/i, '') });
  }
  return aOut;
}

/**
 * Свободен ли порт: открыть и сразу закрыть. '' — свободен, иначе — почему
 * нет (на Windows занятый другой программой порт — «Access denied»).
 */
export async function sPortBusy(sPath) {
  let oPort;
  const pOpen = oGetBinding().open({ path: sPath, baudRate: 115200 });
  try {
    oPort = await pWithin(pOpen, 5e3, () => {
      pOpen.then((o) => o.close(), () => {}).catch(() => {});
      throw new Error('порт не открылся за 5 с');
    });
  } catch (oError) {
    return /Access denied|EBUSY|EACCES|Resource busy|Cannot lock port/i.test(oError.message)
      ? 'порт занят другой программой' : oError.message;
  }
  await pWithin(oPort.close().catch(() => {}), oSerialLimits.nCloseMs, () => {});
  return '';
}

/**
 * Порт Web Serial поверх COM-порта sPath. nBaudRate — для RS-232; USB VCOM
 * скорость не волнует. oInfo — { usbVendorId, usbProductId } для определения
 * типа ККТ (kkt-core смотрит на них прежде пинга).
 */
export function oSerialPort(sPath, { nBaudRate = 0, oInfo = {} } = {}) {
  let oPort = null;
  let bClosed = false;
  const aChunks = [];
  let fWake = null;
  let oReadError = null;
  let oWriteStuck = null;

  // Закрыть, но не ждать дольше nCloseMs: драйвер виртуального порта с
  // зависшей записью может держать закрытие сколько угодно.
  const pCloseBinding = () => (oPort?.isOpen
    ? pWithin(oPort.close().catch(() => {}), oSerialLimits.nCloseMs, () => {})
    : Promise.resolve());

  // Чтение — своим циклом в очередь; reader.read() берёт из неё.
  async function pReadLoop() {
    const aBuf = Buffer.alloc(4096);
    while (!bClosed && oPort?.isOpen) {
      try {
        const { bytesRead } = await oPort.read(aBuf, 0, aBuf.length);
        if (bytesRead) aChunks.push(Uint8Array.from(aBuf.subarray(0, bytesRead)));
      } catch (oError) {
        if (bClosed || oError.canceled) break;
        oReadError = oError;
        break;
      }
      fWake?.();
    }
    fWake?.();
  }

  const oReader = {
    async read() {
      for (;;) {
        if (aChunks.length) return { value: aChunks.shift(), done: false };
        if (oReadError) { const o = oReadError; oReadError = null; throw o; }
        if (bClosed) return { value: undefined, done: true };
        await new Promise((f) => { fWake = f; });
        fWake = null;
      }
    },
    async cancel() {
      bClosed = true;
      fWake?.();
      await pCloseBinding();
    },
    releaseLock() {},
  };
  const oWriter = {
    async write(u8a) {
      if (bClosed || !oPort?.isOpen) throw new Error('Порт ККТ закрыт');
      if (oWriteStuck) throw oWriteStuck;
      const pWrite = oPort.write(Buffer.from(u8a.buffer ?? u8a, u8a.byteOffset ?? 0, u8a.byteLength ?? u8a.length));
      await pWithin(pWrite, oSerialLimits.nWriteMs, () => {
        pWrite.catch(() => {});
        oWriteStuck = new Error(`Порт ${sPath} не принимает данные ${oSerialLimits.nWriteMs / 1000} с — на другом конце порта никого нет: ККТ выключена или, если порт виртуальный, не запущена программа, которая его создала (ComProxy). Включите её и переподключите ККТ`);
        oReadError ??= oWriteStuck;
        fWake?.();
        throw oWriteStuck;
      });
    },
    releaseLock() {},
  };

  return {
    sPath,
    getInfo: () => ({ ...oInfo }),
    async open({ baudRate } = {}) {
      oPort = await oGetBinding().open({ path: sPath, baudRate: nBaudRate || baudRate || 115200 });
      bClosed = false;
      pReadLoop();
    },
    get readable() { return { getReader: () => oReader }; },
    get writable() { return { getWriter: () => oWriter }; },
    async close() {
      bClosed = true;
      fWake?.();
      await pCloseBinding();
    },
    async forget() {},
  };
}
