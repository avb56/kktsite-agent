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

import { bDebugOn } from './debug.js';
import { aAtolDriverArchs, aShtrihDriverArchs, sArchMismatch } from './winreg.js';

const require = createRequire(import.meta.url);

let oWrapper = null;
let oInfo = { loaded: false, path: null, error: null };
let sLoadedFrom = null;
let sTriedPath = null; // с какого пути пробовали в последний раз (не вышло)
let nTriedAt = 0;

/** Загрузить драйвер Посцентра (один раз за жизнь процесса). Не бросает. */
export function oLoadShtrihDriver(sPath) {
  if (oInfo.loaded) return oInfo;
  sTriedPath = sPath || '';
  nTriedAt = Date.now();
  try {
    oWrapper ??= require('node-atol-wrapper');
    const o = oWrapper.loadShtrihLibrary(sPath || undefined);
    sLoadedFrom = sPath || '';
    oInfo = { loaded: true, path: o.path, error: null };
  } catch (oError) {
    // Windows: драйвер Посцентра есть, но другой разрядности — сказать, что делать.
    const sMismatch = process.platform === 'win32'
      ? sArchMismatch('Посцентра', aShtrihDriverArchs({ sPath }), { aAtolArchs: aAtolDriverArchs() })
      : '';
    oInfo = { loaded: false, path: null, error: oError.message + (sMismatch ? `. ${sMismatch}` : ''), archError: sMismatch };
  }
  return oInfo;
}

// Драйвер поставили (или переставили другой разрядности) после запуска
// агента — пробуем снова, не чаще раза в 30 с: подключится без перезапуска, а
// страница покажет, если разрядность не та.
function fRetryLoad() {
  if (!oInfo.loaded && sTriedPath !== null && Date.now() - nTriedAt > 30000) oLoadShtrihDriver(sTriedPath);
}

export const oShtrihDriverInfo = () => {
  fRetryLoad();
  return { ...oInfo, requested: sLoadedFrom };
};

const N_NO_CONNECTION = 2;
const STX = 2, ENQ = 5, ACK = 6, NAK = 0x15;

/**
 * Ответ обёртки драйвера — дальше через setImmediate. node-atol-wrapper зовёт
 * колбэк в обход MakeCallback (Nan::Call в HandleOKCallback), и Node после него
 * не выполняет микрозадачи: продолжение await ждало до следующего события —
 * запроса кассы или таймера. На Windows 7 (Node 12) так каждая команда ККТ
 * стояла до 1 с, опрос — 2,9 с вместо 0,2 (стенд, 24.11.2026). setImmediate Node
 * зовёт как положено, и после него микрозадачи выполняются сразу.
 */
export const fSettle = (fResolve, fReject) => (oError, vResult) => setImmediate(() => (oError ? fReject(oError) : fResolve(vResult)));

