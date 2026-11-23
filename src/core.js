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
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import dns from 'node:dns';
import { createRequire } from 'node:module';
import { vReadJson, fWriteJson } from './store.js';
import { aListSerialPorts, oSerialPort } from './serial.js';

import { pOpenDriver, oDriverSocket, pDrvCall } from './shtrih-drv.js';
const require = createRequire(import.meta.url);
const S_POLICY_FILE = 'policy.json';
const S_STORE_FILE = 'policy-store.json';
const N_CONNECTION_LOST = 241;
const N_NO_CONNECTION = 2;
// Модель (connectionSettings.model) → тип порта kkt-core. Числовые модели — Атол через ДТО 10.
export const O_CORE_MODELS = { shtrih: 'shtrih', viki: 'viki' };
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

/**
 * Куда соединяться за ККТ. 192.168.137.1 — «мы» в сети ККТ стека kkt-core
 * (PPP, RNDIS через libusb): у самого ПК такого адреса тогда нет, а за ним
 * ККТ ищет этот компьютер — ТС ПИоТ (эмулятор ОФД, табл. 19 = 192.168.137.1:41402)
 * и прочее, что слушает здесь. Ведём на 127.0.0.1.
 */
export const sKktTargetHost = (sHost) => (sHost === '192.168.137.1' ? '127.0.0.1' : sHost);

