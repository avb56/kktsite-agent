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

import { pHttpFetch } from './http-fetch.js';
import net from 'node:net';
import { execFile } from 'node:child_process';
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
let sDefaultPolicyUrl = '';
/**
 * Ключ лицензии и адрес сервера политик. Адрес: присланный кассой (или
 * введённый на странице агента) → KKT_AGENT_POLICY_URL → из сборки
 * (package-info.json, scripts/pack.mjs). Так агент получает разрешение и без
 * кассы: без ключа — демо по РНМ.
 */
export function oPolicyAccess() {
  const oSaved = vReadJson(S_POLICY_FILE, {});
  return {
    license: oSaved.license || '',
    policyUrl: oSaved.policyUrl || process.env.KKT_AGENT_POLICY_URL || sDefaultPolicyUrl,
  };
}

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
    // Node 12 (Windows 7): своего fetch нет — сервер политик через http/https.
    ...(typeof globalThis.fetch === 'function' ? {} : { fetch: pHttpFetch }),
    policy: { sLicense: license, sPolicyUrl: policyUrl, oStore: oPolicyStore, sHost: 'kktsite-agent/' + (sAgentVersion || 'dev') },
  });
}

export function fConfigureCore({ fLog: fNewLog, sVersion, sPolicyUrl } = {}) {
  if (fNewLog) fLog = fNewLog;
  if (sVersion) sAgentVersion = sVersion;
  if (sPolicyUrl) sDefaultPolicyUrl = sPolicyUrl;
  fApplyConfig();
}

/** settings.js: служебные данные производителю ККТ (по умолчанию — да). */
export function fSetVendorData(bOn) {
  bVendorData = Boolean(bOn);
  fApplyConfig();
}

/** Ключ лицензии и адрес сервера политик — от кассы или со страницы агента (пустой ключ — демо). */
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

// Известные ККТ по USB VID:PID (hex, как отдаёт serialport).
const O_KNOWN_PORTS = {
  '1fc9:0083': { model: 'shtrih', description: 'Штрих-М (Посцентр, USB VCOM)' },
  '0483:5740': { model: 'viki', description: 'Вики Принт (USB VCOM)' },
  '2912:0005': { model: 'atol', description: 'Атол (USB) — подключайте как USB, не COM' },
};

/**
 * COM-порты ПК: [{ key, path, description, model }]. key — значение настройки
 * com: на Windows номер (как у Web Requests), иначе путь; model — что за ККТ
 * по VID:PID (shtrih, viki, atol) или ''.
 */
export async function pPortList() {
  const aPorts = await aListSerialPorts().catch(() => []);
  return aPorts.map((o) => {
    const oKnown = O_KNOWN_PORTS[`${String(o.vendorId || '').toLowerCase()}:${String(o.productId || '').toLowerCase()}`];
    const sKey = process.platform === 'win32' && /^COM\d+$/i.test(o.path) ? o.path.slice(3) : o.path;
    const sMaker = [o.manufacturer, o.serialNumber].filter(Boolean).join(', ');
    return { key: sKey, path: o.path, model: oKnown?.model || '', description: `${o.path} — ${oKnown?.description || sMaker || 'COM-порт'}` };
  });
}

// ——— Штрих-М в режиме сетевой карты USB (RNDIS) → USB-COM ———
//
// По руководству Посцентра RNDIS (таблица 21 поле 9 = 1) у Ритейла-02Ф — из
// коробки. Через COM-порт такую ККТ не видно; агент переводит её в VCOM сам:
//   — Linux: USB-устройство 18d1:4ee4 (NXP «RNDIS») — напрямую, пакетом usb с
//     API WebUSB, и свой стек RNDIS kkt-core, как у кассы в браузере. Сетевой
//     драйвер ядра отцепляем; root не нужен — только доступ к устройству (udev);
//   — Windows: сетевую карту ставит сама ОС (её драйвер RNDIS, забрать USB
//     нельзя). Служба — от SYSTEM: даёт карте адрес 192.168.137.1 (шлюз ККТ по
//     умолчанию) и идёт к ККТ по TCP 192.168.137.111:7778.
// Дальше одинаково: SOCKS (таблица 16 поле 19 = 1), USB — VCOM (поле 9 = 0),
// перезагрузка. После неё ККТ — COM-порт 1fc9:0083, связь через компьютер
// (PPP) включается уже без перезагрузки.
const N_RNDIS_VID = 0x18D1, N_RNDIS_PID = 0x4EE4;
const A_RNDIS_HOST = '192.168.137.1', A_RNDIS_KKT = '192.168.137.111';

