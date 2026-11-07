// Связь кассы с модулем ТС ПИоТ (проверка кодов маркировки в разрешительном
// режиме) — сквозной путь /piot/*: /piot/api/v3/codes/check агент отправляет на
// <адрес модуля>/api/v3/codes/check и возвращает ответ как есть, с тем же
// HTTP-кодом (203 — аварийный режим, 514 — нет связи ни с кем, …): читает его
// касса (avb56/kktsite: apps/app/src/modules/marking/piot.js).
//
// Зачем агент. Модуль слушает https://<имя-ПК>:51401 с сертификатом на имя
// компьютера, а касса работает в браузере: песочница оператора не разрешает в
// CORS заголовок Content-Type, и браузер срезает POST /codes/check ещё на
// предзапросе (стенд, 03.11.2026); сертификату модуля браузер тоже не доверяет.
// Агенту CORS не нужен, а сертификат он проверяет сам.
//
// Сертификат модуля. Чем он подписан, документация оператора не говорит — у
// модуля, скорее всего, свой самоподписанный. Поэтому:
//   — цепочка сходится к корневым сертификатам системы и имя совпадает —
//     доверяем, как браузер (песочница, или сертификат вендора поставлен в ОС);
//   — иначе доверие при первом подключении: агент запоминает отпечаток SHA-256
//     и дальше принимает только его. Сменился — запрос не уходит (коды на
//     чужой сервер не попадут), а на странице агента новый отпечаток
//     подтверждают кнопкой (решение пользователя, 03.11.2026).
// Отпечаток проверяется после рукопожатия, но до отправки запроса: сокет
// отдаётся HTTP-клиенту, только когда отпечаток сверен.
//
// Адрес модуля — piot.json каталога данных; по умолчанию https://<имя этого
// ПК>:51401, так что на обычной кассе вписывать ничего не нужно. Для стенда —
// адрес песочницы или scripts/piot-proxy.mjs из avb56/kktsite.
//
// Коды маркировки в журнал не пишем: только метод, путь, код ответа и время.

import { request as httpRequest } from 'node:http';
import { hostname } from 'node:os';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { AgentError } from './device.js';
import { fWriteJson, vReadJson } from './store.js';

const S_FILE = 'piot.json';
const N_PORT = 51401;
// Касса ждёт ответа сама (codesCheckTimeout из /info + запас) и бросает
// запрос раньше; здесь — только чтобы зависший модуль не держал сокеты.
const N_TIMEOUT_MS = 30000;
const N_MAX_ANSWER = 4 * 1024 * 1024;

/** Адрес модуля по умолчанию: имя этого компьютера — на него и выписан сертификат. */
export function sDefaultPiotUrl() {
  return `https://${hostname().toLowerCase()}:${N_PORT}`;
}

let oState = null; // { url, fingerprint } — piot.json
// Последний отпечаток, увиденный при подключении, — подтвердить можно только
// его: страница не может прислать «любой» отпечаток вслепую.
let oLastSeen = null;

function oLoad() {
  if (!oState) {
    const oFile = vReadJson(S_FILE, {});
    oState = {
      url: typeof oFile.url === 'string' ? oFile.url : '',
      fingerprint: typeof oFile.fingerprint === 'string' ? oFile.fingerprint : '',
    };
  }
  return oState;
}

function fSave(oNext) {
  fWriteJson(S_FILE, oNext);
  oState = oNext;
}

/** Куда сейчас идут запросы. */
export function sPiotTarget() {
  return (oLoad().url || sDefaultPiotUrl()).replace(/\/+$/, '');
}

export function oPiotStatus() {
  const { url, fingerprint } = oLoad();
  return { url, defaultUrl: sDefaultPiotUrl(), target: sPiotTarget(), fingerprint: fingerprint || null };
}

