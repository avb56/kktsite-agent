// ККТ и её очередь заданий — по образцу «АТОЛ. Web Requests».
//
// Поведение снято с настоящего Web Requests 1.0.4.0 (29.09.2026), а не только
// из спецификации: касса (тип подключения «Атол Сервер», pAtolWebSender в
// apps/app/src/modules/kkt.js) уже работает с ним, и агент должен отвечать так
// же, чтобы она работала с ним без правок:
//   — задание: { uuid, request: [задачи] }; задачи выполняются по порядку;
//   — у каждой задачи статус: wait → inProgress → ready | error; после первой
//     ошибки остальные задачи задания — interrupted, код 502;
//   — повторный uuid — 409; неизвестный — 404; отменить можно только
//     ждущее задание, иначе 409;
//   — выполненные задания хранятся deleteRequestsAfter минут (43200 = 30
//     суток; настройка /settings, единицы — по спецификации 1.0.4.0).
//
// Все обращения к драйверу одной ККТ идут по одному: дескриптор драйвера не
// рассчитан на параллельные вызовы. Очередь и синхронные запросы (/operations)
// выстраиваются в одну цепочку (pChain).

import { oCreateHandle } from './driver.js';

/** Общие настройки очередей; меняет settings.js по PUT /settings. */
export const oQueueOptions = { nKeepMinutes: 43200, bBlockOnPrintErrors: true, nRecoverMs: 3000 };

// ——— Блокировка очереди (как у Web Requests, спецификация 1.0.4.0) ———
//
// Фискальная задача оборвалась на связи или обмене с ФН — неизвестно, закрылся
// ли документ в ФН. Повторить нельзя (выйдет второй чек), считать ошибкой тоже
// (касса пробьёт чек заново). Задача получает статус blocked, очередь встаёт
// (isBlocked, blockReason, blockedUUID), и агент раз в nRecoverMs пробует
// узнать исход: номер последнего ФД (getFnStatus) до задачи запоминается, после
// восстановления связи номер вырос — документ закрылся (ready, с допечаткой
// continuePrint), не вырос — не закрылся (error, остальные — interrupted).
// Потом очередь идёт дальше.
//
// Бумага (blockQueueOnPrintErrors): документ закрылся, но не допечатался
// (warnings.notPrinted) или задача упала на бумаге / крышке / принтере —
// очередь стоит, пока бумагу не вставят; затем continuePrint и дальше. Без
// настройки — как раньше: ошибка остаётся в результате задачи.

// Задачи, которые формируют фискальный документ.
const S_FISCAL_TASKS = new Set([
  'sell', 'sellReturn', 'buy', 'buyReturn',
  'sellCorrection', 'sellReturnCorrection', 'buyCorrection', 'buyReturnCorrection',
  'openShift', 'closeShift', 'reportOfdExchangeStatus',
  'registration', 'changeRegistrationParameters', 'closeArchive', 'fnChange',
]);
// Коды ошибок драйвера (приложение «Список кодов ошибок» документации ДТО 10).
const S_CONNECTION_ERRORS = new Set([1, 2, 3, 4, 241]); // нет связи, порт, соединение потеряно
const S_FN_ERRORS = new Set([115, 116, 159, 166, 177]); // обмен с ФН, ФН не найден, закрытие чека прервано
const S_PAPER_ERRORS = new Set([44, 45, 46, 114]); // нет бумаги, крышка, принтер, перегрев
const N_CONNECTION_DISABLED = 1;
const N_CONNECTION_LOST = 241;

function sBlockReason(nCode) {
  if (S_CONNECTION_ERRORS.has(nCode)) return 'connectionError';
  if (S_FN_ERRORS.has(nCode)) return 'fnError';
  if (S_PAPER_ERRORS.has(nCode)) return 'paperError';
  return '';
}

// Настройки ККТ по умолчанию — как отдаёт /utils/deviceParametersStruct у
// Web Requests 1.0.4.0. otherSettings агент хранит и отдаёт, но пока не
// применяет (скрипты ДТО, инверсия денежного ящика, доп. строки документа).
export const O_DEFAULT_CONNECTION = {
  model: 500, accessPassword: '', userPassword: '', port: 'usb', com: '1', baudRate: 1200,
  ipAddress: '', ipPort: 0, mac: '', ofdChannel: 'auto', usbDevice: 'auto',
};
export const O_DEFAULT_OTHER = {
  useGlobalScriptsSettings: true, scriptsPath: '',
  useGlobalInvertCashDrawerStatusFlag: true, invertCashDrawerStatus: false,
  useGlobalAdditionalHeaderLines: true, additionalHeaderLines: '',
  useGlobalAdditionalFooterLines: true, additionalFooterLines: '',
};

