// Агент на подложном драйвере: поведение очереди и API сверено с настоящим
// «АТОЛ. Web Requests» 1.0.4.0 (коды, статусы, тексты ошибок — см. device.js).
// С настоящей ККТ агент проверяется руками (README, «Проверка на ККТ»).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sDataDir = mkdtempSync(join(tmpdir(), 'kkt-agent-test-'));
process.env.KKT_AGENT_DATA = sDataDir;

const { fSetDriverFactory } = await import('../src/driver.js');
const { Registry } = await import('../src/registry.js');
const { oCreateAgentServer } = await import('../src/server.js');
const { oDriverSettings, oQueueOptions } = await import('../src/device.js');
const { fAddUser, fDeleteUser } = await import('../src/users.js');
const { oCreateHttpsController } = await import('../src/tls.js');
const https = await import('node:https');

oQueueOptions.nRecoverMs = 20;

// Подложная ККТ для блокировок очереди: счётчик ФД, связь, бумага. Пока
// bScenario выключен, драйвер просто отвечает { echo: тип задачи }.
const oKkt = {
  bScenario: false,
  nFd: 10,
  bOnline: true,
  bPaper: true,
  sSell: 'ok', // ok | lostAfterClose | lostBeforeClose | notPrinted | fail
  aLog: [],
};
const fDriverError = (nCode, sText) => Object.assign(new Error(sText), { code: nCode, description: sText });

function vScenario(oTask) {
  oKkt.aLog.push(oTask.type);
  if (!oKkt.bOnline) throw fDriverError(2, 'Нет связи');
  switch (oTask.type) {
    case 'getFnStatus': return { fnStatus: { fiscalDocumentNumber: oKkt.nFd } };
    case 'getDeviceStatus': return { deviceStatus: { paperPresent: oKkt.bPaper, coverOpened: false } };
    case 'continuePrint':
      if (!oKkt.bPaper) throw fDriverError(44, 'Нет бумаги');
      return {};
    case 'sell':
      switch (oKkt.sSell) {
        case 'lostAfterClose':
          oKkt.nFd += 1;
          oKkt.bOnline = false;
          throw fDriverError(2, 'Нет связи');
        case 'lostBeforeClose':
          oKkt.bOnline = false;
          throw fDriverError(2, 'Нет связи');
        case 'fail': throw fDriverError(501, 'Ошибка парсинга запроса');
        case 'notPrinted':
          oKkt.nFd += 1;
          oKkt.bPaper = false;
          return { fiscalParams: { fiscalDocumentNumber: oKkt.nFd }, warnings: { notPrinted: true } };
        default:
          oKkt.nFd += 1;
          return { fiscalParams: { fiscalDocumentNumber: oKkt.nFd }, warnings: { notPrinted: false } };
      }
    default: return { echo: oTask.type };
  }
}

const aOpened = [];
fSetDriverFactory(() => ({
  fOpen(oSettings) {
    if (oSettings.UsbDevicePath === 'broken') throw fDriverError(2, 'Нет связи');
    aOpened.push(oSettings);
  },
  async pProcess(oTask) {
    await new Promise((f) => setTimeout(f, oTask.nDelay ?? 5));
    if (oKkt.bScenario) return vScenario(oTask);
    if (oTask.type === 'fail') throw fDriverError(501, 'Ошибка парсинга запроса');
    return { echo: oTask.type };
  },
  fClose() {},
}));

let oServer;
let sBase;
let oHttps;
before(async () => {
  oHttps = oCreateHttpsController({ fHandler: (q, r) => oServer.emit('request', q, r), nPort: 0, sHost: '127.0.0.1' });
  oServer = oCreateAgentServer({ oRegistry: new Registry(), sVersion: 'test', oHttps });
  await new Promise((f) => oServer.listen(0, '127.0.0.1', f));
  sBase = `http://127.0.0.1:${oServer.address().port}/api/v2`;
});
after(() => {
  oServer.close();
  oHttps.close();
  rmSync(sDataDir, { recursive: true, force: true });
});

