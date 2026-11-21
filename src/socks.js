// SOCKS5-сервер для ККТ — как kktproxy Посцентра: ККТ с сетевым интерфейсом
// (Штрих-М в RNDIS через сетевую карту ОС, позже — киоск по Ethernet) с
// включённым SOCKS (таблица 16 поле 19) ходит в ОФД, ОИСМ и ОКП через этот ПК.
// Адрес по умолчанию у ККТ — 192.168.137.1:1080.
//
// Включается галочкой в общих настройках (socksServer, settings.js): без неё
// ККТ выходит в сеть и иначе — через стек kkt-core (USB напрямую, PPP) или
// маршрутизацию ОС (общий доступ к интернету в Windows), тогда SOCKS в ККТ
// выключают.
//
// Только CONNECT, без пароля (так ходит ККТ). Клиенты — сеть ККТ
// 192.168.137.0/24 и этот ПК: в локальную сеть открытый прокси не выставляем.
// Имена производителя (*.kktlab.ru) — как в стеке kkt-core (shtrih/ipstack.js):
// с vendorData — по полному имени (его разрешит DNS производителя), без —
// хвост служебных данных отрезается, к самому производителю — отказ.

import net from 'node:net';

const N_PORT = 1080;
const R_VENDOR_NAME = /(^|\.)kktlab\.ru$/i;
const R_VENDOR_TAIL = /\.[a-z2-7]+\.[a-z2-7]+\.dev\.kktlab\.ru$/i;
const N_CONNECT_TIMEOUT_MS = 15e3;

/** Кому можно: сеть ККТ 192.168.137.0/24 и этот ПК. */
export function bSocksClientAllowed(sAddress) {
  const s = String(sAddress || '').replace(/^::ffff:/, '');
  return s === '127.0.0.1' || s === '::1' || /^192\.168\.137\.\d{1,3}$/.test(s);
}

/** Куда идти по CONNECT: имя или адрес; null — отказ. */
export function sSocksTarget(sHost, bVendorData) {
  if (bVendorData && R_VENDOR_NAME.test(sHost)) return sHost;
  const sShort = sHost.replace(R_VENDOR_TAIL, '');
  return R_VENDOR_NAME.test(sShort) ? null : sShort;
}

let oServer = null;
let oStatus = { enabled: false, listening: false, port: N_PORT, error: '' };
let fLog = () => {};
let bVendorData = true;

export function fConfigureSocks({ fLog: fNewLog } = {}) {
  if (fNewLog) fLog = fNewLog;
}

/** Состояние сервера — для страницы. */
export const oSocksStatus = () => ({ ...oStatus });

/** Включить или выключить сервер (settings.js); vendorData — как у kkt-core. */
export function fSetSocksServer(bOn, { vendorData = true, nPort = N_PORT } = {}) {
  bVendorData = vendorData;
  if (Boolean(bOn) === oStatus.enabled && nPort === oStatus.port) return;
  if (oServer) {
    oServer.close();
    oServer = null;
  }
  oStatus = { enabled: Boolean(bOn), listening: false, port: nPort, error: '' };
  if (!bOn) return;
  const oNew = net.createServer(fOnClient);
  oServer = oNew;
  oNew.on('error', (oError) => {
    if (oServer !== oNew) return;
    // Порт занят — скорее всего, kktproxy Посцентра: ККТ пойдёт через него.
    oStatus = { ...oStatus, listening: false, error: oError.code === 'EADDRINUSE'
      ? `порт ${nPort} занят другой программой (kktproxy Посцентра?) — ККТ пойдёт через неё` : oError.message };
    fLog(`SOCKS: ${oStatus.error}`);
  });
  oNew.listen(nPort, '0.0.0.0', () => {
    if (oServer !== oNew) return;
    oStatus = { ...oStatus, listening: true, error: '' };
    fLog(`SOCKS: слушаю 0.0.0.0:${nPort} (для ККТ 192.168.137.0/24)`);
  });
}

