// GET /api/v2/utils/mapping — возможные значения настроек ККТ, формат Web
// Requests: { поле: [{ key, description }] }. По нему страница настроек (и
// страница самого Web Requests) строит выпадающие списки.
//
// Модели, скорости и каналы ОФД — ровно как у Web Requests 1.0.4.0.
// USB-устройства и COM-порты — те, что есть на этом ПК сейчас:
//   — USB: ККТ Атола (vendor 2912) из /sys/bus/usb/devices, ключ — адрес
//     устройства на шине (2-1), как у Web Requests; на Windows и macOS —
//     только «Автоматически»;
//   — COM: на Linux — /dev/ttyACM*, ttyUSB*, ttyS*, rfcomm*, ключ — путь;
//     на macOS — /dev/cu.*; на Windows — COM1…COM99 номером, как у Web
//     Requests (список портов Windows без нативного модуля не получить).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const A_MODELS = [
  ['500', 'Автоматически (АТОЛ)'],
  ['93', 'АТОЛ 1Ф'],
  ['96', 'АТОЛ 2Ф'],
  ['67', 'АТОЛ 11Ф'],
  ['78', 'АТОЛ 15Ф'],
  ['81', 'АТОЛ 20Ф'],
  ['63', 'АТОЛ 22Ф (АТОЛ FPrint-22ПТК)'],
  ['95', 'АТОЛ 22 v2 Ф'],
  ['57', 'АТОЛ 25Ф'],
  ['87', 'АТОЛ 27Ф'],
  ['61', 'АТОЛ 30Ф'],
  ['97', 'АТОЛ 35Ф'],
  ['77', 'АТОЛ 42ФС'],
  ['48', 'АТОЛ 47ФА'],
  ['80', 'АТОЛ 50Ф'],
  ['62', 'АТОЛ 55Ф'],
  ['66', 'АТОЛ 55 v2 Ф'],
  ['69', 'АТОЛ 77Ф'],
  ['82', 'АТОЛ 91Ф'],
  ['84', 'АТОЛ 92Ф'],
  ['89', 'АТОЛ ПТ-5Ф'],
  ['76', 'Казначей ФА'],
  ['70', 'АТОЛ 42ФА'],
  ['50', 'Альянс 20Ф'],
  ['94', 'АТОЛ СТБ 6Ф'],
];
const A_PORTS = [['com', 'COM / TTY'], ['usb', 'USB'], ['tcp', 'TCP/IP'], ['bluetooth', 'Bluetooth']];
const A_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
  .map((n) => [String(n), `${n} бод`]);
const A_OFD_CHANNELS = [['none', 'Нет'], ['auto', 'Автоматически (EoT)']];

const S_ATOL_VENDOR = '2912';
const S_USB_DIR = '/sys/bus/usb/devices';

const fPairs = (aList) => aList.map(([key, description]) => ({ key, description }));

function sReadSys(sDir, sName) {
  try {
    return readFileSync(join(sDir, sName), 'utf8').trim();
  } catch {
    return '';
  }
}

function aUsbDevices() {
  const aList = [['auto', 'Автоматически']];
  if (process.platform !== 'linux' || !existsSync(S_USB_DIR)) return aList;
  for (const sName of readdirSync(S_USB_DIR).sort()) {
    const sDir = join(S_USB_DIR, sName);
    if (sReadSys(sDir, 'idVendor') !== S_ATOL_VENDOR) continue;
    const sProduct = sReadSys(sDir, 'product');
    aList.push([sName, `USB: ${sName}${sProduct ? ` (${sProduct})` : ''}`]);
  }
  return aList;
}

function aComPorts() {
  if (process.platform === 'win32') {
    return Array.from({ length: 99 }, (_, n) => [String(n + 1), `COM${n + 1}`]);
  }
  const rName = process.platform === 'darwin' ? /^cu\./ : /^(ttyACM|ttyUSB|ttyS|rfcomm)\d+$/;
  let aNames = [];
  try {
    aNames = readdirSync('/dev').filter((s) => rName.test(s));
  } catch { /* /dev недоступен — портов нет */ }
  const fOrder = (s) => [s.replace(/\d+$/, ''), Number(/\d+$/.exec(s)?.[0] ?? 0)];
  aNames.sort((a, b) => {
    const [sA, nA] = fOrder(a);
    const [sB, nB] = fOrder(b);
    return sA === sB ? nA - nB : sA.localeCompare(sB);
  });
  return aNames.map((s) => [`/dev/${s}`, `/dev/${s}`]);
}

export function oMapping() {
  return {
    model: fPairs(A_MODELS),
    port: fPairs(A_PORTS),
    com: fPairs(aComPorts()),
    usbDevice: fPairs(aUsbDevices()),
    baudRate: fPairs(A_BAUD_RATES),
    ofdChannel: fPairs(A_OFD_CHANNELS),
  };
}