const pCall = async (sMethod, sPath, vBody, oHeaders = {}) => {
  const oRes = await fetch(sBase + sPath, {
    method: sMethod,
    headers: { 'Content-Type': 'application/json', ...oHeaders },
    body: vBody === undefined ? undefined : typeof vBody === 'string' ? vBody : JSON.stringify(vBody),
  });
  const sText = await oRes.text();
  return { nStatus: oRes.status, oBody: sText ? JSON.parse(sText) : null, oRes };
};

async function pWaitDone(sUuid) {
  for (let n = 0; n < 200; n += 1) {
    const { oBody } = await pCall('GET', `/requests/${sUuid}`);
    if (!oBody.results.some((o) => o.status === 'wait' || o.status === 'inProgress')) return oBody.results;
    await new Promise((f) => setTimeout(f, 10));
  }
  throw new Error('задание не выполнилось');
}

test('настройки Web Requests → настройки драйвера', () => {
  assert.deepEqual(oDriverSettings({ port: 'usb', usbDevice: 'auto', model: 500 }),
    { Model: 500, Port: 1, AccessPassword: '', UserPassword: '', UsbDevicePath: 'auto' });
  assert.equal(oDriverSettings({ port: 'tcp', ipAddress: '10.0.0.5', ipPort: 5555, ofdChannel: 'auto' }).Port, 2);
  assert.equal(oDriverSettings({ port: 'tcp', ipAddress: '10.0.0.5' }).IPAddress, '10.0.0.5');
  assert.equal(oDriverSettings({ port: 'tcpip', ipAddress: '10.0.0.5' }).Port, 2, 'старое имя tcpip ещё понимается');
  assert.equal(oDriverSettings({ port: 'com', com: '/dev/ttyACM0', baudRate: 115200 }).ComFile, '/dev/ttyACM0');
  assert.throws(() => oDriverSettings({ port: 'pigeon' }), /Неизвестный тип подключения/);
});

test('serverInfo и ККТ по умолчанию', async () => {
  const { nStatus, oBody } = await pCall('GET', '/serverInfo');
  assert.equal(nStatus, 200);
  assert.equal(oBody.product, 'kktsite-agent');
  assert.match(oBody.currentDateTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);

  const oNoDevice = await pCall('POST', '/requests', { uuid: 'u0', request: [{ type: 'x' }] });
  assert.equal(oNoDevice.nStatus, 404);
  assert.equal(oNoDevice.oBody.error.description, 'Устройство по умолчанию не задано');

  const oAdded = await pCall('POST', '/devices', { name: 'Atol30', connectionSettings: { port: 'usb', usbDevice: 'auto', model: 500 } });
  assert.equal(oAdded.nStatus, 201);
  assert.equal(oAdded.oBody.id, '1');
  assert.equal(oAdded.oBody.isDefault, true, 'первая ККТ — по умолчанию');
  assert.equal(oAdded.oBody.isActive, false);
});

test('до подключения задание не принимается', async () => {
  const { nStatus, oBody } = await pCall('POST', '/requests', { uuid: 'u1', request: [{ type: 'getDeviceStatus' }] });
  assert.equal(nStatus, 409);
  assert.match(oBody.error.description, /не подключена/);
});