/** Адрес модуля: схема, имя и порт; пустой — по умолчанию. Новый адрес — новый сертификат. */
export function oPutPiot({ url } = {}) {
  const sUrl = String(url ?? '').trim().replace(/\/+$/, '');
  if (sUrl) {
    let oUrl;
    try {
      oUrl = new URL(sUrl);
    } catch {
      throw new AgentError(400, `Не адрес: ${sUrl}`);
    }
    if (oUrl.protocol !== 'https:' && oUrl.protocol !== 'http:') throw new AgentError(400, 'Адрес модуля — http:// или https://');
    if (oUrl.username || oUrl.password) throw new AgentError(400, 'Логин и пароль в адресе модуля не нужны');
    if (oUrl.pathname !== '/' || oUrl.search || oUrl.hash) throw new AgentError(400, 'Только схема, имя компьютера и порт — без пути: https://имя-компьютера:51401');
  }
  const oPrev = oLoad();
  const bSameTarget = (sUrl || sDefaultPiotUrl()) === sPiotTarget();
  fSave({ url: sUrl, fingerprint: bSameTarget ? oPrev.fingerprint : '' });
  if (!bSameTarget) oLastSeen = null;
  return oPiotStatus();
}

/** Подтвердить новый сертификат модуля — только тот, что агент видел последним. */
export function oTrustPiot({ fingerprint } = {}) {
  if (!oLastSeen || oLastSeen.sTarget !== sPiotTarget() || oLastSeen.sFingerprint !== fingerprint) {
    throw new AgentError(409, 'Этот сертификат агент не видел — нажмите «Проверить связь» и подтвердите заново');
  }
  fSave({ ...oLoad(), fingerprint });
  return oPiotStatus();
}

export class PiotError extends Error {
  constructor(sMessage, oCertificate = null) {
    super(sMessage);
    this.oCertificate = oCertificate;
  }
}

function oDescribeCertificate(oCert, sTrust) {
  return {
    fingerprint: oCert.fingerprint256 || '',
    subject: oCert.subject?.CN || '',
    names: String(oCert.subjectaltname || '').split(', ').filter(Boolean).map((s) => s.replace(/^(DNS|IP Address):/, '')),
    issuer: oCert.issuer?.CN || oCert.issuer?.O || '',
    validTo: oCert.valid_to ? new Date(oCert.valid_to).toISOString() : '',
    trust: sTrust, // system | pinned | first | changed
  };
}

/**
 * TLS-сокет к модулю, отдаётся только после проверки сертификата (см. начало
 * файла). fDone(oError, oSocket, oCertificate).
 */
function fConnectTls(oUrl, fLog, fDone) {
  const sHost = oUrl.hostname.replace(/^\[|\]$/g, '');
  const bIp = /^[\d.]+$|:/.test(sHost);
  const oSocket = tlsConnect({
    host: sHost,
    port: Number(oUrl.port || 443),
    ...(bIp ? {} : { servername: sHost }),
    rejectUnauthorized: false,
    ALPNProtocols: ['http/1.1'],
  });
  let bDone = false;
  const fFinish = (oError, oCert) => {
    if (bDone) return;
    bDone = true;
    if (oError) {
      oSocket.destroy();
      fDone(oError, null, oCert);
    } else {
      fDone(null, oSocket, oCert);
    }
  };
  oSocket.once('error', (oError) => fFinish(new PiotError(`Нет связи с модулем ${oUrl.host}: ${oError.message}`)));
  oSocket.once('secureConnect', () => {
    const oPeer = oSocket.getPeerCertificate();
    if (!oPeer?.fingerprint256) return fFinish(new PiotError(`Модуль ${oUrl.host} не прислал сертификат`));
    if (oSocket.authorized && !checkServerIdentity(sHost, oPeer)) return fFinish(null, oDescribeCertificate(oPeer, 'system'));

    const sTarget = `${oUrl.protocol}//${oUrl.host}`;
    const sSeen = oPeer.fingerprint256;
    oLastSeen = { sTarget, sFingerprint: sSeen };
    const oSaved = oLoad();
    if (!oSaved.fingerprint) {
      // Первое подключение к этому адресу — запоминаем.
      fSave({ ...oSaved, fingerprint: sSeen });
      fLog(`ПИоТ: сертификат модуля ${oUrl.host} запомнен, SHA-256 ${sSeen}`);
      return fFinish(null, oDescribeCertificate(oPeer, 'first'));
    }
    if (oSaved.fingerprint === sSeen) return fFinish(null, oDescribeCertificate(oPeer, 'pinned'));
    fLog(`ПИоТ: сертификат модуля ${oUrl.host} сменился (был ${oSaved.fingerprint}, сейчас ${sSeen}) — запрос не отправлен`);
    return fFinish(new PiotError(
      'Сертификат модуля проверки сменился — запрос не отправлен. Если модуль переустанавливали, '
      + 'подтвердите новый сертификат на странице сервера кассы (вкладка «Маркировка»).',
      oDescribeCertificate(oPeer, 'changed'),
    ));
  });
}