/** Вызов метода драйвера промисом: { ResultCode, ResultCodeDescription, ...aOut }. */
export function pDrvCall(oDrv, sMethod, oProps = {}, aOut = []) {
  return new Promise((fResolve, fReject) => oDrv.call(sMethod, oProps, aOut, fSettle(fResolve, fReject)));
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
const R_NO_LINK = /связ|connect|порт|port|timeout|таймаут|not connected/i;

export function oDriverSocket(oDrv, nPassword = 30, fLog = () => {}) {
  let aIn = [];
  let pChain = Promise.resolve();
  let bClosed = false;
  let nPending = 0; // команд у драйвера без ответа
  const oSocket = {
    binaryType: 'arraybuffer', onmessage: null, onclose: null,
    set onopen(f) { f?.(); },
    get onopen() { return null; },
    /** Закрыт (драйвер потерял ККТ) — кадры больше никуда не идут. */
    get bClosed() { return bClosed; },
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
      // ENQ: NAK — готовы принять команду; ACK — команда ещё у драйвера (долгая
      // печать), ответ будет: иначе kkt-core решил бы, что ответ потерян.
      if (b === ENQ) { aIn.shift(); fReply([nPending ? ACK : NAK]); continue; }
      if (b === ACK || b === NAK) { aIn.shift(); continue; } // подтверждение нашего ответа
      if (b !== STX) { aIn.shift(); continue; }
      if (aIn.length < 2 || aIn.length < aIn[1] + 3) return; // кадр ещё не весь
      const aFrameIn = aIn.splice(0, aIn[1] + 3);
      const aBody = aFrameIn.slice(2, -1);
      fReply([ACK]);
      nPending += 1;
      pChain = pChain.then(() => pExchange(aBody)).then((aAnswer) => { nPending -= 1; if (aAnswer) fReply(aFrame(aAnswer)); });
    }
  }
  const oState = { n2106: 0 }; // 2106 последней проверки кода — для ответа FF69h
  async function pExchange(aBody) {
    const nCmdLen = aBody[0] === 0xFF ? 2 : 1;
    let oResult;
    let aAnswer;
    try {
      const oMethod = process.env.KKT_AGENT_DRV_RAW ? null : oMethodFor(aBody, nCmdLen, oState);
      if (oMethod) {
        // Подготовка (кассир в таблицу ККТ): её сбой — в журнал, команда идёт дальше.
        for (const oPre of oMethod.aPre ?? []) {
          const oPreResult = await pDrvCall(oDrv, oPre.sMethod, oPre.oProps);
          if (oPreResult.ResultCode !== 0) fLog(`Драйвер Посцентра: ${oPre.sMethod} — ${oPreResult.ResultCode} ${oPreResult.ResultCodeDescription}`, 'warn');
          else oPre.fDone?.();
        }
        const nAt = Date.now();
        oResult = await pDrvCall(oDrv, oMethod.sMethod, oMethod.oProps, oMethod.aOut ?? []);
        if (bDebugOn()) fLog(`Драйвер Посцентра [отладка]: ${oMethod.sMethod} ${JSON.stringify({ ...oMethod.oProps, BarCode: undefined, BarcodeHex: undefined, TLVData: undefined })} → ${JSON.stringify({ ...oResult, TLVData: oResult.TLVData?.length })}, ${Date.now() - nAt} мс`);
        if (oResult.ResultCode === 0) return [...aBody.slice(0, nCmdLen), 0, ...(oMethod.fAnswer?.(oResult) ?? [])];
        fLog(`Драйвер Посцентра: ${oMethod.sMethod} — ${oResult.ResultCode} ${oResult.ResultCodeDescription}${oMethod.sDiag ? ` (${oMethod.sDiag})` : ''}${bDebugOn() ? ' ' + JSON.stringify(oResult) : ''}`, 'warn');
      } else {
        const nAt = Date.now();
        oResult = await pDrvCall(oDrv, 'ExchangeBytes', { Password: nPassword, BinaryConversion: 1, TransferBytes: sHex(aBody) }, ['TransferBytes']);
        aAnswer = aFromHex(oResult.TransferBytes);
        // Команда (без пароля) и ответ — код и длина: данные чека в журнал не нужны.
        if (bDebugOn()) fLog(`Драйвер Посцентра [отладка]: ExchangeBytes ${sHex(aBody.slice(0, nCmdLen))}h → ${oResult.ResultCode}${aAnswer.length ? `, ответ ${aAnswer.length} байт` : ''}, ${Date.now() - nAt} мс`);
      }
    } catch (oError) {
      oResult = { ResultCode: -1, ResultCodeDescription: oError.message };
    }
    aAnswer ??= [];
    if (aAnswer.length > nCmdLen) return aAnswer;
    if (oResult.ResultCode > 0 && oResult.ResultCode < 256) return [...aBody.slice(0, nCmdLen), oResult.ResultCode];
    // Отказ самого драйвера (не ККТ и не связь): для kkt-core — «внутренняя
    // ошибка ПО» (39h), текст драйвера — в журнал.
    if (!R_NO_LINK.test(oResult.ResultCodeDescription || '')) {
      fLog(`Драйвер Посцентра: ${sHex(aBody.slice(0, nCmdLen))}h — ${oResult.ResultCode} ${oResult.ResultCodeDescription}`, 'warn');
      return [...aBody.slice(0, nCmdLen), 0x39];
    }
    // Связи с ККТ у драйвера нет — для kkt-core это обрыв порта.
    oSocket.sLastError = oResult.ResultCodeDescription || 'драйвер Посцентра: нет связи с ККТ';
    fLog(`Драйвер Посцентра: нет связи с ККТ — ${oSocket.sLastError}; переподключаю`, 'warn');
    oSocket.close();
    return null;
  }
  return oSocket;
}