test('очередь: 201, результат, повтор uuid, неизвестный uuid', async () => {
  assert.equal((await pCall('POST', '/activateDevice?deviceID=1')).nStatus, 200);
  // Недостающие настройки — по умолчанию Web Requests: ОФД auto → канал 2.
  assert.deepEqual(aOpened.at(-1), { Model: 500, Port: 1, AccessPassword: '', UserPassword: '', OfdChannel: 2, UsbDevicePath: 'auto' });

  const oAdd = await pCall('POST', '/requests', { uuid: 'u2', request: [{ type: 'getDeviceStatus' }, { type: 'getShiftStatus' }] });
  assert.equal(oAdd.nStatus, 201);
  assert.deepEqual(Object.keys(oAdd.oBody).sort(), ['blockReason', 'blockedUUID', 'isBlocked', 'number', 'uuid']);

  const aResults = await pWaitDone('u2');
  assert.deepEqual(aResults.map((o) => o.status), ['ready', 'ready']);
  assert.deepEqual(aResults[0], { error: { code: 0, description: 'Ошибок нет' }, status: 'ready', result: { echo: 'getDeviceStatus' } });

  const oDup = await pCall('POST', '/requests', { uuid: 'u2', request: [{ type: 'x' }] });
  assert.equal(oDup.nStatus, 409);
  assert.match(oDup.oBody.error.description, /задание с таким UUID уже есть/);

  const oUnknown = await pCall('GET', '/requests/nope');
  assert.equal(oUnknown.nStatus, 404);
  assert.equal(oUnknown.oBody.error.description, 'Задание с UUID [nope] для устройства [1] не найдено');
});

test('ошибка задачи прерывает остальные', async () => {
  await pCall('POST', '/requests', { uuid: 'u3', request: [{ type: 'a' }, { type: 'fail' }, { type: 'b' }] });
  const aResults = await pWaitDone('u3');
  assert.deepEqual(aResults.map((o) => o.status), ['ready', 'error', 'interrupted']);
  assert.deepEqual(aResults[1].error, { code: 501, description: 'Ошибка парсинга запроса' });
  assert.deepEqual(aResults[2].error, { code: 502, description: 'Выполнение прервано из-за предыдущих ошибок' });
});

test('отмена: ждущее — можно, выполненное — 409', async () => {
  await pCall('POST', '/requests', { uuid: 'slow', request: [{ type: 'a', nDelay: 150 }] });
  await pCall('POST', '/requests', { uuid: 'queued', request: [{ type: 'b' }] });
  assert.equal((await pCall('DELETE', '/requests/queued')).nStatus, 200);
  assert.deepEqual((await pCall('GET', '/requests/queued')).oBody.results.map((o) => o.status), ['canceled']);
  await pWaitDone('slow');
  const oLate = await pCall('DELETE', '/requests/slow');
  assert.equal(oLate.nStatus, 409);
  const { oBody } = await pCall('GET', '/getRequestsQueueStatus');
  assert.equal(oBody.number, 0);
  assert.equal(oBody.canceled, 1);
  assert.ok(oBody.ready >= 3);
});

test('кривой запрос — 400, как у Web Requests', async () => {
  assert.equal((await pCall('POST', '/requests', { uuid: 'u4' })).oBody.error.description, "Поле 'request' не задано или пустое");
  assert.equal((await pCall('POST', '/requests', '{oops')).nStatus, 400);
});

test('операции — через JSON-задания, неизвестные — 501', async () => {
  assert.deepEqual((await pCall('POST', '/operations/queryShiftStatus')).oBody, { echo: 'getShiftStatus' });
  assert.equal((await pCall('POST', '/operations/queryReceiptTotals')).nStatus, 501);
});