const O_ERR_OK = { code: 0, description: 'Ошибок нет' };
const O_ERR_INTERRUPTED = { code: 502, description: 'Выполнение прервано из-за предыдущих ошибок' };
const O_ERR_CANCELED = { code: 503, description: 'Задание отменено' };

/** Ошибка с HTTP-кодом ответа — её отдаёт сервер как { error: { code: 505, description } }. */
export class AgentError extends Error {
  constructor(nHttp, sMessage) {
    super(sMessage);
    this.nHttp = nHttp;
  }
}

// Канал связи в формате Web Requests → константа драйвера (LIBFPTR_PORT_*).
// У Web Requests сеть — tcp; tcpip принимается по старой памяти агента.
const O_PORTS = { com: 0, usb: 1, tcp: 2, tcpip: 2, bluetooth: 3 };
// Канал обмена с ОФД → LIBFPTR_OFD_CHANNEL_*. Web Requests знает только none и
// auto; usb и proto — значения драйвера, на случай ручной правки.
const O_OFD_CHANNELS = { none: 0, usb: 1, proto: 2, auto: 2 };

/**
 * Настройки подключения в формате Web Requests (как их хранит и отдаёт
 * /devices) → настройки драйвера. Формат Web Requests оставлен ради того,
 * чтобы настройки можно было переносить между ним и агентом как есть.
 */
export function oDriverSettings(oConn = {}) {
  const sPort = oConn.port || 'usb';
  if (!(sPort in O_PORTS)) throw new AgentError(400, `Неизвестный тип подключения: ${sPort}`);
  const oSettings = {
    Model: oConn.model ?? 500,
    Port: O_PORTS[sPort],
    AccessPassword: oConn.accessPassword || '',
    UserPassword: oConn.userPassword || '',
  };
  if (oConn.ofdChannel && oConn.ofdChannel in O_OFD_CHANNELS) oSettings.OfdChannel = O_OFD_CHANNELS[oConn.ofdChannel];
  if (sPort === 'com') Object.assign(oSettings, { ComFile: String(oConn.com ?? ''), BaudRate: oConn.baudRate || 115200 });
  if (sPort === 'usb') oSettings.UsbDevicePath = oConn.usbDevice || 'auto';
  if (O_PORTS[sPort] === O_PORTS.tcp) Object.assign(oSettings, { IPAddress: oConn.ipAddress || '', IPPort: oConn.ipPort || 5555 });
  if (sPort === 'bluetooth') oSettings.MACAddress = oConn.mac || '';
  return oSettings;
}

/** Ошибка драйвера → { code, description } как в результатах Web Requests. */
function oTaskError(oError) {
  return {
    code: typeof oError.code === 'number' ? oError.code : 500,
    description: oError.description || oError.message || String(oError),
  };
}

export class Device {
  constructor(oDesc) {
    this.id = String(oDesc.id);
    this.name = oDesc.name || `ККТ ${this.id}`;
    this.connectionSettings = { ...O_DEFAULT_CONNECTION, ...oDesc.connectionSettings };
    this.otherSettings = { ...O_DEFAULT_OTHER, ...oDesc.otherSettings };
    this.isDefault = Boolean(oDesc.isDefault);
    // Хотят ли ККТ подключённой: переживает перезапуск агента. Подключена ли
    // она на самом деле — oHandle.
    this.bWantActive = Boolean(oDesc.isActive);
    this.oHandle = null;
    this.sLastError = null;

    this.mRequests = new Map();
    this.aWaiting = [];
    this.nNumber = 0;
    this.bPumping = false;
    this.pChain = Promise.resolve();
    // Блокировка очереди: { sReason, sUuid, nTask, nFdBefore, oError } или null.
    this.oBlock = null;
    this.nRecoverTimer = 0;
    this.bReopen = false; // дескриптор закрыт после обрыва, новый ещё не открылся
  }