const nLe = (a) => a.reduce((n, b, i) => n + b * 2 ** (8 * i), 0);
const aLe = (n, nLen) => Array.from({ length: nLen }, (_, i) => Math.floor(Number(n) / 2 ** (8 * i)) % 256);
// Код маркировки — драйверу байтами (BarcodeHex, «30 31 … 1D …»): в текстовом
// BarCode разделитель GS теряется, и ККТ отвечает D3h «ошибка формата GS1»
// (блок табака 8005, Win7, 24.11.2026); так передаёт и руководство драйвера.
const sHexBytes = (a) => a.map((n) => n.toString(16).toUpperCase().padStart(2, '0')).join(' ');
/** CP866 → строка: кириллица и Ёё; прочее за пределами ASCII — «?». */
const sCp866 = (a) => a.map((n) => (n < 0x80 ? String.fromCharCode(n)
  : n <= 0xAF ? String.fromCharCode(0x410 + n - 0x80)
    : n >= 0xE0 && n <= 0xEF ? String.fromCharCode(0x440 + n - 0xE0)
      : n === 0xF0 ? 'Ё' : n === 0xF1 ? 'ё' : '?')).join('');

/** Ответ FF61h из свойств драйвера: 2004, причина, 2100, длина доп. данных, код ФН онлайн-проверки, 2106, TLV ОИСМ. */
function fCheckAnswer(o, oState) {
  const aHead = [o.CheckItemLocalResult & 255, o.CheckItemLocalError & 255, o.MarkingType2 & 255];
  oState.n2106 = o.KMServerCheckingStatus >= 0 ? o.KMServerCheckingStatus : 0;
  if (o.KMServerErrorCode < 0) return [...aHead, 0];
  const aOism = o.KMServerErrorCode === 0 && o.TLVData ? [...o.TLVData] : [];
  return [...aHead, 2 + aOism.length, o.KMServerErrorCode & 255, oState.n2106 & 255, ...aOism];
}

/**
 * Команды Штриха, которые должен видеть ТС ПИоТ, — методами драйвера: модуль
 * ПИоТ сообщает ЕСМ только о том, что прошло ими (смена, кассир, проверка
 * кода, чек с кодами). Методы драйвера повторяют команды протокола: данные
 * кадра kkt-core (после пароля) раскладываем в свойства, ответ ККТ собираем
 * из свойств в том виде, что разбирает kkt-core (shtrih/parser.js). Прочие
 * команды — как есть, ExchangeBytes. null — не наша.
 */