// stdin закрываем сразу: PowerShell 2.0 (Windows 7) с открытым stdin после
// команды ждёт конца ввода и не выходит (21.11.2026: поиск RNDIS висел 60 с).
const pExec = (sCmd, aArgs, nTimeoutMs = 15e3) => new Promise((fResolve, fReject) =>
  execFile(sCmd, aArgs, { timeout: nTimeoutMs, windowsHide: true }, (oError, sOut, sErr) => {
    if (!oError) return fResolve(String(sOut));
    // Текст ошибки — stderr; нет его — что случилось, без всей командной строки.
    const sWhy = String(sErr || '').trim()
      || (oError.killed ? `${sCmd}: не ответил за ${nTimeoutMs / 1000} с` : `${sCmd}: код выхода ${oError.code ?? '?'}`);
    fReject(new Error(sWhy));
  }).stdin?.end());

let oWebUsb = null;
function oUsbApi() {
  if (!oWebUsb) {
    const { WebUSB } = require('usb');
    oWebUsb = new WebUSB({ allowAllDevices: true });
  }
  return oWebUsb;
}
const bRndisUsb = (o) => o?.vendorId === N_RNDIS_VID && o.productId === N_RNDIS_PID
  && o.productName?.trim() === 'RNDIS' && o.manufacturerName?.trim() === 'NXP';

// Windows: сетевая карта ККТ — через WMI (Win32_NetworkAdapter, имя
// подключения — для netsh). Не Get-NetAdapter: его нет в PowerShell 2.0
// Windows 7 (21.11.2026: Штрих в RNDIS на Win7 агент не видел вовсе). Если
// сетевой карты нет, но устройство ККТ в системе есть (Win32_PnPEntity), —
// Windows не поставила ему драйвер RNDIS: так и говорим.
// Фильтр — в самом запросе WMI (WQL LIKE): перебор всех устройств в
// PowerShell 2.0 Windows 7 не укладывался в 15 с (21.11.2026). Скрипт —
// через -EncodedCommand (UTF-16LE, base64): кавычки фильтра не зависят от
// разбора командной строки. Имена — base64 от UTF-8: в канал PowerShell пишет
// в кодировке консоли (cp866), а имя подключения бывает русским
// («Подключение по локальной сети 2»).
const S_RNDIS_WMI = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  'function B($s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s)) }',
  `Get-WmiObject Win32_NetworkAdapter -Filter "PNPDeviceID LIKE '%VID_18D1&PID_4EE4%'" | ForEach-Object { 'net|' + (B $_.NetConnectionID) }`,
  `Get-WmiObject Win32_PnPEntity -Filter "DeviceID LIKE '%VID_18D1&PID_4EE4%'" | ForEach-Object { 'pnp|' + $_.ConfigManagerErrorCode + '|' + (B $_.Name) }`,
  'exit 0',
].join('\r\n');
const sFromB64 = (s) => Buffer.from(s || '', 'base64').toString('utf8');
const N_RNDIS_WMI_TIMEOUT_MS = 60e3;
const N_RNDIS_CACHE_MS = 10e3;

let sRndisWarned = '';
let pRndisRun = null; // идущий поиск — страница спрашивает каждые 15 с
let oRndisLast = { nAt: 0, aFound: [] };
function pFindRndisWindows() {
  if (Date.now() - oRndisLast.nAt < N_RNDIS_CACHE_MS) return Promise.resolve(oRndisLast.aFound);
  pRndisRun ??= pFindRndisWmi().then((aFound) => {
    oRndisLast = { nAt: Date.now(), aFound };
    return aFound;
  }).finally(() => { pRndisRun = null; });
  return pRndisRun;
}

