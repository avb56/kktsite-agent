// fetch для kkt-core там, где его нет: Node 12 (сборка для Windows 7).
// kkt-core в агенте обращается через fetch только к серверу политик (POST
// журнала → разрешение, src/policy/policy.js); ОФД и имена — своими функциями
// агента (core.js). Поэтому здесь только то, чем пользуется kkt-core: method,
// headers, body (строка или байты) → { ok, status, statusText, headers.get,
// text(), json() }. Переадресации — как у fetch (до 5, 303 — GET без тела).

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const N_TIMEOUT_MS = 60_000;

export function pHttpFetch(vUrl, { method = 'GET', headers = {}, body } = {}, nRedirects = 5) {
  return new Promise((fResolve, fReject) => {
    const oUrl = new URL(String(vUrl));
    const fRequest = oUrl.protocol === 'https:' ? httpsRequest : oUrl.protocol === 'http:' ? httpRequest : null;
    if (!fRequest) return fReject(new TypeError(`fetch: адрес не http(s): ${oUrl.href}`));
    const oBody = body == null ? null : typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    const oHeaders = { ...headers };
    if (oBody) oHeaders['Content-Length'] = oBody.length;
    const oReq = fRequest(oUrl, { method, headers: oHeaders, timeout: N_TIMEOUT_MS }, (oRes) => {
      const nStatus = oRes.statusCode;
      if ([301, 302, 303, 307, 308].includes(nStatus) && oRes.headers.location && nRedirects > 0) {
        oRes.resume();
        const sNext = new URL(oRes.headers.location, oUrl).href;
        const bKeep = nStatus === 307 || nStatus === 308;
        fResolve(pHttpFetch(sNext, bKeep ? { method, headers, body } : { method: method === 'HEAD' ? 'HEAD' : 'GET', headers }, nRedirects - 1));
        return;
      }
      const aChunks = [];
      oRes.on('data', (oChunk) => aChunks.push(oChunk));
      oRes.on('error', fReject);
      oRes.on('end', () => {
        const sText = Buffer.concat(aChunks).toString('utf8');
        fResolve({
          ok: nStatus >= 200 && nStatus < 300,
          status: nStatus,
          statusText: oRes.statusMessage || '',
          url: oUrl.href,
          headers: { get: (sName) => { const v = oRes.headers[String(sName).toLowerCase()]; return v == null ? null : [].concat(v).join(', '); } },
          text: async () => sText,
          json: async () => JSON.parse(sText),
        });
      });
    });
    oReq.on('timeout', () => oReq.destroy(new Error(`${oUrl.origin}: нет ответа ${N_TIMEOUT_MS / 1000} с`)));
    oReq.on('error', fReject);
    oReq.end(oBody ?? undefined);
  });
}