  /** Описание для /devices и для файла devices.json. */
  oDescribe() {
    return {
      id: this.id,
      name: this.name,
      connectionSettings: this.connectionSettings,
      otherSettings: this.otherSettings,
      isActive: Boolean(this.oHandle),
      isDefault: this.isDefault,
      // У Web Requests: isLock — очередь заблокирована сбоем, hasLicense —
      // в ККТ есть лицензия на Web Requests. Агенту лицензия не нужна.
      isLock: this.oBlockInfo().isBlocked,
      hasLicense: true,
      // Ошибка последнего подключения: у Web Requests такого поля нет, а
      // кассиру без него не понять, почему ККТ «не активна».
      lastError: this.sLastError,
    };
  }

  /** Выполнить fTask после всех предыдущих обращений к этой ККТ. */
  pSerial(fTask) {
    const pRun = this.pChain.then(fTask, fTask);
    this.pChain = pRun.catch(() => {});
    return pRun;
  }

  /** Подключить ККТ: открыть драйвер с её настройками и запустить очередь. */
  pActivate() {
    return this.pSerial(() => {
      if (this.oHandle) return;
      let oHandle;
      try {
        oHandle = oCreateHandle();
        oHandle.fOpen(oDriverSettings(this.connectionSettings));
      } catch (oError) {
        if (oHandle) try { oHandle.fClose(); } catch { /* не открылась — закрывать нечего */ }
        this.sLastError = oTaskError(oError).description;
        throw new AgentError(409, `ККТ [${this.id}] не подключилась: ${this.sLastError}`);
      }
      this.oHandle = oHandle;
      this.bWantActive = true;
      this.sLastError = null;
    }).then(() => {
      if (this.oBlock) this.fScheduleRecover();
      this.fPump();
    });
  }

  /** Отключить ККТ: дождаться текущей задачи и закрыть драйвер. Очередь ждёт. */
  pDeactivate() {
    this.bWantActive = false;
    return this.pSerial(() => {
      if (!this.oHandle) return;
      if (!this.bReopen) this.oHandle.fClose(); // при bReopen он уже закрыт
      this.oHandle = null;
      this.bReopen = false;
      // Блокировка остаётся: исход задачи всё ещё неизвестен. Снимать её
      // продолжат после подключения (pActivate).
      clearTimeout(this.nRecoverTimer);
      this.nRecoverTimer = 0;
    });
  }

  /** Поставить задание в очередь. */
  oAddRequest(sUuid, aTasks) {
    if (!sUuid || typeof sUuid !== 'string') throw new AgentError(400, "Поле 'uuid' не задано");
    if (!Array.isArray(aTasks) || !aTasks.length) throw new AgentError(400, "Поле 'request' не задано или пустое");
    if (this.mRequests.has(sUuid)) {
      throw new AgentError(409, `Не удалось добавить задание с UUID [${sUuid}], задание с таким UUID уже есть`);
    }
    // Не подключённой ККТ задание не принимаем: касса ждала бы результата,
    // который не придёт, пока кто-то не подключит ККТ руками.
    if (!this.oHandle) {
      throw new AgentError(409, `ККТ [${this.id}] не подключена${this.sLastError ? ': ' + this.sLastError : ''}`);
    }
    this.nNumber += 1;
    this.mRequests.set(sUuid, {
      sUuid,
      aTasks,
      aResults: aTasks.map(() => ({ error: O_ERR_OK, status: 'wait' })),
      sState: 'wait',
      nNext: 0, // с какой задачи продолжать: после блокировки задание продолжается, а не начинается заново
      nDoneAt: 0,
    });
    this.aWaiting.push(sUuid);
    this.fPump();
    return { number: this.nNumber, uuid: sUuid, ...this.oBlockInfo() };
  }

  oGetRequest(sUuid) {
    this.fForgetOld();
    const oRequest = this.mRequests.get(sUuid);
    if (!oRequest) throw new AgentError(404, `Задание с UUID [${sUuid}] для устройства [${this.id}] не найдено`);
    return { results: oRequest.aResults };
  }

  fCancelRequest(sUuid) {
    const oRequest = this.mRequests.get(sUuid);
    if (!oRequest) throw new AgentError(404, `Задание с UUID [${sUuid}] для устройства [${this.id}] не найдено`);
    if (oRequest.sState !== 'wait') {
      throw new AgentError(409, `Задание с UUID [${sUuid}] для устройства [${this.id}] нельзя отменить (выполнено, выполняется или уже отменено)`);
    }
    this.aWaiting = this.aWaiting.filter((s) => s !== sUuid);
    oRequest.sState = 'canceled';
    oRequest.nDoneAt = Date.now();
    oRequest.aResults = oRequest.aTasks.map(() => ({ error: O_ERR_CANCELED, status: 'canceled' }));
  }