async function pFindRndisWmi() {
  let sOut = '';
  try {
    const sEncoded = Buffer.from(S_RNDIS_WMI, 'utf16le').toString('base64');
    sOut = await pExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', sEncoded], N_RNDIS_WMI_TIMEOUT_MS);
  } catch (oError) {
    if (sRndisWarned !== oError.message) fLog(`RNDIS: поиск сетевой карты ККТ не удался — ${oError.message}`);
    sRndisWarned = oError.message;
    return [];
  }
  sRndisWarned = '';
  const aLines = sOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => s.split('|'))
    .map((a) => (a[0] === 'net' ? ['net', sFromB64(a[1])] : a[0] === 'pnp' ? ['pnp', a[1], sFromB64(a[2])] : a));
  const aNet = aLines.filter((a) => a[0] === 'net' && a[1]).map((a) => a[1]);
  if (aNet.length) {
    return aNet.map((sAdapter) => ({ id: `net:${sAdapter}`, sAdapter, description: `Штрих-М — сетевая карта USB «${sAdapter}» (RNDIS)` }));
  }
  // Устройство есть, сетевой карты нет — без драйвера (код 28) или с ошибкой.
  return aLines.filter((a) => a[0] === 'pnp').map((a) => ({
    id: `pnp:${a.slice(2).join('|')}`,
    bNoDriver: true,
    description: `Штрих-М в режиме сетевой карты USB (RNDIS), но Windows не поставила ему драйвер`
      + ` («${a.slice(2).join('|') || 'неизвестное устройство'}», код ${a[1] || '?'}). В диспетчере устройств:`
      + ' «Обновить драйвер» → «Выбрать из списка» → «Сетевые адаптеры» → Microsoft → «Remote NDIS'
      + ' Compatible Device». Или переведите ККТ в USB-COM утилитой производителя.',
  }));
}

async function pFindRndisUsb() {
  let aDevices = [];
  try { aDevices = await oUsbApi().getDevices(); } catch { /* нет доступа к USB — нечего показать */ }
  return aDevices.filter(bRndisUsb)
    .map((oDev) => ({ id: `usb:${oDev.serialNumber || ''}`, oDev, description: `Штрих-М — USB ${oDev.serialNumber || ''} в режиме сетевой карты (RNDIS)` }));
}

// Запасной путь: ККТ отвечает по сети USB на своём адресе по умолчанию — сеть
// уже настроена (тест драйвера, ККТ config), сетевую карту искать незачем. Только
// TCP-подключение и сразу закрыть: Штрих ли это — проверит kkt-core при переводе.
function bRndisTcp(nTimeoutMs = 1500) {
  return new Promise((fResolve) => {
    const oTcp = net.connect(7778, A_RNDIS_KKT);
    const fDone = (bOk) => { oTcp.destroy(); fResolve(bOk); };
    oTcp.setTimeout(nTimeoutMs, () => fDone(false));
    oTcp.once('connect', () => fDone(true));
    oTcp.once('error', () => fDone(false));
  });
}

/** ККТ Штрих-М в режиме RNDIS на этом ПК: [{ id, description, oDev?, sAdapter?, sHost?, bNoDriver? }]. */
export async function pFindRndis() {
  const aFound = process.platform === 'win32' ? await pFindRndisWindows() : await pFindRndisUsb();
  if (aFound.some((o) => !o.bNoDriver)) return aFound;
  if (!await bRndisTcp()) return aFound;
  // Ответила по сети — значит, драйвер есть: подсказка «нет драйвера» лишняя.
  return [{ id: `tcp:${A_RNDIS_KKT}`, sHost: A_RNDIS_KKT, description: `Штрих-М отвечает по сети USB (${A_RNDIS_KKT}) — режим сетевой карты (RNDIS)` }];
}

// Linux: отцепить сетевой драйвер ядра (rndis_host) от ККТ, иначе интерфейс не забрать.
function fDetachKernel() {
  const usb = require('usb');
  const oDev = usb.findByIds(N_RNDIS_VID, N_RNDIS_PID);
  if (!oDev) return;
  oDev.open();
  try {
    for (const oIface of oDev.interfaces || []) {
      try { if (oIface.isKernelDriverActive()) oIface.detachKernelDriver(); } catch { /* не наш драйвер — дальше */ }
    }
  } finally {
    oDev.close();
  }
}

