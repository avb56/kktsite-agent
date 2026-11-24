import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pHttpFetch } from '../src/http-fetch.js';

test('pHttpFetch: POST с телом, JSON-ответ, статус, переадресация 307 с телом', async () => {
  const oServer = createServer((oReq, oRes) => {
    const aChunks = [];
    oReq.on('data', (o) => aChunks.push(o));
    oReq.on('end', () => {
      if (oReq.url === '/old') { oRes.writeHead(307, { Location: '/lease' }); return oRes.end(); }
      if (oReq.url === '/bad') { oRes.writeHead(503); return oRes.end('нет'); }
      oRes.writeHead(200, { 'Content-Type': 'application/json' });
      oRes.end(JSON.stringify({ method: oReq.method, type: oReq.headers['content-type'], body: Buffer.concat(aChunks).toString('utf8') }));
    });
  });
  await new Promise((f) => oServer.listen(0, '127.0.0.1', f));
  const sBase = `http://127.0.0.1:${oServer.address().port}`;
  try {
    const oRes = await pHttpFetch(sBase + '/old', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"журнал":1}' });
    assert.equal(oRes.ok, true);
    assert.equal(oRes.status, 200);
    assert.equal(oRes.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(await oRes.json(), { method: 'POST', type: 'application/json', body: '{"журнал":1}' });
    const oBad = await pHttpFetch(sBase + '/bad');
    assert.equal(oBad.ok, false);
    assert.equal(oBad.status, 503);
    assert.equal(await oBad.text(), 'нет');
    // Сбой сети — как у fetch: по «fetch failed» kkt-core пишет «Сервер не отвечает».
    await assert.rejects(pHttpFetch('http://127.0.0.1:1/'), (e) => e instanceof TypeError && e.message === 'fetch failed' && e.cause.code === 'ECONNREFUSED');
  } finally {
    oServer.close();
  }
});
