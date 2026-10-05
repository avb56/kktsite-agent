// HTTP-сервер агента: API «АТОЛ. Web Requests» под /api/v2.
//
// Что есть (спецификация — openapi.yaml из самого Web Requests 1.0.4.0,
// http://<пк>:16732/docs/openapi.yaml):
//   GET    /api/v2/serverInfo                        (без авторизации, как у Web Requests)
//   GET    /api/v2/utils/mapping, /utils/deviceParametersStruct   (тоже без авторизации)
//   GET|PUT /api/v2/settings                         — общие настройки (settings.js)
//   GET    /api/v2/devices, POST /api/v2/devices
//   GET|PUT|DELETE /api/v2/devices/{id}              ({id} = default — ККТ по умолчанию)
//   POST   /api/v2/setDefaultDevice { id }           — в спецификации нет, но им
//          пользуется страница самого Web Requests; ответы сняты с него
//   POST   /api/v2/activateDevice, /api/v2/deactivateDevice   (?deviceID=)
//   POST   /api/v2/requests                         (?deviceID=)
//   GET|DELETE /api/v2/requests/{uuid}               (?deviceID=)
//   GET    /api/v2/getRequestsQueueStatus            (?deviceID=)
//   POST   /api/v2/operations/query*                 — через JSON-задания драйвера
// ?deviceID выбирает ККТ, без него — ККТ по умолчанию (как в спецификации и
// как было в Веб-сервере ККТ). Касса берёт deviceID из адреса «Атол Сервер»
// (http://<пк>:16732/api/v2/?deviceID=2) и шлёт его с заданием и опросом.
//
// Сверх Web Requests: GET|POST /api/v2/agentHttps и GET /agent.crt — HTTPS
// агента по кнопке (tls.js); GET|POST /api/v2/agentUpdate — версия и
// самообновление (update.js); POST /api/v2/agentRestart — перезапуск службой;
// GET|POST|DELETE /api/v2/agentUsers — учётные записи сервера (users.js).
//
// Страница настроек — GET / (файлы в src/ui), на тех же запросах. Авторизация
// у неё та же, что у API: браузер спросит логин и пароль, если учётки заведены.
//
// Ошибки — как у Web Requests: { error: { code: 505, description } } и
// HTTP-код по смыслу (400, 401, 404, 409).
//
// CORS: касса открыта со страницы https://app.kktsite.ru и ходит на агент по
// http://localhost или адресу в локальной сети. Отвечаем на предварительный
// запрос и для доступа к локальной сети (Access-Control-Allow-Private-Network)
// — Web Requests этого заголовка не шлёт, а старые версии Chrome без него не
// пускают страницу из интернета к локальному адресу.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { AgentError, Device } from './device.js';
import { oDriverInfo } from './driver.js';
import { oMapping } from './mapping.js';
import { oGetSettings, oPutSettings } from './settings.js';
import { aUserNames, bCheckBasic, fAddUser, fDeleteUser } from './users.js';

const N_MAX_BODY = 1024 * 1024;

// Страница настроек: три файла, читаются при запуске. Отдаются только они —
// путь из запроса в файловую систему не попадает.
const O_UI = Object.fromEntries([
  ['/', 'settings.html', 'text/html'],
  ['/settings.js', 'settings.js', 'text/javascript'],
  ['/settings.css', 'settings.css', 'text/css'],
].map(([sPath, sFile, sType]) => [sPath, {
  aBody: readFileSync(new URL(`./ui/${sFile}`, import.meta.url)),
  sType: `${sType}; charset=utf-8`,
}]));

// /operations/query* → JSON-задание драйвера. Ответ — то, что вернул драйвер:
// у Web Requests поля местами другие (он собирает их не JSON-заданием), но
// касса этими путями не пользуется — они для служебных страниц и проверок.
const O_OPERATIONS = {
  queryDeviceStatus: 'getDeviceStatus',
  queryDeviceInfo: 'getDeviceInfo',
  queryShiftStatus: 'getShiftStatus',
  queryShiftTotals: 'getShiftTotals',
  queryFnInfo: 'getFnInfo',
  queryFnStatus: 'getFnStatus',
  queryOfdExchangeStatus: 'ofdExchangeStatus',
  queryIsmExchangeStatus: 'ismExchangeStatus',
  queryLicenses: 'getLicenses',
};