/**
 * Переслать запрос модулю. Возвращает { nStatus, sContentType, aBody,
 * oCertificate } или бросает PiotError (нет связи, сертификат сменился,
 * таймаут). oSignal — касса оборвала запрос.
 */
export function pPiotForward({ sMethod, sPath, aBody, sContentType, sAccept, oSignal, nTimeoutMs = N_TIMEOUT_MS, fLog = () => {} }) {
  const oUrl = new URL(sPiotTarget() + sPath);
  return new Promise((fResolve, fReject) => {
    let oCertificate = null;
    const oReq = httpRequest({
      host: oUrl.hostname.replace(/^\[|\]$/g, ''),
      port: Number(oUrl.port || (oUrl.protocol === 'https:' ? 443 : 80)),
      method: sMethod,
      path: oUrl.pathname + oUrl.search,
      headers: {
        Host: oUrl.host,
        Accept: sAccept || 'application/json',
        ...(sContentType ? { 'Content-Type': sContentType } : {}),
        ...(aBody?.length ? { 'Content-Length': aBody.length } : {}),
      },
      ...(oUrl.protocol === 'https:' ? {
        createConnection: (_oOptions, fOnCreate) => {
          fConnectTls(oUrl, fLog, (oError, oSocket, oCert) => {
            oCertificate = oCert;
            fOnCreate(oError, oSocket);
          });
        },
      } : {}),
      signal: oSignal,
      timeout: nTimeoutMs,
    }, (oRes) => {
      const aChunks = [];
      let nSize = 0;
      oRes.on('data', (aChunk) => {
        nSize += aChunk.length;
        if (nSize > N_MAX_ANSWER) {
          oReq.destroy(new PiotError('Слишком большой ответ модуля'));
          return;
        }
        aChunks.push(aChunk);
      });
      oRes.on('end', () => fResolve({
        nStatus: oRes.statusCode,
        sContentType: oRes.headers['content-type'] || '',
        aBody: Buffer.concat(aChunks),
        oCertificate,
      }));
      oRes.on('error', fReject);
    });
    oReq.on('timeout', () => oReq.destroy(new PiotError('Модуль проверки не ответил вовремя')));
    oReq.on('error', (oError) => {
      if (oError instanceof PiotError || oError.name === 'AbortError') return fReject(oError);
      fReject(new PiotError(`Нет связи с модулем ${oUrl.host}: ${oError.message}`, oCertificate));
    });
    oReq.end(aBody?.length ? aBody : undefined);
  });
}

/** «Проверить связь» на странице агента: сведения о модуле и его сертификат. */
export async function pPiotCheck({ fLog } = {}) {
  const oStatus = oPiotStatus();
  try {
    const oAnswer = await pPiotForward({ sMethod: 'GET', sPath: '/api/v3/info', nTimeoutMs: 10000, fLog });
    let oInfo = null;
    try { oInfo = JSON.parse(oAnswer.aBody.toString('utf8')); } catch { /* не JSON */ }
    return {
      ...oStatus,
      ok: oAnswer.nStatus >= 200 && oAnswer.nStatus < 300 && Boolean(oInfo),
      httpStatus: oAnswer.nStatus,
      info: oInfo,
      certificate: oAnswer.oCertificate,
      fingerprint: oPiotStatus().fingerprint, // мог запомниться только что
    };
  } catch (oError) {
    if (!(oError instanceof PiotError)) throw oError;
    return { ...oStatus, ok: false, error: oError.message, certificate: oError.oCertificate };
  }
}