test('CORS и доступ к локальной сети', async () => {
  const oRes = await fetch(`${sBase}/requests`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.kktsite.ru',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(oRes.status, 204);
  assert.equal(oRes.headers.get('access-control-allow-origin'), 'https://app.kktsite.ru');
  assert.equal(oRes.headers.get('access-control-allow-private-network'), 'true');
  assert.match(oRes.headers.get('access-control-allow-headers'), /authorization/);
});

test('авторизация включается первой учёткой', async () => {
  fAddUser('test', 'testTest1234');
  try {
    assert.equal((await pCall('GET', '/devices')).nStatus, 401);
    assert.equal((await pCall('GET', '/serverInfo')).nStatus, 200, 'serverInfo — без авторизации');
    const sAuth = 'Basic ' + Buffer.from('test:testTest1234').toString('base64');
    assert.equal((await pCall('GET', '/devices', undefined, { Authorization: sAuth })).nStatus, 200);
    const sWrong = 'Basic ' + Buffer.from('test:wrong').toString('base64');
    assert.equal((await pCall('GET', '/devices', undefined, { Authorization: sWrong })).nStatus, 401);
  } finally {
    fDeleteUser('test');
  }
});

test('ККТ не подключилась — причина видна, задания не принимаются', async () => {
  const { oBody } = await pCall('POST', '/devices', { name: 'Broken', connectionSettings: { port: 'usb', usbDevice: 'broken' } });
  const oAct = await pCall('POST', `/activateDevice?deviceID=${oBody.id}`);
  assert.equal(oAct.nStatus, 409);
  assert.match(oAct.oBody.error.description, /Нет связи/);
  assert.equal((await pCall('GET', `/devices/${oBody.id}`)).oBody.lastError, 'Нет связи');
});

test('?deviceID выбирает ККТ, без него — ККТ по умолчанию', async () => {
  const oToDefault = await pCall('POST', '/requests', { uuid: 'd0', request: [{ type: 'a' }] });
  assert.equal(oToDefault.nStatus, 201, 'ККТ 1 по умолчанию подключена');
  const oToSecond = await pCall('POST', '/requests?deviceID=2', { uuid: 'd2', request: [{ type: 'a' }] });
  assert.equal(oToSecond.nStatus, 409);
  assert.match(oToSecond.oBody.error.description, /ККТ \[2\] не подключена/);
  const oToMissing = await pCall('POST', '/requests?deviceID=77', { uuid: 'd77', request: [{ type: 'a' }] });
  assert.equal(oToMissing.nStatus, 404);
  assert.equal(oToMissing.oBody.error.description, 'Устройство с ID [77] не найдено');
  await pWaitDone('d0');
  assert.equal((await pCall('GET', '/requests/d0?deviceID=1')).nStatus, 200);
  assert.equal((await pCall('GET', '/requests/d0?deviceID=2')).nStatus, 404, 'задание живёт в очереди своей ККТ');
});

test('ККТ для кассы: setDefaultDevice и devices/default, как у Web Requests', async () => {
  assert.equal((await pCall('GET', '/devices/default')).oBody.id, '1');
  assert.equal((await pCall('POST', '/setDefaultDevice', { id: '2' })).nStatus, 200);
  const { oBody: aList } = await pCall('GET', '/devices');
  assert.deepEqual(aList.map((o) => [o.id, o.isDefault]), [['1', false], ['2', true]]);
  assert.equal((await pCall('GET', '/devices/default')).oBody.id, '2');
  const oMissing = await pCall('POST', '/setDefaultDevice', {});
  assert.equal(oMissing.nStatus, 404);
  assert.equal(oMissing.oBody.error.description, 'Устройство с ID [] не найдено');
  await pCall('POST', '/setDefaultDevice', { id: '1' });
});

test('описание ККТ — поля Web Requests', async () => {
  const { oBody } = await pCall('GET', '/devices/1');
  assert.deepEqual(Object.keys(oBody).sort(),
    ['connectionSettings', 'hasLicense', 'id', 'isActive', 'isDefault', 'isLock', 'lastError', 'name', 'otherSettings']);
  assert.equal(oBody.otherSettings.useGlobalScriptsSettings, true);
  const { oBody: oStruct } = await pCall('GET', '/utils/deviceParametersStruct');
  assert.equal(oStruct.id, '');
  assert.equal(oStruct.connectionSettings.port, 'usb');
  assert.equal(oStruct.lastError, undefined);
});

test('правка ККТ: имя — без переподключения, неизвестный канал — 400, id не меняется', async () => {
  const nOpened = aOpened.length;
  const oPut = await pCall('PUT', '/devices/1', { id: '1', name: 'Касса у входа', connectionSettings: { port: 'usb', usbDevice: 'auto' } });
  assert.equal(oPut.nStatus, 200);
  assert.equal(oPut.oBody.name, 'Касса у входа');
  assert.equal(oPut.oBody.isActive, true);
  assert.equal(aOpened.length, nOpened, 'настройки связи те же — ККТ не переподключалась');

  const oBad = await pCall('PUT', '/devices/1', { connectionSettings: { port: 'pigeon' } });
  assert.equal(oBad.nStatus, 400);
  assert.equal((await pCall('GET', '/devices/1')).oBody.isActive, true, 'после ошибки ККТ осталась подключённой');

  assert.equal((await pCall('POST', '/devices', { id: 'bad id!', name: 'x' })).nStatus, 400);
});

test('справочник значений и общие настройки', async () => {
  const { oBody: oMap } = await pCall('GET', '/utils/mapping');
  assert.deepEqual(oMap.port.map((o) => o.key), ['com', 'usb', 'tcp', 'bluetooth']);
  assert.equal(oMap.model[0].key, '500');
  assert.equal(oMap.usbDevice[0].key, 'auto');
  assert.deepEqual(oMap.ofdChannel.map((o) => o.key), ['none', 'auto']);

  assert.equal((await pCall('GET', '/settings')).oBody.deleteRequestsAfter, 43200);
  const oBad = await pCall('PUT', '/settings', { deleteRequestsAfter: 'abc' });
  assert.equal(oBad.nStatus, 400);
  assert.equal(oBad.oBody.error.description, "Некорректное значение или тип поля 'deleteRequestsAfter' (string)");
  assert.equal((await pCall('PUT', '/settings', { deleteRequestsAfter: 60 })).nStatus, 200);
  assert.equal((await pCall('GET', '/settings')).oBody.deleteRequestsAfter, 60);
  await pCall('PUT', '/settings', { deleteRequestsAfter: 43200 });
});

test('страница настроек: отдаётся, закрыта вместе с API', async () => {
  const oPage = await fetch(sBase.replace('/api/v2', '/'));
  assert.equal(oPage.status, 200);
  assert.match(oPage.headers.get('content-type'), /text\/html/);
  assert.match(oPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await oPage.text(), /settings\.js/);
  assert.equal((await fetch(sBase.replace('/api/v2', '/settings.js'))).status, 200);
  assert.equal((await fetch(sBase.replace('/api/v2', '/package.json'))).status, 404);

  fAddUser('test', 'testTest1234');
  try {
    const oClosed = await fetch(sBase.replace('/api/v2', '/'));
    assert.equal(oClosed.status, 401);
    assert.match(oClosed.headers.get('www-authenticate'), /^Basic/);
    assert.equal((await pCall('GET', '/utils/mapping')).nStatus, 200, 'справочник — без авторизации, как у Web Requests');
  } finally {
    fDeleteUser('test');
  }
});

async function pUntil(fCheck, sWhat) {
  for (let n = 0; n < 300; n += 1) {
    if (await fCheck()) return;
    await new Promise((f) => setTimeout(f, 10));
  }
  throw new Error(`не дождались: ${sWhat}`);
}
const pQueue = async () => (await pCall('GET', '/getRequestsQueueStatus')).oBody;
const aStatuses = async (sUuid) => (await pCall('GET', `/requests/${sUuid}`)).oBody.results.map((o) => o.status);

test('блокировка: связь оборвалась, документ закрылся — ready, очередь идёт дальше', async (t) => {
  Object.assign(oKkt, { bScenario: true, bOnline: true, bPaper: true, sSell: 'lostAfterClose', aLog: [] });
  t.after(() => { oKkt.bScenario = false; });
  const nFdBefore = oKkt.nFd;
  await pCall('POST', '/requests', { uuid: 'b1', request: [{ type: 'sell' }, { type: 'reportX' }] });
  await pUntil(async () => (await pQueue()).isBlocked, 'блокировки');

  const oQueue = await pQueue();
  assert.equal(oQueue.blockReason, 'connectionError');
  assert.equal(oQueue.blockedUUID, 'b1');
  assert.deepEqual(await aStatuses('b1'), ['blocked', 'wait']);
  assert.equal((await pCall('GET', '/devices/1')).oBody.isLock, true);

  // Новое задание принимается, но ждёт: сначала надо узнать исход чека.
  const oNext = await pCall('POST', '/requests', { uuid: 'b2', request: [{ type: 'getShiftStatus' }] });
  assert.equal(oNext.nStatus, 201);
  assert.equal(oNext.oBody.isBlocked, true);
  assert.deepEqual(await aStatuses('b2'), ['wait']);

  oKkt.bOnline = true;
  await pUntil(async () => !(await pQueue()).isBlocked, 'снятия блокировки');
  await pWaitDone('b2');
  const aResults = (await pCall('GET', '/requests/b1')).oBody.results;
  assert.deepEqual(aResults.map((o) => o.status), ['ready', 'ready']);
  assert.equal(aResults[0].result.fiscalParams.fiscalDocumentNumber, nFdBefore + 1);
  assert.equal(aResults[0].result.warnings.notPrinted, false, 'допечатан');
  assert.ok(oKkt.aLog.includes('continuePrint'));
  assert.equal(oKkt.aLog.filter((s) => s === 'sell').length, 1, 'чек не пробит второй раз');
});

test('блокировка: связь оборвалась до закрытия — error, остальное прервано', async (t) => {
  Object.assign(oKkt, { bScenario: true, bOnline: true, bPaper: true, sSell: 'lostBeforeClose', aLog: [] });
  t.after(() => { oKkt.bScenario = false; });
  await pCall('POST', '/requests', { uuid: 'c1', request: [{ type: 'sell' }, { type: 'reportX' }] });
  await pUntil(async () => (await pQueue()).isBlocked, 'блокировки');
  oKkt.bOnline = true;
  await pWaitDone('c1');
  const aResults = (await pCall('GET', '/requests/c1')).oBody.results;
  assert.deepEqual(aResults.map((o) => o.status), ['error', 'interrupted']);
  assert.deepEqual(aResults[0].error, { code: 2, description: 'Нет связи' });
  assert.equal((await pQueue()).isBlocked, false);
});

test('без блокировки: не фискальная задача и не «сбойная» ошибка', async (t) => {
  Object.assign(oKkt, { bScenario: true, bOnline: true, bPaper: true, sSell: 'fail', aLog: [] });
  t.after(() => { oKkt.bScenario = false; oKkt.bOnline = true; });
  await pCall('POST', '/requests', { uuid: 'd1', request: [{ type: 'sell' }] });
  assert.deepEqual((await pWaitDone('d1')).map((o) => o.status), ['error']);

  oKkt.bOnline = false;
  await pCall('POST', '/requests', { uuid: 'd2', request: [{ type: 'reportX' }] });
  assert.deepEqual((await pWaitDone('d2')).map((o) => o.status), ['error'], 'X-отчёт без связи — просто ошибка');
  assert.equal((await pQueue()).isBlocked, false);
});

test('блокировка по бумаге: только с blockQueueOnPrintErrors', async (t) => {
  Object.assign(oKkt, { bScenario: true, bOnline: true, bPaper: true, sSell: 'notPrinted', aLog: [] });
  t.after(async () => {
    oKkt.bScenario = false;
    await pCall('PUT', '/settings', { blockQueueOnPrintErrors: true });
  });

  assert.equal((await pCall('GET', '/settings')).oBody.blockQueueOnPrintErrors, true, 'по умолчанию включено');
  await pCall('PUT', '/settings', { blockQueueOnPrintErrors: false });
  await pCall('POST', '/requests', { uuid: 'p1', request: [{ type: 'sell' }] });
  assert.deepEqual((await pWaitDone('p1')).map((o) => o.status), ['ready'], 'выключено — не блокирует');
  assert.equal((await pQueue()).isBlocked, false);

  await pCall('PUT', '/settings', { blockQueueOnPrintErrors: true });
  oKkt.bPaper = true;
  await pCall('POST', '/requests', { uuid: 'p2', request: [{ type: 'sell' }, { type: 'reportX' }] });
  await pUntil(async () => (await pQueue()).isBlocked, 'блокировки по бумаге');
  assert.equal((await pQueue()).blockReason, 'paperError');
  assert.deepEqual(await aStatuses('p2'), ['ready', 'wait'], 'чек закрыт, дальше ждём бумагу');

  oKkt.bPaper = true;
  await pUntil(async () => !(await pQueue()).isBlocked, 'бумаги');
  assert.deepEqual((await pWaitDone('p2')).map((o) => o.status), ['ready', 'ready']);
  assert.ok(oKkt.aLog.includes('continuePrint'));
});

function pHttpsGet(nPort, sCa, sPath = '/api/v2/serverInfo') {
  return new Promise((fResolve, fReject) => {
    // agent: false — каждое обращение новым соединением: иначе keep-alive
    // вернул бы открытое соединение со старым сертификатом.
    https.get({ host: '127.0.0.1', port: nPort, path: sPath, ca: sCa, agent: false }, (oRes) => {
      let sBody = '';
      oRes.on('data', (s) => { sBody += s; });
      oRes.on('end', () => fResolve({ nStatus: oRes.statusCode, sBody }));
    }).on('error', fReject);
  });
}

test('HTTPS: выключен, пока не выпустят сертификат кнопкой', async () => {
  const { oBody } = await pCall('GET', '/agentHttps');
  assert.equal(oBody.enabled, false);
  assert.equal(oBody.listening, false);
  assert.equal(oBody.certificate, null);
  assert.equal((await fetch(sBase.replace('/api/v2', '/agent.crt'))).status, 404);
  assert.equal((await pCall('POST', '/agentHttps', { action: 'pigeon' })).nStatus, 400);
});

test('HTTPS: выпуск, запросы по https, перевыпуск на лету, выключение, восстановление', async () => {
  const oIssued = await pCall('POST', '/agentHttps', { action: 'issue' });
  assert.equal(oIssued.nStatus, 200);
  assert.equal(oIssued.oBody.enabled, true);
  assert.equal(oIssued.oBody.listening, true);
  assert.ok(oIssued.oBody.certificate.names.includes('127.0.0.1'));
  assert.equal(oIssued.oBody.problem, '');
  const nPort = oIssued.oBody.port;

  const oCrt = await fetch(sBase.replace('/api/v2', '/agent.crt'));
  assert.equal(oCrt.status, 200);
  assert.match(oCrt.headers.get('content-disposition'), /kktsite-agent\.crt/);
  const sCa = await oCrt.text();
  assert.match(sCa, /^-----BEGIN CERTIFICATE-----/);
  // Сведения пишутся при выпуске (без X509Certificate — его нет в Node 12): сверить с ним.
  const oX509 = new (await import('node:crypto')).X509Certificate(sCa);
  assert.equal(oIssued.oBody.certificate.fingerprint, oX509.fingerprint256);
  assert.equal(oIssued.oBody.certificate.validTo, new Date(oX509.validTo).toISOString());

  const oFirst = await pHttpsGet(nPort, sCa);
  assert.equal(oFirst.nStatus, 200);
  assert.equal(JSON.parse(oFirst.sBody).product, 'kktsite-agent', 'по https — тот же агент');

  // Перевыпуск: слушатель тот же, сертификат новый — старому больше не верят.
  const oRenewed = await pCall('POST', '/agentHttps', { action: 'issue' });
  assert.notEqual(oRenewed.oBody.certificate.fingerprint, oIssued.oBody.certificate.fingerprint);
  assert.equal(oRenewed.oBody.port, nPort);
  await assert.rejects(pHttpsGet(nPort, sCa), /self[- ]signed|unable to verify|certificate/i);
  const sNewCa = await (await fetch(sBase.replace('/api/v2', '/agent.crt'))).text();
  assert.equal((await pHttpsGet(nPort, sNewCa)).nStatus, 200);

  const oOff = await pCall('POST', '/agentHttps', { action: 'disable' });
  assert.equal(oOff.oBody.enabled, false);
  assert.equal(oOff.oBody.listening, false);
  assert.ok(oOff.oBody.certificate, 'сертификат остаётся — доверять заново не придётся');
  await assert.rejects(pHttpsGet(nPort, sNewCa), /ECONNREFUSED/);

  // Включили снова и «перезапустили агент»: новый контроллер слушает сам, с тем же сертификатом.
  await pCall('POST', '/agentHttps', { action: 'issue' });
  const sCaNow = await (await fetch(sBase.replace('/api/v2', '/agent.crt'))).text();
  oHttps.close();
  const oRestarted = oCreateHttpsController({ fHandler: (q, r) => oServer.emit('request', q, r), nPort: 0, sHost: '127.0.0.1' });
  await oRestarted.pRestore();
  try {
    assert.equal(oRestarted.oStatus().listening, true);
    assert.equal((await pHttpsGet(oRestarted.nPort, sCaNow)).nStatus, 200);
  } finally {
    oRestarted.close();
  }
});

test('учётки сервера со страницы: первая включает вход, удаление последней — выключает', async () => {
  assert.deepEqual((await pCall('GET', '/agentUsers')).oBody, { users: [] });
  assert.equal((await pCall('POST', '/agentUsers', { name: 'bad name!', password: 'x' })).nStatus, 400);
  const oAdded = await pCall('POST', '/agentUsers', { name: 'kassa', password: 'kassaPass123' });
  assert.deepEqual(oAdded.oBody, { users: ['kassa'] });
  assert.equal((await pCall('GET', '/devices')).nStatus, 401, 'вход включился');
  const oAuth = { Authorization: 'Basic ' + Buffer.from('kassa:kassaPass123').toString('base64') };
  assert.equal((await pCall('GET', '/devices', undefined, oAuth)).nStatus, 200);
  // Сменить пароль — тот же POST.
  await pCall('POST', '/agentUsers', { name: 'kassa', password: 'newPass12345' }, oAuth);
  assert.equal((await pCall('GET', '/devices', undefined, oAuth)).nStatus, 401, 'старый пароль больше не подходит');
  const oNewAuth = { Authorization: 'Basic ' + Buffer.from('kassa:newPass12345').toString('base64') };
  assert.equal((await pCall('DELETE', '/agentUsers?name=nobody', undefined, oNewAuth)).nStatus, 404);
  assert.deepEqual((await pCall('DELETE', '/agentUsers?name=kassa', undefined, oNewAuth)).oBody, { users: [] });
  assert.equal((await pCall('GET', '/devices')).nStatus, 200, 'учёток нет — снова открыт');
});

test('перезапуск сервера: без службы — 409, под службой — ответ сразу, перезапуск после', async () => {
  assert.equal((await pCall('GET', '/serverInfo')).oBody.canRestart, false);
  const oNo = await pCall('POST', '/agentRestart');
  assert.equal(oNo.nStatus, 409);
  assert.match(oNo.oBody.error.description, /не службой/);

  let nRestarts = 0;
  const oSvc = oCreateAgentServer({ oRegistry: new Registry(), sVersion: 'test', oRestart: { bCan: true, pRestart: async () => { nRestarts += 1; } } });
  await new Promise((f) => oSvc.listen(0, '127.0.0.1', f));
  try {
    const sSvc = `http://127.0.0.1:${oSvc.address().port}/api/v2`;
    assert.equal((await (await fetch(`${sSvc}/serverInfo`)).json()).canRestart, true);
    assert.equal((await fetch(`${sSvc}/agentRestart`, { method: 'POST' })).status, 200);
    await new Promise((f) => setTimeout(f, 20));
    assert.equal(nRestarts, 1);
  } finally {
    oSvc.close();
  }
});

test('после перезапуска подключённая ККТ подключается снова', async () => {
  const oRegistry = new Registry();
  assert.equal(oRegistry.oGet('1').oHandle, null);
  await oRegistry.pRestore(() => {});
  assert.ok(oRegistry.oGet('1').oHandle, 'ККТ 1 была подключена — подключилась снова');
  assert.equal(oRegistry.oGet('2').oHandle, null, 'ККТ 2 не подключалась — так и осталась');
});
