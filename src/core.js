// ККТ через kkt-core — Штрих-М (Посцентр, Ритейл-02Ф), дальше Вики и старые
// Атолы: та же логика, что в браузере кассы, только порт — serialport
// (serial.js) вместо Web Serial / WebUSB. Атол на платформе 5 — через ДТО 10
// (driver.js), как раньше.
//
// Дескриптор — с тем же видом, что у драйвера Атола (driver.js oCreateHandle):
// fOpen / pProcess / fClose, — и очередь, блокировки и переподключение ККТ
// (device.js) работают с ним как есть. Обрыв связи — код 241, как у ДТО:
// по нему device.js открывает ККТ заново.
//
// kkt-core настраивается здесь один раз (fConfigureCore):
//   — ОФД, ОИСМ, ОКП: ККТ ходит к ним через стек kkt-core, а он отдаёт посылки
//     сюда — прямой TCP с этого ПК (у кассы в браузере — прокси кабинета);
//   — имена — DNS ОС;
//   — разрешения сервера политик — в policy-store.json каталога данных
//     (в памяти офлайн-запас и журнал не пережили бы перезапуск службы);
//   — ключ лицензии и адрес сервера политик присылает касса
//     (PUT /api/v2/agentPolicy, policy.json); касса же проверяет место,
//     РНМ и соглашение — здесь kkt-core идёт за той ККТ, что ответила;
//   — служебные данные производителю ККТ — настройка vendorData (settings.js).

import net from 'node:net';
import dns from 'node:dns';
import { createRequire } from 'node:module';
import { vReadJson, fWriteJson } from './store.js';
import { aListSerialPorts, oSerialPort } from './serial.js';

const require = createRequire(import.meta.url);
const S_POLICY_FILE = 'policy.json';
const S_STORE_FILE = 'policy-store.json';
const N_CONNECTION_LOST = 241;
const N_NO_CONNECTION = 2;
// Модель (connectionSettings.model) → тип порта kkt-core. Числовые модели — Атол через ДТО 10.
export const O_CORE_MODELS = { shtrih: 'shtrih' };
export const bCoreModel = (vModel) => Object.prototype.hasOwnProperty.call(O_CORE_MODELS, String(vModel));

let oLib = null;
let fLog = () => {};
let bVendorData = true;
let sAgentVersion = '';

function oCore() {
  if (!oLib) {
    oLib = require('kkt-core');
    fApplyConfig();
  }
  return oLib;
}

// Хранилище агента политик: { pGet, pSet } поверх JSON-файла.
const oPolicyStore = {
  async pGet(sKey) { return vReadJson(S_STORE_FILE, {})[sKey]; },
  async pSet(sKey, vValue) {
    const o = vReadJson(S_STORE_FILE, {});
    if (vValue === undefined) delete o[sKey]; else o[sKey] = vValue;
    fWriteJson(S_STORE_FILE, o);
  },
};

/** Обмен ККТ с ОФД: соединение, посылка, первый пришедший ответ — как /api/ofd кабинета. */
function pSendToOfd(sHostPort, aBytes) {
  return new Promise((fResolve, fReject) => {
    const n = sHostPort.lastIndexOf(':');
    const oSocket = net.connect(Number(sHostPort.slice(n + 1)), sHostPort.slice(0, n), () => oSocket.write(Buffer.from(aBytes)));
    let bDone = false;
    const fDone = (fThen, v) => { if (!bDone) { bDone = true; fThen(v); } };
    oSocket.once('data', (aData) => { fDone(fResolve, [...aData]); oSocket.end(); });
    oSocket.setTimeout(10e3, () => { oSocket.destroy(); fDone(fReject, new Error(`${sHostPort} не ответил за 10 с`)); });
    oSocket.on('error', (oError) => fDone(fReject, oError));
    oSocket.on('close', () => fDone(fResolve, null));
  });
}

const pResolveHost = (sHost) => new Promise((fResolve, fReject) =>
  dns.lookup(sHost, { family: 4 }, (oError, sIp) => (oError ? fReject(oError) : fResolve(sIp))));

/** Ключ лицензии и адрес сервера политик (от кассы). */
export const oPolicyAccess = () => ({ license: '', policyUrl: process.env.KKT_AGENT_POLICY_URL || '', ...vReadJson(S_POLICY_FILE, {}) });

function fApplyConfig() {
  if (!oLib) return;
  const { license, policyUrl } = oPolicyAccess();
  oLib.configure({
    // Библиотека пишет много — в журнал агента только сеть ККТ и сбои.
    log: {
      info: (s) => { if (/^Штрих (PPP|RNDIS)/.test(s)) fLog(s); },
      warn: (s) => fLog(s),
      error: (s) => fLog(s),
    },
    pSendToOfd,
    pResolveHost,
    bVendorData,
    policy: { sLicense: license, sPolicyUrl: policyUrl, oStore: oPolicyStore, sHost: 'kktsite-agent/' + (sAgentVersion || 'dev') },
  });
}

