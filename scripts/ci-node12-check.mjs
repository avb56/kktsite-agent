// Сборка для Windows 7 — под настоящим Node 12 (.github/workflows/agent.yml):
//
//   node scripts/pack.mjs --bundle-node12 --node-binary <node 12> --out dist12
//   node scripts/ci-node12-check.mjs dist12/stage/kktsite-agent-<версия>-<платформа>
//
// Запускает агент из собранного каталога его же node (12), как служба на
// кассе, и проверяет: поднялся и отвечает; список ККТ; /piot — сквозной путь к
// модулю (подставной модуль здесь же) и 502, когда модуль молчит. В журнале
// агента не должно быть TypeError / ReferenceError — так Node 12 сообщает о
// том, чего в нём нет (0.3.16: AbortController — /piot падал с 500).
// Драйверов и ККТ в CI нет — это проверка сервера, не печати.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sStage = process.argv[2];
if (!sStage) throw new Error('Каталог сборки: node scripts/ci-node12-check.mjs dist12/stage/<имя>');
const sNode = join(sStage, 'node', readdirSync(join(sStage, 'node')).find((s) => /^node(\.exe)?$/.test(s)));
const nPort = 16790;
const sBase = `http://127.0.0.1:${nPort}`;
const pSleep = (nMs) => new Promise((f) => setTimeout(f, nMs));
const sData = mkdtempSync(join(tmpdir(), 'kktsite-agent-n12-'));

// Подставной модуль ПИоТ: отвечает на проверку кодов как ТС ПИоТ.
const aSeen = [];
const oPiot = createServer((oReq, oRes) => {
  let sBody = '';
  oReq.on('data', (s) => { sBody += s; });
  oReq.on('end', () => {
    aSeen.push({ sMethod: oReq.method, sUrl: oReq.url, sBody });
    oRes.writeHead(200, { 'Content-Type': 'application/json' });
    oRes.end(JSON.stringify({ codesResponse: [{ codes: [{ cis: 'проверка', valid: true }] }] }));
  });
});
await new Promise((f) => oPiot.listen(0, '127.0.0.1', f));
const nPiotPort = oPiot.address().port;

let sLog = '';
const oAgent = spawn(sNode, [join(sStage, 'app', 'src', 'main.js')], {
  env: { ...process.env, KKT_AGENT_PORT: String(nPort), KKT_AGENT_HOST: '127.0.0.1', KKT_AGENT_DATA: sData },
});
oAgent.stdout.on('data', (s) => { sLog += s; });
oAgent.stderr.on('data', (s) => { sLog += s; });

const aFails = [];
const fCheck = (bOk, sWhat) => { console.log(`${bOk ? 'ок ' : 'НЕТ'}  ${sWhat}`); if (!bOk) aFails.push(sWhat); };

async function pJson(sPath, oInit) {
  const oRes = await fetch(sBase + sPath, { ...oInit, signal: AbortSignal.timeout(10_000) });
  const sText = await oRes.text();
  let vBody = null;
  try { vBody = JSON.parse(sText); } catch { vBody = sText; }
  return { nStatus: oRes.status, vBody };
}

try {
  let oInfo = null;
  for (let n = 0; n < 60 && !oInfo; n += 1) {
    await pSleep(500);
    if (oAgent.exitCode != null) break;
    oInfo = await pJson('/api/v2/serverInfo').then((o) => (o.nStatus === 200 ? o.vBody : null), () => null);
  }
  fCheck(Boolean(oInfo), `агент под Node 12 отвечает (${oInfo?.serverVersion ?? 'нет ответа'})`);
  if (!oInfo) throw new Error('агент не поднялся');

  const oDevices = await pJson('/api/v2/devices');
  fCheck(oDevices.nStatus === 200 && Array.isArray(oDevices.vBody), `список ККТ (${oDevices.nStatus})`);

  const oPut = await pJson('/api/v2/agentPiot', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `http://127.0.0.1:${nPiotPort}` }) });
  fCheck(oPut.nStatus === 200, `адрес модуля ПИоТ (${oPut.nStatus})`);

  const sCheck = JSON.stringify({ codes: ['MDEwNDY='], client_info: { name: 'ci' } });
  const oFwd = await pJson('/piot/api/v3/codes/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sCheck });
  fCheck(oFwd.nStatus === 200 && oFwd.vBody?.codesResponse?.[0]?.codes?.[0]?.valid === true, `/piot → модуль и ответ обратно (${oFwd.nStatus})`);
  fCheck(aSeen.some((o) => o.sMethod === 'POST' && o.sUrl === '/api/v3/codes/check' && o.sBody === sCheck), 'модуль получил запрос как есть');

  await new Promise((f) => oPiot.close(f));
  const oDead = await pJson('/piot/api/v3/codes/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sCheck });
  fCheck(oDead.nStatus === 502, `модуль молчит — 502 (${oDead.nStatus})`);
} catch (oErr) {
  fCheck(false, oErr.message);
} finally {
  oAgent.kill();
  await pSleep(500);
  oPiot.close();
  rmSync(sData, { recursive: true, force: true });
}

fCheck(!/\b(TypeError|ReferenceError)\b/.test(sLog), 'в журнале агента нет TypeError / ReferenceError');
console.log('--- журнал агента ---\n' + sLog.trim());
if (aFails.length) {
  console.error(`\nНе прошло: ${aFails.join('; ')}`);
  process.exit(1);
}