export function oMethodFor(aBody, nCmdLen, oState = {}) {
  const nCmd = nCmdLen === 2 ? 0xFF00 | aBody[1] : aBody[0];
  const nPassword = nLe(aBody.slice(nCmdLen, nCmdLen + 4));
  const a = aBody.slice(nCmdLen + 4);
  const oPwd = { Password: nPassword };
  // Открывается или закрывается смена (FF41h/FF42h … E0h/41h): только тогда
  // кассир идёт в таблицу 2 — в открытом чеке ККТ запись таблиц отвергает
  // (74h «Открыт чек», стенд 22.11.2026), а ЕСМ кассира берёт лишь при смене.
  if (nCmd !== 0xFF0C) oState.bShift = nCmd === 0xFF41 || nCmd === 0xFF42;
  switch (nCmd) {
    // Реквизит в документ (кассир 1021, его ИНН 1203 и др.) — методом FNSendTLV.
    // Кассира ЕСМ драйвер берёт не из 1021: после открытия и закрытия смены он
    // читает имя оператора из таблицы 2 (строка — пароль, поле 2) и шлёт его
    // (NotifyCashier). Поэтому кассира из задания (1021, CP866) пишем и туда —
    // при открытии и закрытии смены, только когда сменился. ИНН (1203) в таблице 2 Ритейла нет — ЕСМ его не
    // получит (стенд, 22.11.2026).
    case 0xFF0C: {
      const oMethod = { sMethod: 'FNSendTLV', oProps: { ...oPwd, TLVData: Buffer.from(a) } };
      if (oState.bShift && nLe(a.slice(0, 2)) === 1021 && nPassword >= 1 && nPassword <= 30) {
        const sName = sCp866(a.slice(4, 4 + nLe(a.slice(2, 4)))).trim().slice(0, 64);
        const sKey = `${nPassword}:${sName}`;
        if (sName && oState.sCashier !== sKey) {
          oMethod.aPre = [{
            sMethod: 'WriteTable',
            oProps: { ...oPwd, TableNumber: 2, RowNumber: nPassword, FieldNumber: 2, ValueOfFieldString: sName },
            fDone: () => { oState.sCashier = sKey; },
          }];
        }
      }
      return oMethod;
    }
    case 0xFF41: return { sMethod: 'FNBeginOpenSession', oProps: oPwd };
    case 0xE0: return { sMethod: 'FNOpenSession', oProps: oPwd };
    case 0xFF42: return { sMethod: 'FNBeginCloseSession', oProps: oPwd };
    case 0x41: return { sMethod: 'FNCloseSession', oProps: oPwd };
    // Проверка кода: 2003, 2102, длина КМ, длина TLV, КМ, TLV (мера и количество).
    case 0xFF61: {
      const nCode = a[2], nTlv = a[3];
      const aTlv = a.slice(4 + nCode, 4 + nCode + nTlv);
      const aCode = a.slice(4, 4 + nCode);
      // Строение кода для журнала — без самого кода: длина и где разделители.
      const aGs = aCode.reduce((aAcc, n, i) => (n === 0x1D ? [...aAcc, i] : aAcc), []);
      const sDiag = `КМ ${nCode} байт, GS ${aGs.length ? 'на ' + aGs.join(', ') : 'нет'}, TLV ${nTlv} байт`;
      // Штучно (без меры и количества) — FNCheckItemBarcode2: он TLVData не
      // читает. FNCheckItemBarcode дописывает к FF61h всё, что осталось в
      // TLVData (прошлый ответ, реквизиты FNSendTLV кассира), а пустой буфер
      // драйвер для Windows, похоже, не очищает: ККТ отвечала D3h «ошибка
      // формата GS1» на любой код (Win7, 24.11.2026).
      if (!nTlv) {
        return {
          sMethod: 'FNCheckItemBarcode2',
          sDiag,
          oProps: { ...oPwd, ItemStatus: a[0], CheckItemMode: a[1], BarcodeHex: sHexBytes(aCode), DivisionalQuantity: false, Quantity: 1, MeasureUnit: 0 },
          aOut: ['CheckItemLocalResult', 'CheckItemLocalError', 'MarkingType2', 'KMServerErrorCode', 'KMServerCheckingStatus', 'TLVData'],
          fAnswer: (o) => fCheckAnswer(o, oState),
        };
      }
      return {
        sMethod: 'FNCheckItemBarcode',
        sDiag,
        oProps: { ...oPwd, ItemStatus: a[0], CheckItemMode: a[1], BarcodeHex: sHexBytes(aCode), TLVData: Buffer.from(aTlv) },
        // TLVData задаём всегда: в нём остаётся ответ прошлой проверки, и
        // драйвер дописал бы его к FF61h (ККТ отвечает D3h).
        aOut: ['CheckItemLocalResult', 'CheckItemLocalError', 'MarkingType2', 'KMServerErrorCode', 'KMServerCheckingStatus', 'TLVData'],
        fAnswer: (o) => fCheckAnswer(o, oState),
      };
    }
    // Принять / отвергнуть проверенный код; ответ — 2106 (результат проверки).
    case 0xFF69: return { sMethod: a[0] ? 'FNAcceptMarkingCode' : 'FNDeclineMarkingCode', oProps: oPwd, fAnswer: () => [oState.n2106 & 255] };
    // Код маркировки к позиции: длина, КМ.
    case 0xFF67: return { sMethod: 'FNSendItemBarcode', oProps: { ...oPwd, BarcodeHex: sHexBytes(a.slice(1, 1 + a[0])) } };
    // Закрытие чека: 16 оплат по 5 байт, округление, 6 налогов по 5 байт, СНО.
    case 0xFF45: {
      const oProps = { ...oPwd };
      for (let i = 0; i < 16; i += 1) oProps[`Summ${i + 1}`] = nLe(a.slice(i * 5, i * 5 + 5));
      oProps.RoundingSumm = a[80] ?? 0;
      for (let i = 0; i < 6; i += 1) oProps[`TaxValue${i + 1}`] = nLe(a.slice(81 + i * 5, 86 + i * 5));
      oProps.TaxType = a[111] ?? 0;
      // Ответ FF45h: сдача (5), номер ФД (4), ФП (4).
      return { sMethod: 'FNCloseCheckEx', oProps, aOut: ['Change', 'DocumentNumber', 'FiscalSign'], fAnswer: (o) => [...aLe(o.Change, 5), ...aLe(o.DocumentNumber, 4), ...aLe(o.FiscalSign, 4)] };
    }
    default: return null;
  }
}