export function fConfigureCore({ fLog: fNewLog, sVersion } = {}) {
  if (fNewLog) fLog = fNewLog;
  if (sVersion) sAgentVersion = sVersion;
  fApplyConfig();
}

/** settings.js: служебные данные производителю ККТ (по умолчанию — да). */
export function fSetVendorData(bOn) {
  bVendorData = Boolean(bOn);
  fApplyConfig();
}

/** Касса прислала ключ лицензии и адрес сервера политик. */
export function oPutPolicyAccess({ license, policyUrl } = {}) {
  const oNow = oPolicyAccess();
  const oNext = {
    license: typeof license === 'string' ? license.trim() : oNow.license,
    policyUrl: typeof policyUrl === 'string' ? policyUrl.trim() : oNow.policyUrl,
  };
  if (oNext.policyUrl && !/^https?:\/\/[^\s]+$/.test(oNext.policyUrl)) throw new Error('Адрес сервера политик — http(s)://…');
  if (oNext.license !== oNow.license || oNext.policyUrl !== oNow.policyUrl) {
    fWriteJson(S_POLICY_FILE, oNext);
    fApplyConfig();
  }
  return { license: oNext.license ? '…' + oNext.license.slice(-4) : '', policyUrl: oNext.policyUrl };
}

/** COM-порт по настройке: на Windows — номер (как у Web Requests), иначе путь. */
const sPortPath = (vCom) => (process.platform === 'win32' && /^\d+$/.test(String(vCom)) ? `COM${vCom}` : String(vCom ?? ''));

/** Дескриптор ККТ через kkt-core: fOpen(connectionSettings) / pProcess(задание) / fClose. */
export function oCreateCoreHandle() {
  const { KKT } = oCore();
  let oPort = null;
  let oKKT = null;
  let sType = '';
  return {
    async fOpen(oConn) {
      sType = O_CORE_MODELS[String(oConn.model)];
      const sPath = sPortPath(oConn.com);
      if (!sPath) throw Object.assign(new Error('Не выбран COM-порт ККТ'), { code: N_NO_CONNECTION });
      // VID/PID — для определения типа; у RS-232 их нет, тогда скорость — из настроек.
      const oFound = (await aListSerialPorts().catch(() => [])).find((o) => o.path === sPath);
      const bUsb = Boolean(oFound?.vendorId);
      const oSerial = oSerialPort(sPath, {
        nBaudRate: bUsb ? 0 : Number(oConn.baudRate) || 115200,
        oInfo: bUsb ? { usbVendorId: parseInt(oFound.vendorId, 16), usbProductId: parseInt(oFound.productId, 16) } : {},
      });
      oSerial.sType = sType;
      oPort = await KKT.pInitPort(oSerial);
      if (oPort.oError) {
        const oError = Object.assign(new Error(oPort.oError.message), { code: N_NO_CONNECTION });
        await Promise.resolve(oPort.pDestroy?.(false)).catch(() => {});
        throw oError;
      }
      oKKT = new KKT({ sConnectionType: 'comPort', sVendorOrUrl: sType, id: oPort.sRegNumKKT || '', sNameKKT: '' }, oPort);
      // Обрыв связи (PPP закрыт, ККТ перезагрузилась, чтение порта упало) —
      // сообщить устройству: оно откроет ККТ заново, не дожидаясь задания.
      const oThis = this;
      const fLost = () => oThis.fOnLost?.();
      if (oPort.oSocket) {
        const fPrev = oPort.oSocket.onclose;
        oPort.oSocket.onclose = (oEvent) => { fPrev?.(oEvent); fLost(); };
      } else {
        const fPrev = oPort.fReadError;
        oPort.fReadError = (oError) => { fPrev?.(oError); fLost(); };
      }
    },
    /** Связь с ККТ оборвалась — ставит device.js. */
    fOnLost: null,
    async pProcess(oTask) {
      if (!oKKT) throw Object.assign(new Error('ККТ не подключена'), { code: N_NO_CONNECTION });
      // Допечатка: у Штриха в kkt-core её пока нет — документ ККТ допечатает
      // сама после замены бумаги; блокировку очереди не держим.
      if (oTask?.type === 'continuePrint' && sType === 'shtrih') return null;
      try {
        const aResults = await oKKT.pTaskSender(oTask);
        return aResults?.[0] ?? null;
      } catch (oError) {
        if (oPort?.oError) throw { code: N_CONNECTION_LOST, description: oError.message };
        throw { code: typeof oError.code === 'number' ? oError.code : 500, description: oError.message };
      }
    },
    fClose() {
      const o = oPort;
      oPort = null;
      oKKT = null;
      Promise.resolve(o?.pDestroy?.(false)).catch(() => {});
    },
  };
}