  oQueueStatus() {
    this.fForgetOld();
    let nReady = 0;
    let nCanceled = 0;
    for (const oRequest of this.mRequests.values()) {
      if (oRequest.sState === 'done') nReady += 1;
      if (oRequest.sState === 'canceled') nCanceled += 1;
    }
    // number — незавершённые задания: ждущие и то, на котором встала очередь.
    const nNumber = this.aWaiting.length + (this.oBlock ? 1 : 0);
    return { number: nNumber, ready: nReady, canceled: nCanceled, ...this.oBlockInfo() };
  }

  oBlockInfo() {
    if (!this.oBlock) return { isBlocked: false, blockedUUID: '', blockReason: '' };
    return { isBlocked: true, blockedUUID: this.oBlock.oRequest.sUuid, blockReason: this.oBlock.sReason };
  }

  /** Синхронный запрос в обход очереди (/operations), но после текущей задачи. */
  pOperation(oTask) {
    if (!this.oHandle) throw new AgentError(409, `ККТ [${this.id}] не подключена`);
    return this.pSerial(() => this.pProbe(oTask)).catch((oError) => {
      throw new AgentError(400, oTaskError(oError).description);
    });
  }

  /** Выполнять задания, пока есть ждущие, ККТ подключена и очередь не стоит. */
  fPump() {
    if (this.bPumping || !this.oHandle || this.oBlock || !this.aWaiting.length) return;
    this.bPumping = true;
    const sUuid = this.aWaiting.shift();
    this.pSerial(() => this.pRun(this.mRequests.get(sUuid))).finally(() => {
      this.bPumping = false;
      this.fPump();
    });
  }

  async pRun(oRequest) {
    // ККТ успели отключить (или очередь встала), пока задание стояло в
    // цепочке: вернуть его в начало очереди — выполнится позже.
    if (!this.oHandle || this.oBlock) {
      this.aWaiting.unshift(oRequest.sUuid);
      return;
    }
    oRequest.sState = 'inProgress';
    for (let n = oRequest.nNext; n < oRequest.aTasks.length; n += 1) {
      const oTask = oRequest.aTasks[n];
      const bFiscal = S_FISCAL_TASKS.has(oTask?.type);
      let nFdBefore = null;
      oRequest.aResults[n] = { error: O_ERR_OK, status: 'inProgress' };
      try {
        // Номер последнего ФД до задачи: по нему после сбоя видно, закрылся ли документ.
        if (bFiscal) nFdBefore = await this.pFdNumber();
        const vResult = await this.oHandle.pProcess(oTask);
        oRequest.aResults[n] = { error: O_ERR_OK, status: 'ready', result: vResult ?? null };
        if (oQueueOptions.bBlockOnPrintErrors && vResult?.warnings?.notPrinted) {
          return this.fBlock({ sReason: 'paperError', oRequest, nTask: n, nFdBefore: null, oError: null });
        }
      } catch (oError) {
        const oTaskErr = oTaskError(oError);
        const sReason = sBlockReason(oTaskErr.code);
        // Исход неизвестен, только если фискальная задача успела начаться
        // (номер ФД до неё прочитан) и оборвалась на связи, ФН или бумаге.
        const bUnknown = bFiscal && nFdBefore !== null && sReason
          && (sReason !== 'paperError' || oQueueOptions.bBlockOnPrintErrors);
        if (bUnknown) {
          oRequest.aResults[n] = { error: oTaskErr, status: 'blocked' };
          return this.fBlock({ sReason, oRequest, nTask: n, nFdBefore, oError: oTaskErr });
        }
        oRequest.aResults[n] = { error: oTaskErr, status: 'error' };
        return this.fFinish(oRequest, n + 1);
      }
    }
    this.fFinish(oRequest, oRequest.aTasks.length);
  }

  /** Задание завершено: задачи с nFrom — interrupted (после ошибки). */
  fFinish(oRequest, nFrom) {
    for (let n = nFrom; n < oRequest.aTasks.length; n += 1) {
      oRequest.aResults[n] = { error: O_ERR_INTERRUPTED, status: 'interrupted' };
    }
    oRequest.sState = 'done';
    oRequest.nDoneAt = Date.now();
  }

  async pFdNumber() {
    const oResult = await this.pProbe({ type: 'getFnStatus' });
    return Number(oResult?.fnStatus?.fiscalDocumentNumber ?? 0);
  }

