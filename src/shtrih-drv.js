// Штрих-М через штатный драйвер Посцентра (fr_drv_ng) — для ТС ПИоТ.
//
// Боевой ТС ПИоТ (ЕСМ от ЕСП) работает с ККТ через драйвер вендора: модуль
// драйвера libmp_ts_piot.so поднимает gRPC TSPIOTService на :4042, пока драйвер
// подключён к ККТ, и сообщает ЕСМ о сменах, проверках кодов и чеках, которые
// прошли его методами (README, «ТС ПИоТ и ККТ»). Поэтому ККТ с ТС ПИоТ агент
// держит драйвером: библиотеку грузит обёртка (node-atol-wrapper,
// ShtrihClassic) в процесс агента, и модуль ПИоТ работает отсюда.
//
// Драйвер ставит пользователь сам (как ДТО Атола); где он лежит — общая
// настройка shtrihDriverPath или KKT_AGENT_SHTRIH_DRIVER. Без пути —
// каталог node и системный путь поиска библиотек.
//
// Задания кассы выполняет по-прежнему kkt-core: его кадры Штриха идут в ККТ
// методом драйвера ExchangeBytes (oDriverSocket). То, что должен видеть ЕСМ
// (смена, проверка кода, чек), агент переводит на методы драйвера — сырые
// команды через ExchangeBytes драйвер ЕСМ не показывает (стенд, 22.11.2026).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let oWrapper = null;
let oInfo = { loaded: false, path: null, error: null };
let sLoadedFrom = null;

/** Загрузить драйвер Посцентра (один раз за жизнь процесса). Не бросает. */
export function oLoadShtrihDriver(sPath) {
  if (oInfo.loaded) return oInfo;
  try {
    oWrapper ??= require('node-atol-wrapper');
    const o = oWrapper.loadShtrihLibrary(sPath || undefined);
    sLoadedFrom = sPath || '';
    oInfo = { loaded: true, path: o.path, error: null };
  } catch (oError) {
    oInfo = { loaded: false, path: null, error: oError.message };
  }
  return oInfo;
}

export const oShtrihDriverInfo = () => ({ ...oInfo, requested: sLoadedFrom });

const N_NO_CONNECTION = 2;
const STX = 2, ENQ = 5, ACK = 6, NAK = 0x15;

/** Вызов метода драйвера промисом: { ResultCode, ResultCodeDescription, ...aOut }. */
export function pDrvCall(oDrv, sMethod, oProps = {}, aOut = []) {
  return new Promise((fResolve, fReject) => oDrv.call(sMethod, oProps, aOut, (oError, oResult) => (oError ? fReject(oError) : fResolve(oResult))));
}

const sHex = (a) => [...a].map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const aFromHex = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16));
const aFrame = (aBody) => { const a = [aBody.length, ...aBody]; return [STX, ...a, a.reduce((x, c) => x ^ c, 0)]; };

/**
 * «Сокет» kkt-core (send / onmessage / onopen / onclose, как pTcpSocket в
 * core.js) поверх драйвера: протокол Штриха (ENQ, кадр STX|LEN|CMD|DATA|LRC,
 * ACK) отыгрываем сами, а команду из кадра — CMD и DATA — драйвер передаёт в
 * ККТ методом ExchangeBytes и возвращает ответ ККТ без обрамления (тот же
 * вид, что ждёт kkt-core). Ошибку ККТ драйвер отдаёт кодом (ResultCode > 0)
 * без байтов — собираем ответ «команда, код ошибки». Нет связи (ResultCode < 0)
 * — сокет закрывается: устройство переподключит ККТ.
 */
export function oDriverSocket(oDrv, nPassword = 30) {
  let aIn = [];
  let pChain = Promise.resolve();
  let bClosed = false;
  const oSocket = {
    binaryType: 'arraybuffer', onmessage: null, onclose: null,
    set onopen(f) { f?.(); },
    get onopen() { return null; },
    async close() {
      if (bClosed) return;
      bClosed = true;
      oSocket.onclose?.();
    },
    send(u8a) {
      if (bClosed) return;
      aIn.push(...new Uint8Array(u8a.buffer ?? u8a, u8a.byteOffset ?? 0, u8a.byteLength ?? u8a.length));
      fDrain();
    },
  };
  const fReply = (a) => setImmediate(() => !bClosed && oSocket.onmessage?.({ data: new Uint8Array(a).buffer }));
  function fDrain() {
    while (aIn.length) {
      const b = aIn[0];
      if (b === ENQ) { aIn.shift(); fReply([NAK]); continue; } // готовы принять команду
      if (b === ACK || b === NAK) { aIn.shift(); continue; } // подтверждение нашего ответа
      if (b !== STX) { aIn.shift(); continue; }
      if (aIn.length < 2 || aIn.length < aIn[1] + 3) return; // кадр ещё не весь
      const aFrameIn = aIn.splice(0, aIn[1] + 3);
      const aBody = aFrameIn.slice(2, -1);
      fReply([ACK]);
      pChain = pChain.then(() => pExchange(aBody)).then((aAnswer) => aAnswer && fReply(aFrame(aAnswer)));
    }
  }
  async function pExchange(aBody) {
    const nCmdLen = aBody[0] === 0xFF ? 2 : 1;
    let oResult;
    try {
      oResult = await pDrvCall(oDrv, 'ExchangeBytes', { Password: nPassword, BinaryConversion: 1, TransferBytes: sHex(aBody) }, ['TransferBytes']);
    } catch (oError) {
      oResult = { ResultCode: -1, ResultCodeDescription: oError.message };
    }
    const aAnswer = aFromHex(oResult.TransferBytes);
    if (aAnswer.length > nCmdLen) return aAnswer;
    if (oResult.ResultCode > 0 && oResult.ResultCode < 256) return [...aBody.slice(0, nCmdLen), oResult.ResultCode];
    // Связи с ККТ у драйвера нет — для kkt-core это обрыв порта.
    oSocket.sLastError = oResult.ResultCodeDescription || 'драйвер Посцентра: нет связи с ККТ';
    oSocket.close();
    return null;
  }
  return oSocket;
}

/**
 * Открыть ККТ драйвером: контекст, Connect по адресу драйвера (как в «Тесте
 * драйвера»: tcp://192.168.137.111:7778?timeout=15000&protocol=v1,
 * serial://…). Возвращает { oDrv, pClose }.
 */
export async function pOpenDriver(sUri, nPassword = 30) {
  if (!oInfo.loaded) throw Object.assign(new Error(oInfo.error || 'Драйвер Посцентра (fr_drv_ng) не загружен — укажите его каталог в общих настройках'), { code: N_NO_CONNECTION });
  if (!sUri) throw Object.assign(new Error('Не задан адрес ККТ для драйвера Посцентра'), { code: N_NO_CONNECTION });
  const oDrv = new oWrapper.ShtrihClassic();
  const oConnect = await pDrvCall(oDrv, 'Connect', { Password: nPassword, ConnectionURI: sUri });
  if (oConnect.ResultCode !== 0) {
    oDrv.destroy();
    throw Object.assign(new Error(`Драйвер Посцентра не подключился к ККТ (${sUri}): ${oConnect.ResultCodeDescription}`), { code: N_NO_CONNECTION });
  }
  return {
    oDrv,
    async pClose() {
      await pDrvCall(oDrv, 'Disconnect').catch(() => {});
      oDrv.destroy();
    },
  };
}