function fOnClient(oClient) {
  const sFrom = String(oClient.remoteAddress || '').replace(/^::ffff:/, '');
  if (!bSocksClientAllowed(sFrom)) {
    oClient.destroy();
    return;
  }
  let aBuf = Buffer.alloc(0);
  let nStage = 0; // 0 — приветствие, 1 — запрос, 2 — соединяемся, 3 — передача
  const fReply = (nCode) => oClient.write(Buffer.from([5, nCode, 0, 1, 0, 0, 0, 0, 0, 0]));
  oClient.setTimeout(N_CONNECT_TIMEOUT_MS, () => { if (nStage < 3) oClient.destroy(); });
  oClient.on('error', () => {});
  oClient.on('data', function fOnData(oChunk) {
    aBuf = Buffer.concat([aBuf, oChunk]);
    if (nStage === 0) {
      if (aBuf.length < 2 || aBuf.length < 2 + aBuf[1]) return;
      if (aBuf[0] !== 5) { oClient.destroy(); return; }
      const bNoAuth = aBuf.subarray(2, 2 + aBuf[1]).includes(0);
      aBuf = aBuf.subarray(2 + aBuf[1]);
      oClient.write(Buffer.from([5, bNoAuth ? 0 : 0xFF]));
      if (!bNoAuth) { oClient.end(); return; }
      nStage = 1;
    }
    if (nStage === 1) {
      if (aBuf.length < 5) return;
      let sHost, nOff;
      if (aBuf[3] === 1) {
        if (aBuf.length < 10) return;
        sHost = [...aBuf.subarray(4, 8)].join('.');
        nOff = 8;
      } else if (aBuf[3] === 3) {
        if (aBuf.length < 7 + aBuf[4]) return;
        sHost = aBuf.subarray(5, 5 + aBuf[4]).toString('latin1').toLowerCase();
        nOff = 5 + aBuf[4];
      } else {
        fReply(8); // тип адреса не поддерживается (IPv6)
        oClient.end();
        return;
      }
      if (aBuf[1] !== 1) { fReply(7); oClient.end(); return; } // только CONNECT
      const nPort = aBuf.readUInt16BE(nOff);
      aBuf = aBuf.subarray(nOff + 2);
      nStage = 2;
      const sTo = sSocksTarget(sHost, bVendorData);
      if (!sTo) {
        fLog(`SOCKS: ${sFrom} → ${sHost.replace(R_VENDOR_TAIL, '')}:${nPort} — служебный адрес производителя, отказ`);
        fReply(2);
        oClient.end();
        return;
      }
      fLog(`SOCKS: ${sFrom} → ${sTo.replace(R_VENDOR_TAIL, '')}:${nPort}`);
      const oPeer = net.connect(nPort, sTo);
      oPeer.setTimeout(N_CONNECT_TIMEOUT_MS, () => oPeer.destroy(new Error('не ответил')));
      oPeer.once('connect', () => {
        oPeer.setTimeout(0);
        oClient.setTimeout(0);
        const a = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        const aLocal = String(oPeer.localAddress || '').replace(/^::ffff:/, '').split('.').map(Number);
        if (aLocal.length === 4) aLocal.forEach((n, i) => { a[4 + i] = n; });
        a.writeUInt16BE(oPeer.localPort || 0, 8);
        oClient.write(a);
        nStage = 3;
        oClient.off('data', fOnData);
        if (aBuf.length) oPeer.write(aBuf);
        oClient.pipe(oPeer);
        oPeer.pipe(oClient);
      });
      oPeer.on('error', (oError) => {
        if (nStage === 2) {
          fLog(`SOCKS: ${sTo}:${nPort} — ${oError.message}`);
          fReply(oError.code === 'ENOTFOUND' ? 4 : 5);
          oClient.end();
        } else {
          oClient.destroy();
        }
      });
      oClient.on('close', () => oPeer.destroy());
      oPeer.on('close', () => oClient.destroy());
    }
  });
}