  fBlock(oBlock) {
    this.oBlock = oBlock;
    oBlock.oRequest.sState = 'blocked';
    this.fScheduleRecover();
  }

  fScheduleRecover() {
    if (this.nRecoverTimer || !this.oBlock || !this.oHandle) return;
    this.nRecoverTimer = setTimeout(() => {
      this.nRecoverTimer = 0;
      this.pSerial(() => this.pRecover()).catch(() => { /* ещё не восстановилось — попробуем снова */ }).finally(() => {
        if (this.oBlock) this.fScheduleRecover();
        else this.fPump();
      });
    }, oQueueOptions.nRecoverMs);
    this.nRecoverTimer.unref?.();
  }

  /**
   * Одна попытка снять блокировку. Бросает, если ККТ ещё недоступна; тогда
   * следующая попытка — через nRecoverMs.
   */
  async pRecover() {
    const oBlock = this.oBlock;
    if (!oBlock || !this.oHandle) return;
    const { oRequest, nTask } = oBlock;
    const oStatus = (await this.pProbe({ type: 'getDeviceStatus' }))?.deviceStatus || {};

    if (oBlock.nFdBefore !== null) {
      const nFdNow = await this.pFdNumber();
      if (nFdNow <= oBlock.nFdBefore) {
        // Документ не закрылся: задача — ошибкой, с которой оборвалась.
        oRequest.aResults[nTask] = { error: oBlock.oError, status: 'error' };
        this.oBlock = null;
        this.fFinish(oRequest, nTask + 1);
        return;
      }
      // Закрылся. Полного результата драйвер уже не вернёт — только номер ФД.
      oRequest.aResults[nTask] = {
        error: O_ERR_OK,
        status: 'ready',
        result: { fiscalParams: { fiscalDocumentNumber: nFdNow }, warnings: { notPrinted: true } },
      };
      oBlock.nFdBefore = null;
    }

    const bPaperOk = oStatus.paperPresent !== false && !oStatus.coverOpened;
    if (bPaperOk) {
      try {
        await this.oHandle.pProcess({ type: 'continuePrint' });
        const oWarnings = oRequest.aResults[nTask].result?.warnings;
        if (oWarnings) oWarnings.notPrinted = false;
      } catch (oError) {
        if (oQueueOptions.bBlockOnPrintErrors) {
          oBlock.sReason = 'paperError';
          throw oError;
        }
      }
    } else if (oQueueOptions.bBlockOnPrintErrors) {
      oBlock.sReason = 'paperError';
      throw new Error(oStatus.coverOpened ? 'Открыта крышка' : 'Нет бумаги');
    }

    // Очередь идёт дальше: задание — с задачи после той, на которой встало.
    this.oBlock = null;
    oRequest.nNext = nTask + 1;
    if (oRequest.nNext >= oRequest.aTasks.length) {
      this.fFinish(oRequest, oRequest.aTasks.length);
    } else {
      oRequest.sState = 'wait';
      this.aWaiting.unshift(oRequest.sUuid);
    }
  }

  /**
   * Задача драйверу с восстановлением соединения: если драйвер уже не
   * пытается сам (соединение не установлено / потеряно) — открыть заново.
   */
  async pProbe(oTask) {
    if (!this.bReopen) {
      try {
        return await this.oHandle.pProcess(oTask);
      } catch (oError) {
        if (oError.code !== N_CONNECTION_DISABLED && oError.code !== N_CONNECTION_LOST) throw oError;
        // Старый дескриптор закрыт; пока новый не откроется, трогать его нельзя.
        this.bReopen = true;
        try { this.oHandle.fClose(); } catch { /* уже закрыт */ }
      }
    }
    const oHandle = oCreateHandle();
    try {
      oHandle.fOpen(oDriverSettings(this.connectionSettings));
    } catch (oError) {
      try { oHandle.fClose(); } catch { /* не открылся — закрывать нечего */ }
      throw oError;
    }
    this.oHandle = oHandle;
    this.bReopen = false;
    return oHandle.pProcess(oTask);
  }

  /** Забыть выполненные и отменённые задания старше deleteRequestsAfter. */
  fForgetOld() {
    const nBefore = Date.now() - oQueueOptions.nKeepMinutes * 60000;
    for (const [sUuid, oRequest] of this.mRequests) {
      if (oRequest.nDoneAt && oRequest.nDoneAt < nBefore) this.mRequests.delete(sUuid);
    }
  }
}