/** Дата-время с часовым поясом ПК, как в serverInfo Web Requests. */
function sLocalDateTime(oDate = new Date()) {
  const nOffset = -oDate.getTimezoneOffset();
  const sSign = nOffset >= 0 ? '+' : '-';
  const fPad = (n) => String(Math.abs(n)).padStart(2, '0');
  const oLocal = new Date(oDate.getTime() + nOffset * 60000);
  return oLocal.toISOString().slice(0, 19) + sSign + fPad(Math.trunc(nOffset / 60)) + ':' + fPad(nOffset % 60);
}

const S_OS = { win32: 'windows', darwin: 'macos' }[process.platform] || process.platform;

function fCors(oReq, oRes) {
  const sOrigin = oReq.headers.origin;
  oRes.setHeader('Access-Control-Allow-Origin', sOrigin || '*');
  if (sOrigin) {
    oRes.setHeader('Access-Control-Allow-Credentials', 'true');
    oRes.setHeader('Vary', 'Origin');
  }
}

function fSend(oRes, nStatus, vBody) {
  const sBody = vBody === undefined ? '' : JSON.stringify(vBody);
  oRes.writeHead(nStatus, sBody ? { 'Content-Type': 'application/json; charset=utf-8' } : {});
  oRes.end(sBody);
}

function fSendError(oRes, nStatus, sDescription) {
  fSend(oRes, nStatus, { error: { code: 505, description: sDescription } });
}

function pReadJson(oReq) {
  return new Promise((fResolve, fReject) => {
    const aChunks = [];
    let nSize = 0;
    oReq.on('data', (aChunk) => {
      nSize += aChunk.length;
      if (nSize > N_MAX_BODY) {
        fReject(new AgentError(413, 'Слишком большой запрос'));
        oReq.destroy();
        return;
      }
      aChunks.push(aChunk);
    });
    oReq.on('end', () => {
      const sText = Buffer.concat(aChunks).toString('utf8');
      if (!sText.trim()) return fResolve({});
      try {
        fResolve(JSON.parse(sText));
      } catch (oError) {
        fReject(new AgentError(400, oError.message));
      }
    });
    oReq.on('error', fReject);
  });
}

/**
 * oOptions: { oRegistry, sVersion, fLog, oHttps, oUpdater, oRestart }. oHttps —
 * контроллер HTTPS из tls.js, oUpdater — самообновление из update.js, oRestart —
 * { bCan, pRestart } перезапуск сервера службой (main.js); все необязательны.
 */
