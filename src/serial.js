// COM-порт для kkt-core — в виде порта Web Serial: open, getInfo, readable /
// writable с getReader / getWriter, close. kkt-core работает с ККТ по Web
// Serial (src/kkt.js, pPortInit) — в браузере кассы и здесь одинаково.
//
// Порт — @serialport/bindings-cpp 10.8 (N-API 6): готовые сборки под Windows,
// Linux и macOS, и Node 12 (сборка агента для Windows 7) он тоже держит.
// Потоков WHATWG в Node 12 нет — reader и writer здесь свои, ровно с теми
// методами, которыми пользуется kkt-core: read, cancel, releaseLock, write.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let oBinding = null;
const oGetBinding = () => (oBinding ??= require('@serialport/bindings-cpp').autoDetect());

/** Порты ПК: [{ path, vendorId, productId, manufacturer, serialNumber }] (vendorId/productId — hex строкой). */
export async function aListSerialPorts() {
  return oGetBinding().list();
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
      await oPort?.close().catch(() => {});
    },
    releaseLock() {},
  };
  const oWriter = {
    async write(u8a) {
      if (bClosed || !oPort?.isOpen) throw new Error('Порт ККТ закрыт');
      await oPort.write(Buffer.from(u8a.buffer ?? u8a, u8a.byteOffset ?? 0, u8a.byteLength ?? u8a.length));
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
      if (oPort?.isOpen) await oPort.close().catch(() => {});
    },
    async forget() {},
  };
}