/**
 * Открыть ККТ драйвером: контекст, Connect по адресу драйвера (как в «Тесте
 * драйвера»: tcp://192.168.137.111:7778?timeout=15000&protocol=v1,
 * serial://…). Возвращает { oDrv, pClose }.
 */
// Закрытие прежнего контекста (Disconnect) ещё идёт — новый Connect ждёт его:
// по сети USB ККТ держит одно соединение и второе не примет.
let pLastClose = Promise.resolve();

export async function pOpenDriver(sUri, nPassword = 30) {
  fRetryLoad();
  await pLastClose;
  if (!oInfo.loaded) throw Object.assign(new Error(oInfo.error || 'Драйвер Посцентра (fr_drv_ng) не загружен — укажите его каталог в общих настройках'), { code: N_NO_CONNECTION });
  if (!sUri) throw Object.assign(new Error('Не задан адрес ККТ для драйвера Посцентра'), { code: N_NO_CONNECTION });
  const oDrv = new oWrapper.ShtrihClassic();
  const nAt = Date.now();
  const oConnect = await pDrvCall(oDrv, 'Connect', { Password: nPassword, ConnectionURI: sUri });
  if (bDebugOn()) console.log(`${new Date().toISOString()} Драйвер Посцентра [отладка]: Connect ${sUri} → ${oConnect.ResultCode} ${oConnect.ResultCodeDescription}, ${Date.now() - nAt} мс`);
  if (oConnect.ResultCode !== 0) {
    oDrv.destroy();
    throw Object.assign(new Error(`Драйвер Посцентра не подключился к ККТ (${sUri}): ${oConnect.ResultCodeDescription}`), { code: N_NO_CONNECTION });
  }
  return {
    oDrv,
    pClose() {
      pLastClose = pLastClose.then(async () => {
        await pDrvCall(oDrv, 'Disconnect').catch(() => {});
        oDrv.destroy();
      });
      return pLastClose;
    },
  };
}