export function oCreateAgentServer({ oRegistry, sVersion, fLog = () => {}, oHttps = null, oUpdater = null, oRestart = null }) {
  async function pRoute(oReq, oRes, oUrl) {
    const sPath = oUrl.pathname.replace(/\/+$/, '');
    const sMethod = oReq.method;
    const sDeviceId = oUrl.searchParams.get('deviceID') || '';

    if (sPath === '/api/v2/serverInfo' && sMethod === 'GET') {
      const oDriver = oDriverInfo();
      return fSend(oRes, 200, {
        serverVersion: sVersion,
        driverVersion: oDriver.version || '',
        os: S_OS,
        currentDateTime: sLocalDateTime(),
        // Сверх полей Web Requests: чем отличается агент и что с драйвером.
        product: 'kktsite-agent',
        driverPath: oDriver.path || '',
        driverError: oDriver.error || '',
        driverWarning: oDriver.warning || '',
        canRestart: Boolean(oRestart?.bCan),
      });
    }

    if (sPath === '/api/v2/utils/mapping' && sMethod === 'GET') return fSend(oRes, 200, oMapping());
    if (sPath === '/api/v2/utils/deviceParametersStruct' && sMethod === 'GET') {
      const { lastError, ...oStruct } = new Device({ id: '' }).oDescribe();
      return fSend(oRes, 200, { ...oStruct, name: '', hasLicense: false });
    }

    if (!bCheckBasic(oReq.headers.authorization)) {
      oRes.setHeader('WWW-Authenticate', 'Basic realm="kktsite-agent", charset="UTF-8"');
      return fSendError(oRes, 401, 'unauthorized');
    }

    const oUi = O_UI[oUrl.pathname];
    if (oUi && sMethod === 'GET') {
      oRes.writeHead(200, {
        'Content-Type': oUi.sType,
        'Cache-Control': 'no-cache',
        // Страница управляет ККТ: не встраивать в чужие страницы, скрипты — только свои.
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      return oRes.end(oUi.aBody);
    }

    // HTTPS агента (tls.js) — своё, у Web Requests такого нет.
    if (oUrl.pathname === '/agent.crt' && sMethod === 'GET' && oHttps) {
      const sPem = oHttps.sCertificatePem();
      if (!sPem) return fSendError(oRes, 404, 'Сертификат ещё не выпущен');
      oRes.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="kktsite-agent.crt"',
      });
      return oRes.end(sPem);
    }
    if (sPath === '/api/v2/agentHttps' && oHttps) {
      if (sMethod === 'GET') return fSend(oRes, 200, oHttps.oStatus());
      if (sMethod === 'POST') {
        const { action } = await pReadJson(oReq);
        if (action === 'issue') {
          try {
            await oHttps.pIssue();
          } catch (oError) {
            throw new AgentError(409, `Сертификат выпущен, но HTTPS не включился: ${oError.message}`);
          }
        } else if (action === 'disable') {
          await oHttps.pDisable();
        } else {
          throw new AgentError(400, "action: 'issue' — выпустить сертификат и включить, 'disable' — выключить");
        }
        return fSend(oRes, 200, oHttps.oStatus());
      }
    }

    // Перезапуск сервера (после обновления драйвера Атола: драйвер загружается
    // при запуске). Ответить сразу, а перезапуститься — когда очереди опустеют;
    // поднимет служба. Без службы перезапускать некому — 409.
    if (sPath === '/api/v2/agentRestart' && sMethod === 'POST') {
      if (!oRestart?.bCan) throw new AgentError(409, 'Сервер запущен не службой — перезапустите его вручную');
      fSend(oRes, 200, {});
      setImmediate(() => oRestart.pRestart().catch((oError) => fLog(`Перезапуск: ${oError.message}`)));
      return undefined;
    }

    // Учётные записи сервера (basic-авторизация, users.js). Первая включает
    // вход, удаление последней — выключает.
    if (sPath === '/api/v2/agentUsers') {
      if (sMethod === 'GET') return fSend(oRes, 200, { users: aUserNames() });
      if (sMethod === 'POST') {
        const { name, password } = await pReadJson(oReq);
        try {
          fAddUser(String(name ?? ''), String(password ?? ''));
        } catch (oError) {
          throw new AgentError(400, oError.message);
        }
        return fSend(oRes, 200, { users: aUserNames() });
      }
      if (sMethod === 'DELETE') {
        try {
          fDeleteUser(oUrl.searchParams.get('name') || '');
        } catch (oError) {
          throw new AgentError(404, oError.message);
        }
        return fSend(oRes, 200, { users: aUserNames() });
      }
    }

    // Версия и самообновление (update.js) — своё, у Web Requests такого нет.
    if (sPath === '/api/v2/agentUpdate' && oUpdater) {
      if (sMethod === 'GET') return fSend(oRes, 200, oUpdater.oStatus());
      if (sMethod === 'POST') {
        const { action, auto } = await pReadJson(oReq);
        try {
          if (action === 'check') await oUpdater.pCheck();
          else if (action === 'install') await oUpdater.pInstall();
          else if (action === 'auto') oUpdater.fSetAuto(auto);
          else throw new AgentError(400, "action: 'check' | 'install' | 'auto' (с auto: true/false)");
        } catch (oError) {
          if (oError instanceof AgentError) throw oError;
          throw new AgentError(409, oError.message);
        }
        return fSend(oRes, 200, oUpdater.oStatus());
      }
    }

    if (sPath === '/api/v2/settings') {
      if (sMethod === 'GET') return fSend(oRes, 200, oGetSettings());
      if (sMethod === 'PUT') {
        oPutSettings(await pReadJson(oReq));
        return fSend(oRes, 200, {});
      }
    }

    if (sPath === '/api/v2/setDefaultDevice' && sMethod === 'POST') {
      oRegistry.fSetDefaultById((await pReadJson(oReq)).id);
      return fSend(oRes, 200, {});
    }

    if (sPath === '/api/v2/devices') {
      if (sMethod === 'GET') return fSend(oRes, 200, oRegistry.aList());
      if (sMethod === 'POST') {
        const oDevice = oRegistry.oAdd(await pReadJson(oReq));
        return fSend(oRes, 201, oDevice.oDescribe());
      }
    }

    const aDevice = /^\/api\/v2\/devices\/([^/]+)$/.exec(sPath);
    if (aDevice) {
      const sId = decodeURIComponent(aDevice[1]);
      if (sMethod === 'GET') return fSend(oRes, 200, oRegistry.oGet(sId).oDescribe());
      if (sMethod === 'PUT') return fSend(oRes, 200, (await oRegistry.pUpdate(sId, await pReadJson(oReq))).oDescribe());
      if (sMethod === 'DELETE') {
        await oRegistry.pDelete(sId);
        return fSend(oRes, 200, {});
      }
    }

    if ((sPath === '/api/v2/activateDevice' || sPath === '/api/v2/deactivateDevice') && sMethod === 'POST') {
      // Идентификатор можно передать и в теле — для совместимости с релизом
      // 10.7.0.0 Web Requests принимает оба варианта.
      const oBody = await pReadJson(oReq);
      const sId = sDeviceId || oBody.deviceID || '';
      await oRegistry.pSetActive(oRegistry.oGet(sId).id, sPath === '/api/v2/activateDevice');
      return fSend(oRes, 200, {});
    }

    if (sPath === '/api/v2/requests' && sMethod === 'POST') {
      const oBody = await pReadJson(oReq);
      return fSend(oRes, 201, oRegistry.oGet(sDeviceId).oAddRequest(oBody.uuid, oBody.request));
    }

    const aRequest = /^\/api\/v2\/requests\/([^/]+)$/.exec(sPath);
    if (aRequest) {
      const sUuid = decodeURIComponent(aRequest[1]);
      const oDevice = oRegistry.oGet(sDeviceId);
      if (sMethod === 'GET') return fSend(oRes, 200, oDevice.oGetRequest(sUuid));
      if (sMethod === 'DELETE') {
        oDevice.fCancelRequest(sUuid);
        return fSend(oRes, 200, {});
      }
    }

    if (sPath === '/api/v2/getRequestsQueueStatus' && sMethod === 'GET') {
      return fSend(oRes, 200, oRegistry.oGet(sDeviceId).oQueueStatus());
    }

    const aOperation = /^\/api\/v2\/operations\/([A-Za-z]+)$/.exec(sPath);
    if (aOperation && sMethod === 'POST') {
      const sTask = O_OPERATIONS[aOperation[1]];
      if (!sTask) return fSendError(oRes, 501, `Операция ${aOperation[1]} агентом пока не поддерживается`);
      await pReadJson(oReq);
      return fSend(oRes, 200, await oRegistry.oGet(sDeviceId).pOperation({ type: sTask }));
    }

    return fSendError(oRes, 404, `Нет такого метода: ${sMethod} ${oUrl.pathname}`);
  }

  return createServer((oReq, oRes) => {
    fCors(oReq, oRes);
    if (oReq.method === 'OPTIONS') {
      oRes.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      oRes.setHeader('Access-Control-Allow-Headers', oReq.headers['access-control-request-headers'] || 'Content-Type, Authorization');
      oRes.setHeader('Access-Control-Max-Age', '600');
      if (oReq.headers['access-control-request-private-network'] === 'true') {
        oRes.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      oRes.writeHead(204);
      return oRes.end();
    }
    const oUrl = new URL(oReq.url, 'http://agent');
    pRoute(oReq, oRes, oUrl).catch((oError) => {
      if (oError instanceof AgentError) return fSendError(oRes, oError.nHttp, oError.message);
      fLog(`Ошибка ${oReq.method} ${oUrl.pathname}: ${oError.stack || oError}`);
      fSendError(oRes, 500, oError.message);
    });
  });
}