// TCP к ККТ как «сокет» kkt-core (send / onmessage / onopen), как у телепорта.
function pTcpSocket(sHost, nPort) {
  return new Promise((fResolve, fReject) => {
    const oTcp = net.connect(nPort, sHost);
    const oSocket = {
      binaryType: 'arraybuffer', onmessage: null, onclose: null,
      send: (u8a) => oTcp.write(Buffer.from(u8a.buffer ?? u8a, u8a.byteOffset ?? 0, u8a.byteLength ?? u8a.length)),
      close: async () => oTcp.destroy(),
      set onopen(f) { f?.(); },
      get onopen() { return null; },
    };
    oTcp.on('data', (b) => oSocket.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }));
    oTcp.on('close', () => oSocket.onclose?.());
    oTcp.setTimeout(10e3, () => oTcp.destroy(new Error(`ККТ ${sHost}:${nPort} не ответила`)));
    oTcp.once('connect', () => { oTcp.setTimeout(0); fResolve(oSocket); });
    oTcp.once('error', fReject);
  });
}

/** Перевести ККТ из RNDIS в USB-COM (VCOM) и перезагрузить. oFound — из pFindRndis. */
export async function pRndisToCom(oFound) {
  if (oFound.bNoDriver) throw new Error('Windows не поставила ККТ драйвер RNDIS — сначала драйвер (подсказка — в плашке)');
  const { KKT } = oCore();
  let oPort;
  if (oFound.sAdapter || oFound.sHost) {
    // Адрес из сети ККТ у карты уже есть (её настроили для утилиты или драйвера
    // производителя) — не трогаем: смена адреса оборвала бы их связь с ККТ.
    // Нет — ставим адрес шлюза ККТ. Адреса — цифрами из вывода netsh: от языка
    // Windows не зависят.
    if (oFound.sAdapter) {
      const sShow = await pExec('netsh', ['interface', 'ipv4', 'show', 'addresses', `name=${oFound.sAdapter}`]).catch(() => '');
      const aHave = sShow.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
      if (aHave.some((sIp) => sIp.startsWith('192.168.137.') && sIp !== A_RNDIS_KKT)) {
        fLog(`RNDIS: у сетевой карты «${oFound.sAdapter}» уже есть адрес сети ККТ — не меняю`);
      } else {
        await pExec('netsh', ['interface', 'ipv4', 'set', 'address', `name=${oFound.sAdapter}`, 'static', A_RNDIS_HOST, '255.255.255.0'])
          .catch((oError) => fLog(`RNDIS: netsh — ${oError.message}`));
      }
    }
    let oSocket = null;
    for (let n = 0; n < 10 && !oSocket; n += 1) {
      oSocket = await pTcpSocket(A_RNDIS_KKT, 7778).catch(() => null);
      if (!oSocket) await new Promise((f) => setTimeout(f, 1500));
    }
    if (!oSocket) {
      throw new Error(`ККТ не отвечает по сети USB (${A_RNDIS_KKT}:7778). Если с ней сейчас работает драйвер или утилита`
        + ' производителя (тест драйвера, ККТ config, kktproxy) — закройте их: ККТ может не принять второе подключение по сети');
    }
    oPort = await KKT.pInitPort({ oSocket, sType: 'shtrih' });
  } else {
    try { fDetachKernel(); } catch (oError) { fLog(`RNDIS: драйвер ядра — ${oError.message}`); }
    oPort = await KKT.pInitPort(oFound.oDev);
  }
  if (oPort.oError) throw new Error(oPort.oError.message);
  const oKKT = new KKT({ sConnectionType: 'comPort', sVendorOrUrl: 'shtrih', id: oPort.sRegNumKKT || '', sNameKKT: '' }, oPort);
  try {
    await oKKT.pTaskSender({ type: 'setShtrihUsbMode', shtrihUsbMode: { socks: true, usb: 'vcom' } });
    await oKKT.pTaskSender({ type: 'rebootDevice' }).catch(() => {});
    fLog(`ККТ ${oPort.sName}: USB — COM-порт (VCOM), перезагрузка`);
    return { name: oPort.sName };
  } finally {
    await Promise.resolve(oPort.pDestroy?.(false)).catch(() => {});
  }
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