/** Обмен ККТ с ОФД: соединение, посылка, первый пришедший ответ — как /api/ofd кабинета. */
function pSendToOfd(sHostPort, aBytes) {
  return new Promise((fResolve, fReject) => {
    const n = sHostPort.lastIndexOf(':');
    const oSocket = net.connect(Number(sHostPort.slice(n + 1)), sKktTargetHost(sHostPort.slice(0, n)), () => oSocket.write(Buffer.from(aBytes)));
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
  const aOurs = aDevices.filter(bRndisUsb)
    .map((oDev) => ({ id: `usb:${oDev.serialNumber || ''}`, oDev, description: `Штрих-М — USB ${oDev.serialNumber || ''} в режиме сетевой карты (RNDIS)` }));
  if (aOurs.length) return aOurs;
  // Код 18d1:4ee4 есть, а имени не прочесть — нет доступа к устройству (имя
  // читается только открыв его). Без правила udev так и выглядит (стенд, 21.11.2026).
  const bLocked = aDevices.some((o) => o.vendorId === N_RNDIS_VID && o.productId === N_RNDIS_PID && !o.productName);
  return bLocked ? [{
    id: 'usb:locked', bNoDriver: true,
    description: 'Похоже, Штрих-М в режиме сетевой карты USB (RNDIS), но у сервера нет доступа к USB-устройству:'
      + ' нужно правило udev — его ставит «kktsite-agent service install» (от root); потом переподключите ККТ.',
  }] : [];
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
  // Linux: сеть ККТ уже настроена в ОС (адрес на интерфейсе rndis_host, ККТ
  // отвечает) — работаем через неё и устройство не забираем: им может
  // пользоваться и другая программа. Нет — напрямую по USB.
  // Признак — интерфейс ККТ в ОС с адресом из её сети, а не ответ на TCP:
  // сразу после закрытия соединения ККТ отвечает не всегда, и агент забирал
  // устройство себе, снося настроенный интерфейс (стенд, 21.11.2026).
  const sIface = process.platform === 'win32' ? '' : sLinuxRndisIface();
  if (sIface) {
    return [{ id: `tcp:${A_RNDIS_KKT}`, sHost: A_RNDIS_KKT, sIface, description: `Штрих-М — сеть USB, настроенная в ОС (${sIface}, ${A_RNDIS_KKT})` }];
  }
  const aFound = process.platform === 'win32' ? await pFindRndisWindows() : await pFindRndisUsb();
  if (aFound.some((o) => !o.bNoDriver)) return aFound;
  if (!await bRndisTcp()) return aFound;
  // Ответила по сети — значит, драйвер есть: подсказка «нет драйвера» лишняя.
  return [{ id: `tcp:${A_RNDIS_KKT}`, sHost: A_RNDIS_KKT, description: `Штрих-М отвечает по сети USB (${A_RNDIS_KKT}) — режим сетевой карты (RNDIS)` }];
}

/** Linux: интерфейс ОС у ККТ в RNDIS с адресом из сети ККТ (192.168.137.x) — его имя, иначе ''. */
function sLinuxRndisIface() {
  const S_USB = '/sys/bus/usb/devices';
  try {
    for (const sDev of readdirSync(S_USB)) {
      const sRead = (s) => { try { return readFileSync(`${S_USB}/${sDev}/${s}`, 'utf8').trim(); } catch { return ''; } };
      if (sRead('idVendor') !== '18d1' || sRead('idProduct') !== '4ee4') continue;
      const sNet = `${S_USB}/${sDev}:1.0/net`;
      if (!existsSync(sNet)) continue;
      for (const sIface of readdirSync(sNet)) {
        const bOurNet = (networkInterfaces()[sIface] || []).some((o) => o.family === 'IPv4' && o.address.startsWith('192.168.137.') && o.address !== A_RNDIS_KKT);
        if (bOurNet) return sIface;
      }
    }
  } catch { /* нет sysfs — значит, и интерфейса */ }
  return '';
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

// ——— Открыть Штрих по каналу: RNDIS или COM-порт (VCOM / PPP) ———

/** Порт kkt-core к ККТ в режиме RNDIS. oFound — из pFindRndis. */
async function pOpenRndisPort(oFound) {
  if (oFound.bNoDriver) throw new Error(oFound.description);
  const { KKT } = oCore();
  if (!oFound.sAdapter && !oFound.sHost) {
    // Linux: сеть ККТ — своим стеком kkt-core поверх USB, как у кассы в браузере.
    try { fDetachKernel(); } catch (oError) { fLog(`RNDIS: драйвер ядра — ${oError.message}`); }
    return KKT.pInitPort(oFound.oDev);
  }
  // Windows: сетевая карта ОС. Адрес из сети ККТ у неё уже есть (её настроили
  // для утилиты или драйвера производителя) — не трогаем: смена адреса оборвала
  // бы их связь с ККТ. Нет — ставим адрес шлюза ККТ. Адреса — цифрами из вывода
  // netsh: от языка Windows не зависят.
  if (oFound.sAdapter) {
    const sShow = await pExec('netsh', ['interface', 'ipv4', 'show', 'addresses', `name=${oFound.sAdapter}`]).catch(() => '');
    const aHave = sShow.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
    if (!aHave.some((sIp) => sIp.startsWith('192.168.137.') && sIp !== A_RNDIS_KKT)) {
      await pExec('netsh', ['interface', 'ipv4', 'set', 'address', `name=${oFound.sAdapter}`, 'static', A_RNDIS_HOST, '255.255.255.0'])
        .catch((oError) => fLog(`RNDIS: netsh — ${oError.message}`));
    }
  }
  // Только что закрытое соединение ККТ отпускает не сразу: новое она принимает,
  // но порт команд не открывает (стенд, 21.11.2026) — пауза, как у PPP, и повтор.
  await pSleep(Math.max(0, (mPppClosedAt.get(S_RNDIS_TCP) ?? 0) + N_PPP_REOPEN_MS - Date.now()));
  let oPort = null;
  let oLastError = null;
  for (let n = 0; n < 10 && !oPort; n += 1) {
    const oSocket = await pTcpSocket(A_RNDIS_KKT, 7778).catch(() => null);
    if (oSocket) {
      oPort = await KKT.pInitPort({ oSocket, sType: 'shtrih' }).catch((oError) => ({ oError }));
      if (oPort.oError) {
        oLastError = oPort.oError;
        await oSocket.close();
        oPort = null;
      } else {
        // У порта поверх готового сокета kkt-core своего pDestroy не ставит —
        // без этого соединение оставалось открытым, а второе ККТ не обслуживает
        // (стенд, 21.11.2026; вероятно, и «первая попытка не прошла» на Windows 7).
        oPort.pDestroy ??= async () => oSocket.close();
      }
    }
    if (!oPort) await pSleep(1500);
  }
  if (!oPort) {
    throw new Error(`ККТ не отвечает по сети USB (${A_RNDIS_KKT}:7778${oLastError ? `: ${oLastError.message}` : ''}). Если с ней сейчас работает драйвер или утилита`
      + ' производителя (тест драйвера, ККТ config, kktproxy) — закройте их: ККТ может не принять второе подключение по сети');
  }
  oPort.sAgentPath = S_RNDIS_TCP;
  oPort.bAgentTcp = true;
  return oPort;
}
const S_RNDIS_TCP = 'tcp:rndis';

/** Порт kkt-core к ККТ через драйвер Посцентра: кадры Штриха — методом ExchangeBytes. */
async function pOpenDriverPort(sUri, oConn = {}) {
  const { KKT } = oCore();
  const nPassword = Number(oConn.userPassword) || 30;
  const oOpen = await pOpenDriver(sUri, nPassword);
  const oSocket = oDriverSocket(oOpen.oDrv, nPassword, fLog);
  const oPort = await KKT.pInitPort({ oSocket, sType: 'shtrih' }).catch((oError) => ({ oError }));
  if (oPort.oError) {
    await oOpen.pClose();
    throw Object.assign(new Error(oPort.oError.message), { code: N_NO_CONNECTION });
  }
  oPort.oDrv = oOpen.oDrv;
  oPort.pDestroy = async () => { await oSocket.close(); await oOpen.pClose(); };
  oPort.sAgentPath = `driver:${sUri}`;
  return oPort;
}

// PPP, только что закрытый (переподключение, смена настроек, поиск), сразу не
// открывается: ККТ ещё не ждёт нового рукопожатия, первая попытка уходит в
// таймаут (~13 с); через 3–4 с — открывается (стенд, 21.11.2026). Поэтому после
// закрытия PPP — пауза, а не открылся порт — ещё раз.
const N_PPP_REOPEN_MS = 4000;
const mPppClosedAt = new Map(); // путь COM-порта → когда закрыт PPP

/** Порт kkt-core к ККТ на COM-порту (VCOM или PPP — kkt-core определит сам). */
async function pOpenComPort(sPath, nBaudRate = 115200, sType = 'shtrih') {
  await pSleep(Math.max(0, (mPppClosedAt.get(sPath) ?? 0) + N_PPP_REOPEN_MS - Date.now()));
  let oPort = await pOpenComOnce(sPath, nBaudRate, sType);
  if (oPort.oError) {
    await pDestroy(oPort);
    await pSleep(N_PPP_REOPEN_MS);
    oPort = await pOpenComOnce(sPath, nBaudRate, sType);
  }
  return oPort;
}

async function pOpenComOnce(sPath, nBaudRate, sType) {
  const { KKT } = oCore();
  // VID/PID — для определения типа; у RS-232 их нет, тогда скорость — из настроек.
  const oFound = (await aListSerialPorts().catch(() => [])).find((o) => o.path === sPath);
  const bUsb = Boolean(oFound?.vendorId);
  const oSerial = oSerialPort(sPath, {
    nBaudRate: bUsb ? 0 : nBaudRate,
    oInfo: bUsb ? { usbVendorId: parseInt(oFound.vendorId, 16), usbProductId: parseInt(oFound.productId, 16) } : {},
  });
  oSerial.sType = sType;
  const oPort = await KKT.pInitPort(oSerial);
  oPort.sAgentPath = sPath;
  return oPort;
}

/** Канал открытого порта Штриха: RNDIS, PPP (сокет поверх COM) или VCOM. */
const sPortChannel = (oPort) => (oPort.oSerial ? 'ppp' : oPort.oSocket ? 'rndis' : 'vcom');
/** RNDIS через сеть ОС (TCP к ККТ), а не своим стеком kkt-core: своей сети у ККТ
 * тогда нет — выход в ОФД только через SOCKS-сервер или маршрутизацию ОС. */
const bOsNet = (oFound) => Boolean(oFound?.sHost || oFound?.sAdapter);

const pSleep = (nMs) => new Promise((f) => setTimeout(f, nMs));
function pDestroy(oPort) {
  if ((oPort?.oSerial || oPort?.bAgentTcp) && oPort.sAgentPath) mPppClosedAt.set(oPort.sAgentPath, Date.now());
  return Promise.resolve(oPort?.pDestroy?.(false)).catch(() => {});
}

// Временная ККТ — поиск и смена канала: обмен с ОФД после заданий (kkt-core,
// shtrih/worker.js pOfdExchange) ей не нужен, а после закрытия порта он
// писал в журнал «Cannot call write after a stream was destroyed».
function oTempKkt(oPort) {
  const { KKT } = oCore();
  if (oPort.oError) throw new Error(oPort.oError.message);
  oPort.nOfdDownUntil = Number.MAX_SAFE_INTEGER;
  const oKKT = new KKT({ sConnectionType: 'comPort', sVendorOrUrl: 'shtrih', id: oPort.sRegNumKKT || '', sNameKKT: '' }, oPort);
  return async (oTask) => {
    // pTaskSender отдаёт сами результаты заданий (как pProcess у дескриптора), ошибки — броском.
    const [oResult] = await oKKT.pTaskSender(oTask);
    if (oResult?.status === 'error') throw new Error(oResult.error?.description || 'ошибка ККТ');
    return oResult ?? {};
  };
}

// ——— Поиск ККТ ———

/** Режим USB Штриха (getShtrihUsbMode) — что с SOCKS; не прочитался — undefined. */
async function pReadMode(oPort) {
  try {
    return (await oTempKkt(oPort)({ type: 'getShtrihUsbMode' })).shtrihUsbMode;
  } catch (oError) {
    fLog(`ККТ ${oPort.sName}: режим USB не прочитан — ${oError.message}`);
    return undefined;
  }
}

const A_SHTRIH_CHANNELS = ['vcom', 'ppp', 'rndis'];

/**
 * ККТ на этом ПК — для окна «Добавить ККТ»: [{ model, channel, com?, name?,
 * description, heldBy?, error? }]. model — shtrih | viki | atol; channel —
 * vcom | ppp | rndis | driver (Штрих), vcom (Вики), usb (Атол); driver — ККТ
 * уже подключена агентом через драйвер Посцентра. Свободные порты Штриха
 * открываем — узнать режим и заводской номер; занятые (aHeld: [{ id, name,
 * com?, channel, rndisByDriver? }] — подключённые ККТ агента) не трогаем.
 */
export async function pFindKkt(aHeld = []) {
  const aOut = [];
  for (const oPort of await pPortList()) {
    if (!oPort.model) continue;
    const oItem = { model: oPort.model, channel: oPort.model === 'atol' ? 'usb' : 'vcom', com: oPort.key, description: oPort.description };
    const oHeld = aHeld.find((o) => o.com && sPortPath(o.com) === oPort.path);
    if (oHeld) {
      Object.assign(oItem, { heldBy: oHeld.id, name: oHeld.name, channel: oHeld.channel || oItem.channel });
      if (oPort.model === 'shtrih') oItem.mode = await oHeld.pMode?.().catch(() => undefined);
    } else if (oPort.model === 'shtrih') {
      let oKkt = null;
      try {
        oKkt = await pOpenComPort(oPort.path);
        if (oKkt.oError) throw oKkt.oError;
        Object.assign(oItem, { channel: sPortChannel(oKkt), name: oKkt.sName, mode: await pReadMode(oKkt) });
      } catch (oError) {
        oItem.error = oError.message;
      } finally {
        await pDestroy(oKkt);
      }
    }
    aOut.push(oItem);
  }
  for (const oFound of await pFindRndis()) {
    const oItem = { model: 'shtrih', channel: 'rndis', description: oFound.description, ...(bOsNet(oFound) ? { osNet: true } : {}) };
    const oHeld = aHeld.find((o) => o.channel === 'rndis' || o.rndisByDriver);
    if (oHeld) {
      Object.assign(oItem, { heldBy: oHeld.id, name: oHeld.name, mode: await oHeld.pMode?.().catch(() => undefined) });
      if (oHeld.osNet !== undefined) oItem.osNet = oHeld.osNet || undefined;
      // Драйвер ходит к ККТ по TCP — это всегда сеть ОС.
      if (oHeld.rndisByDriver) Object.assign(oItem, { channel: 'driver', osNet: true });
    }
    else if (oFound.bNoDriver) oItem.error = oFound.description;
    else {
      let oKkt = null;
      try {
        oKkt = await pOpenRndisPort(oFound);
        if (oKkt.oError) throw oKkt.oError;
        Object.assign(oItem, { name: oKkt.sName, mode: await pReadMode(oKkt) });
      } catch (oError) {
        oItem.error = oError.message;
      } finally {
        await pDestroy(oKkt);
      }
    }
    aOut.push(oItem);
  }
  return aOut;
}

// ——— Смена канала Штриха ———
//
// Каналы — режим USB ККТ (Посцентр): таблица 21 поле 9 — VCOM/RNDIS (после
// перезагрузки), поле 1 — PPP (3; действует сразу: порт тут же говорит другим
// протоколом), таблица 16 поле 19 — SOCKS (после перезагрузки). Стенд,
// 20–21.11.2026; подробнее — у pSwitchShtrih (device.js).

/** Какую ККТ в RNDIS открывать; нет такой — ошибка с причиной (нет драйвера, нет доступа). */
async function pRndisToOpen() {
  const aFound = await pFindRndis();
  const oFound = aFound.find((o) => !o.bNoDriver);
  if (!oFound) throw new Error(aFound[0]?.description || 'ККТ в режиме сетевой карты USB (RNDIS) не найдена');
  return oFound;
}

/** Открыть Штрих на канале oFrom ({ channel, com? }) — порт kkt-core. */
async function pOpenChannel(oFrom) {
  if (oFrom.channel === 'rndis') {
    return pOpenRndisPort(await pRndisToOpen());
  }
  if (!oFrom.com) throw new Error('Не выбран COM-порт ККТ');
  return pOpenComPort(sPortPath(oFrom.com));
}

/** Ждать, пока ККТ не появится на канале sTo; до nTotalMs. Нашлась — { channel, com?, name }. */
async function pWaitChannel(sTo, nTotalMs, nFirstMs = 0) {
  const nUntil = Date.now() + nTotalMs;
  await pSleep(nFirstMs);
  while (Date.now() < nUntil) {
    const oFound = (await pFindKkt().catch(() => [])).find((o) => o.model === 'shtrih' && o.channel === sTo && !o.error);
    if (oFound) return oFound;
    await pSleep(3000);
  }
  return null;
}

/**
 * Перевести Штрих с канала oFrom ({ channel, com? }) на sTo (vcom | ppp |
 * rndis). Порт ККТ должен быть свободен. Возвращает { channel, com?, name }
 * — где ККТ теперь, или { rebootNeeded: true }, если режим записан, а
 * перезагрузиться сама ККТ не смогла.
 */
export async function pShtrihSwitch(oFrom, sTo) {
  if (!A_SHTRIH_CHANNELS.includes(sTo) || !A_SHTRIH_CHANNELS.includes(oFrom?.channel)) throw new Error('Канал — vcom, ppp или rndis');
  if (oFrom.channel === sTo) throw new Error('ККТ уже на этом канале');
  const fSay = (s) => fLog(`Смена канала Штриха ${oFrom.channel} → ${sTo}: ${s}`);
  let oPort = await pOpenChannel(oFrom);
  try {
    let fRun = oTempKkt(oPort);
    const oMode = (await fRun({ type: 'getShtrihUsbMode' })).shtrihUsbMode ?? {};
    const pReboot = async () => {
      try {
        await fRun({ type: 'rebootDevice' });
        fSay(`${oPort.sName}: режим записан, перезагрузка`);
        return true;
      } catch (oError) {
        fSay(`${oPort.sName}: режим записан, перезагрузка не прошла (${oError.message}) — перезагрузите ККТ кнопкой`);
        return false;
      }
    };
    let bRebooted;

    if (sTo === 'rndis') {
      // SOCKS — чтобы ККТ ходила в ОФД и ОИСМ через агента. Из PPP: поле 1
      // пишется последним, после него порт — уже обычный VCOM: перезагрузку
      // шлём, открыв его заново.
      await fRun({ type: 'setShtrihUsbMode', shtrihUsbMode: { usb: 'rndis', socks: true, ...(oFrom.channel === 'ppp' ? { ppp: 0 } : {}) } });
      if (oFrom.channel === 'ppp') {
        await pDestroy(oPort);
        oPort = null;
        await pSleep(4000);
        for (let n = 0; n < 8 && !oPort; n += 1) {
          oPort = await pOpenComPort(sPortPath(oFrom.com)).catch(() => null);
          if (oPort?.oError) { await pDestroy(oPort); oPort = null; }
          if (!oPort) await pSleep(2000);
        }
        if (!oPort) throw new Error('после выключения PPP ККТ не ответила по VCOM — перезагрузите её кнопкой');
        fRun = oTempKkt(oPort);
      }
      bRebooted = await pReboot();
    } else if (oFrom.channel === 'rndis') {
      // В PPP после загрузки: задача PPP прошивки стартует только при ней.
      await fRun({ type: 'setShtrihUsbMode', shtrihUsbMode: { usb: 'vcom', socks: sTo === 'ppp', ppp: sTo === 'ppp' ? 3 : 0 } });
      bRebooted = await pReboot();
    } else if (sTo === 'vcom') {
      await fRun({ type: 'setShtrihUsbMode', shtrihUsbMode: { socks: false, ppp: 0 } });
      fSay(`${oPort.sName}: PPP выключен`);
      bRebooted = true;
    } else {
      // VCOM → PPP: у ККТ, загруженной без PPP, поле 1 действует только после
      // перезагрузки, а перезагрузить командой уже нельзя (порт молчит) —
      // сторожевой таймер интерфейса на 1 минуту: ККТ перезагрузится сама.
      // Потом таймер — как был.
      await fRun({ type: 'setShtrihUsbMode', shtrihUsbMode: { watchdog: 1, socks: true, ppp: 3 } });
      fSay(`${oPort.sName}: PPP включён, ждём ККТ (до двух минут)`);
      await pDestroy(oPort);
      oPort = null;
      const nAt = Date.now();
      const oNow = await pWaitChannel('ppp', 150e3, 4000);
      if (!oNow) throw new Error('ККТ не поднялась с PPP за две с половиной минуты — перезагрузите её кнопкой');
      oPort = await pOpenChannel(oNow);
      fRun = oTempKkt(oPort);
      if ((oMode.watchdog ?? 0) !== 1) await fRun({ type: 'setShtrihUsbMode', shtrihUsbMode: { watchdog: oMode.watchdog ?? 0 } });
      // SOCKS ККТ читает при загрузке: не было его, а PPP поднялся без
      // перезагрузки (быстрее 20 с) — перезагрузить (по PPP можно).
      bRebooted = true;
      if (!oMode.socks && Date.now() - nAt < 20e3) bRebooted = await pReboot();
    }
    await pDestroy(oPort);
    oPort = null;
    if (!bRebooted) return { rebootNeeded: true };
    const oNow = await pWaitChannel(sTo, 90e3, sTo === 'vcom' && oFrom.channel === 'ppp' ? 3000 : 10e3);
    if (!oNow) return { rebootNeeded: true };
    fSay(`ККТ — на канале ${sTo}`);
    return oNow;
  } finally {
    await pDestroy(oPort);
  }
}

/**
 * SOCKS в Штрихе (таблица 16 поле 19) — включить или выключить и
 * перезагрузить: ККТ читает его при загрузке. С SOCKS ККТ ходит в ОФД и ОИСМ
 * через SOCKS-сервер 192.168.137.1:1080 (агента или kktproxy), без него —
 * напрямую через шлюз 192.168.137.1 (общий доступ к интернету в Windows).
 * oFrom — { channel, com? } свободного порта ККТ.
 */
export async function pShtrihSetSocks(oFrom, bSocks) {
  const oPort = await pOpenChannel(oFrom);
  try {
    const fRun = oTempKkt(oPort);
    await fRun({ type: 'setShtrihUsbMode', shtrihUsbMode: { socks: Boolean(bSocks) } });
    try {
      await fRun({ type: 'rebootDevice' });
    } catch (oError) {
      fLog(`ККТ ${oPort.sName}: SOCKS ${bSocks ? 'включён' : 'выключен'}, перезагрузка не прошла (${oError.message})`);
      return { rebootNeeded: true };
    }
    fLog(`ККТ ${oPort.sName}: SOCKS ${bSocks ? 'включён' : 'выключен'}, перезагрузка`);
  } finally {
    await pDestroy(oPort);
  }
  const oNow = await pWaitChannel(oFrom.channel, 90e3, 10e3);
  return oNow ?? { rebootNeeded: true };
}

const R_PORT_GONE = /File not found|The device does not recognize the command|device (is not connected|has been lost)|Порт ККТ закрыт|stream was destroyed|ENOENT|ENXIO|EIO\b/i;

/** COM-порт по настройке: на Windows — номер (как у Web Requests), иначе путь. */
const sPortPath = (vCom) => (process.platform === 'win32' && /^\d+$/.test(String(vCom)) ? `COM${vCom}` : String(vCom ?? ''));

/** Дескриптор ККТ через kkt-core: fOpen(connectionSettings) / pProcess(задание) / fClose. */
export function oCreateCoreHandle() {
  const { KKT } = oCore();
  let oPort = null;
  let oKKT = null;
  let sType = '';
  let oConnOpen = null;
  return {
    async fOpen(oConn) {
      oConnOpen = oConn;
      sType = O_CORE_MODELS[String(oConn.model)];
      // Штрих по сети USB (RNDIS): Linux — стек kkt-core поверх USB, Windows —
      // сетевая карта ОС и TCP к 192.168.137.111. Иначе — COM-порт (VCOM или
      // PPP — kkt-core различит сам).
      if (oConn.port === 'driver') {
        // Штрих через штатный драйвер Посцентра (shtrih-drv.js) — для ТС ПИоТ.
        if (sType !== 'shtrih') throw Object.assign(new Error('Через драйвер Посцентра подключается только Штрих-М'), { code: N_NO_CONNECTION });
        oPort = await pOpenDriverPort(oConn.driverUri, oConn);
        this.oDrv = oPort.oDrv;
      } else if (oConn.port === 'rndis') {
        const oFound = await pRndisToOpen().catch((oError) => { throw Object.assign(oError, { code: N_NO_CONNECTION }); });
        oPort = await pOpenRndisPort(oFound).catch((oError) => { throw Object.assign(new Error(oError.message), { code: N_NO_CONNECTION }); });
        this.bOsNet = bOsNet(oFound);
      } else {
        const sPath = sPortPath(oConn.com);
        if (!sPath) throw Object.assign(new Error('Не выбран COM-порт ККТ'), { code: N_NO_CONNECTION });
        oPort = await pOpenComPort(sPath, Number(oConn.baudRate) || 115200, sType);
      }
      if (oPort.oError) {
        const oError = Object.assign(new Error(oPort.oError.message), { code: N_NO_CONNECTION });
        await pDestroy(oPort);
        throw oError;
      }
      this.sChannel = sType !== 'shtrih' ? 'vcom' : oPort.oDrv ? 'driver' : sPortChannel(oPort);
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
      // Драйвер Посцентра помнит проверенные и принятые коды сам и повторную
      // проверку того же кода отвергает (211), пока их не очистить его методом
      // (стенд, 22.11.2026); у kkt-core для Штриха это задание без команды.
      if (oTask?.type === 'clearMarkingCodeValidationResult' && this.oDrv) {
        const oClear = await pDrvCall(this.oDrv, 'FNMarkingClearBuffer', { Password: Number(oConnOpen?.userPassword) || 30 });
        if (oClear.ResultCode !== 0) throw { code: 500, description: `Драйвер Посцентра: ${oClear.ResultCodeDescription}` };
        return null;
      }
      // Сокет поверх драйвера Посцентра закрыт (драйвер потерял ККТ): кадры
      // никуда не идут, и kkt-core ждал бы ответа впустую — «ККТ не отвечает
      // на порту», а ККТ не переподключалась (Win7, 23.11.2026). Это обрыв.
      const fGone = () => oPort?.oSocket?.bClosed
        && { code: N_CONNECTION_LOST, description: `Связь с ККТ потеряна: ${oPort.oSocket.sLastError || 'соединение закрыто'}` };
      if (fGone()) throw fGone();
      try {
        const aResults = await oKKT.pTaskSender(oTask);
        return aResults?.[0] ?? null;
      } catch (oError) {
        // Порт пропал (ККТ перезагрузили или выдернули): у Windows-сборки
        // serialport это ошибки записи/чтения вида «… (GetOverlappedResult):
        // File not found», а не обрыв чтения. Тоже обрыв: device.js откроет
        // ККТ заново, когда порт появится (21.11.2026, Win7).
        if (fGone()) throw fGone();
        if (oPort?.oError || R_PORT_GONE.test(oError?.message || '')) throw { code: N_CONNECTION_LOST, description: oError.message };
        throw { code: typeof oError.code === 'number' ? oError.code : 500, description: oError.message };
      }
    },
    /** Канал, на котором ККТ открыта: vcom | ppp | rndis | driver. */
    sChannel: '',
    /** Контекст драйвера Посцентра (канал driver) — для методов, которые видит ТС ПИоТ. */
    oDrv: null,
    /** RNDIS через сеть ОС (TCP), а не стеком kkt-core. */
    bOsNet: false,
    fClose() {
      const o = oPort;
      oPort = null;
      this.sChannel = '';
      this.oDrv = null;
      oKKT = null;
      pDestroy(o);
    },
  };
}
