// Связь с модулем ТС ПИоТ через агента (src/piot.js): сквозной путь /piot/*,
// адрес модуля и доверие к его сертификату при первом подключении. Модуль —
// подложный https-сервер с самоподписанным сертификатом, как у настоящего.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

const sDataDir = mkdtempSync(join(tmpdir(), 'kkt-agent-piot-'));
process.env.KKT_AGENT_DATA = sDataDir;

const { Registry } = await import('../src/registry.js');
const { oCreateAgentServer } = await import('../src/server.js');
const { oIssueCertificate } = await import('../src/tls.js');
const { fAddUser, fDeleteUser } = await import('../src/users.js');

const fIssue = () => oIssueCertificate({ aDns: ['localhost'], aIps: ['127.0.0.1'] });

// Подложный модуль: запоминает, что пришло, и отвечает по пути.
const aSeen = [];
let nNextStatus = 200;
function fModule(oReq, oRes) {
  const aChunks = [];
  oReq.on('data', (a) => aChunks.push(a));
  oReq.on('end', () => {
    aSeen.push({ sMethod: oReq.method, sUrl: oReq.url, oHeaders: oReq.headers, sBody: Buffer.concat(aChunks).toString('utf8') });
    if (oReq.url === '/api/v3/info') {
      oRes.writeHead(200, { 'Content-Type': 'application/json' });
      return oRes.end(JSON.stringify({ tspiotId: 'piot-1', kktSerial: '00106100000001', kktInn: '7700000000', codesCheckTimeout: '1500', lm: { status: 'ready' } }));
    }
    oRes.writeHead(nNextStatus, { 'Content-Type': 'application/json;charset=UTF-8' });
    oRes.end(JSON.stringify({ code: 0, codesResponse: [{ code: 0, codes: [{ found: true }] }], echo: aChunks.length }));
  });
}

let oCert = fIssue();
let oModule;
let sModuleUrl;
let oServer;
let sBase;
const aLog = [];

before(async () => {
  oModule = createHttpsServer({ key: oCert.sKeyPem, cert: oCert.sCertPem }, fModule);
  await new Promise((f) => oModule.listen(0, '127.0.0.1', f));
  sModuleUrl = `https://127.0.0.1:${oModule.address().port}`;
  oServer = oCreateAgentServer({ oRegistry: new Registry(), sVersion: 'test', fLog: (s) => aLog.push(s) });
  await new Promise((f) => oServer.listen(0, '127.0.0.1', f));
  sBase = `http://127.0.0.1:${oServer.address().port}`;
});
after(() => {
  oServer.close();
  oModule.close();
  rmSync(sDataDir, { recursive: true, force: true });
});

async function pCall(sMethod, sPath, vBody, oHeaders = {}) {
  const oRes = await fetch(sBase + sPath, {
    method: sMethod,
    headers: { ...(vBody === undefined ? {} : { 'Content-Type': 'application/json' }), ...oHeaders },
    body: vBody === undefined ? undefined : (typeof vBody === 'string' ? vBody : JSON.stringify(vBody)),
  });
  const sText = await oRes.text();
  let oBody = null;
  try { oBody = sText ? JSON.parse(sText) : null; } catch { oBody = sText; }
  return { nStatus: oRes.status, oBody, oHeaders: oRes.headers };
}

test('адрес модуля по умолчанию — имя этого ПК и порт 51401', async () => {
  const { nStatus, oBody } = await pCall('GET', '/api/v2/agentPiot');
  assert.equal(nStatus, 200);
  assert.equal(oBody.url, '');
  assert.equal(oBody.target, `https://${hostname().toLowerCase()}:51401`);
  assert.equal(oBody.fingerprint, null);
});

test('адрес модуля — только схема, имя и порт', async () => {
  for (const sUrl of ['ftp://pc:51401', 'https://pc:51401/api/v3', 'https://a:b@pc:51401', 'не адрес']) {
    const { nStatus } = await pCall('PUT', '/api/v2/agentPiot', { url: sUrl });
    assert.equal(nStatus, 400, sUrl);
  }
});

test('первое подключение: сертификат запоминается, сведения о модуле приходят', async () => {
  const { oBody: oPut } = await pCall('PUT', '/api/v2/agentPiot', { url: sModuleUrl + '/' });
  assert.equal(oPut.url, sModuleUrl);
  assert.equal(oPut.target, sModuleUrl);
  const { nStatus, oBody } = await pCall('POST', '/api/v2/agentPiot', { action: 'check' });
  assert.equal(nStatus, 200);
  assert.equal(oBody.ok, true);
  assert.equal(oBody.info.tspiotId, 'piot-1');
  assert.equal(oBody.certificate.trust, 'first');
  assert.equal(oBody.certificate.fingerprint, oCert.oInfo.sFingerprint);
  assert.equal(oBody.fingerprint, oCert.oInfo.sFingerprint);
});

test('/piot/* — запрос и ответ модуля как есть, без учётки агента', async () => {
  fAddUser('kassa', 'password1');
  try {
    const sBody = JSON.stringify({ codes: [{ cis: 'MDEw', pg: 3 }], client_info: { name: 'kktsite' } });
    const sAuth = 'Basic ' + Buffer.from('kassa:password1').toString('base64');
    const { nStatus: nNoAuth } = await pCall('POST', '/piot/api/v3/codes/check', sBody);
    assert.equal(nNoAuth, 401, 'учётки заведены — без логина нельзя');

    aSeen.length = 0;
    const { nStatus, oBody, oHeaders } = await pCall('POST', '/piot/api/v3/codes/check?x=1', sBody, { Authorization: sAuth });
    assert.equal(nStatus, 200);
    assert.equal(oHeaders.get('content-type'), 'application/json;charset=UTF-8');
    assert.equal(oBody.codesResponse[0].codes[0].found, true);
    assert.equal(aSeen.length, 1);
    assert.equal(aSeen[0].sUrl, '/api/v3/codes/check?x=1');
    assert.equal(aSeen[0].sBody, sBody);
    assert.equal(aSeen[0].oHeaders['content-type'], 'application/json');
    assert.equal(aSeen[0].oHeaders.authorization, undefined, 'логин агента модулю не уходит');
    // Коды в журнал не попадают.
    assert.ok(aLog.some((s) => s.startsWith('ПИоТ: POST /api/v3/codes/check → 200')));
    assert.ok(!aLog.some((s) => s.includes('MDEw')));
  } finally {
    fDeleteUser('kassa');
  }
});

test('код ответа модуля доходит до кассы: 203 — аварийный режим', async () => {
  nNextStatus = 203;
  try {
    const { nStatus } = await pCall('POST', '/piot/api/v3/codes/check', { codes: [] });
    assert.equal(nStatus, 203);
  } finally {
    nNextStatus = 200;
  }
});

test('ответ браузеру — с CORS, на предзапрос — с Private Network', async () => {
  const oPre = await fetch(sBase + '/piot/api/v3/codes/check', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.kktsite.ru',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(oPre.status, 204);
  assert.equal(oPre.headers.get('access-control-allow-headers'), 'content-type,authorization');
  assert.equal(oPre.headers.get('access-control-allow-private-network'), 'true');
  const { oHeaders } = await pCall('GET', '/piot/api/v3/info', undefined, { Origin: 'https://app.kktsite.ru' });
  assert.equal(oHeaders.get('access-control-allow-origin'), 'https://app.kktsite.ru');
});

test('сертификат сменился — запрос к модулю не уходит, пока новый не подтвердят', async () => {
  const oOld = oCert;
  oCert = fIssue();
  oModule.setSecureContext({ key: oCert.sKeyPem, cert: oCert.sCertPem });

  aSeen.length = 0;
  const { nStatus, oBody } = await pCall('POST', '/piot/api/v3/codes/check', { codes: [] });
  assert.equal(nStatus, 502);
  assert.match(oBody.error.description, /Сертификат модуля проверки сменился/);
  assert.equal(aSeen.length, 0, 'модуль запроса не получил');

  const { oBody: oCheck } = await pCall('POST', '/api/v2/agentPiot', { action: 'check' });
  assert.equal(oCheck.ok, false);
  assert.equal(oCheck.certificate.trust, 'changed');
  assert.equal(oCheck.certificate.fingerprint, oCert.oInfo.sFingerprint);
  assert.equal(oCheck.fingerprint, oOld.oInfo.sFingerprint);

  const { nStatus: nWrong } = await pCall('POST', '/api/v2/agentPiot', { action: 'trust', fingerprint: oOld.oInfo.sFingerprint });
  assert.equal(nWrong, 409, 'подтвердить можно только увиденный');
  const { nStatus: nTrust, oBody: oTrusted } = await pCall('POST', '/api/v2/agentPiot', { action: 'trust', fingerprint: oCert.oInfo.sFingerprint });
  assert.equal(nTrust, 200);
  assert.equal(oTrusted.fingerprint, oCert.oInfo.sFingerprint);

  const { nStatus: nAfter } = await pCall('POST', '/piot/api/v3/codes/check', { codes: [] });
  assert.equal(nAfter, 200);
  assert.equal(aSeen.length, 1);
});

test('модуль не отвечает — 502 с причиной в формате ошибок агента', async () => {
  const oDead = createHttpServer();
  await new Promise((f) => oDead.listen(0, '127.0.0.1', f));
  const nPort = oDead.address().port;
  await new Promise((f) => oDead.close(f));
  await pCall('PUT', '/api/v2/agentPiot', { url: `https://127.0.0.1:${nPort}` });
  const { nStatus, oBody } = await pCall('POST', '/piot/api/v3/codes/check', { codes: [] });
  assert.equal(nStatus, 502);
  assert.match(oBody.error.description, /Нет связи с модулем/);
  const { oBody: oStatus } = await pCall('GET', '/api/v2/agentPiot');
  assert.equal(oStatus.fingerprint, null, 'новый адрес — старый отпечаток забыт');
});

test('http-адрес (стенд: piot-proxy) — без TLS', async () => {
  const oPlain = createHttpServer(fModule);
  await new Promise((f) => oPlain.listen(0, '127.0.0.1', f));
  try {
    await pCall('PUT', '/api/v2/agentPiot', { url: `http://127.0.0.1:${oPlain.address().port}` });
    const { oBody } = await pCall('POST', '/api/v2/agentPiot', { action: 'check' });
    assert.equal(oBody.ok, true);
    assert.equal(oBody.certificate, null);
  } finally {
    oPlain.close();
  }
});
