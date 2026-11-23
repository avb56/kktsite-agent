// Журнал агента — на сервер kktsite (POST /api/log), туда же, куда пишет
// касса: по времени и владельцу записи агента сводятся с записями кассы.
//
// Что уходит: предупреждения и ошибки — всегда (решение пользователя,
// 23.11.2026: иначе мы о них не узнаем), обычные записи — только при
// отладочном журнале (debug.js). Пишет агент ключом лицензии владельца
// («Authorization: License lic_…», как к серверу политик): входа в учётку у
// него нет. Ключа нет — записи ждут его в очереди.
//
// Очередь — в памяти и в файле каталога данных (переживает перезапуск и
// отсутствие сети), не больше N_MAX записей: лишние старые вытесняются, а
// сколько вытеснено, уходит на сервер (dropped). Отправка — пачками.
// Персональные данные (почта, телефон, ИНН физлица и кассира в тексте) —
// «[ПД]» до постановки в очередь (sMaskPdText).
// Сбой отправки в журнал агента не пишется через fLog: запись о сбое снова
// ушла бы в эту очередь.

import { randomUUID } from 'node:crypto';
import { bDebugOn } from './debug.js';
import { vReadJson, fWriteJson } from './store.js';
import { pHttpFetch } from './http-fetch.js';

const S_FILE = 'remote-log.json';
const N_MAX = 2000;
const N_BATCH = 200;
const N_FLUSH_MS = 10e3;
const N_RETRY_MS = 60e3;
const N_TXT_MAX = 500;

// Персональные данные — из записей вон до отправки: в тексте ошибок бывают
// ИНН кассира, почта и телефон покупателя (содержимое заданий агент не пишет).
// Копия sMaskPdText из kktsite apps/web/lib/log-mask.mjs (там тесты);
// сервер маскирует и сам.
const S_PD = '[ПД]';
const rEMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const rPHONE = /(?<![\d.])(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?![\d.])/g;
const rINN12 = /(?<![\d.:/-])\d{12}(?![\d.:/-])/g;
const rINN_PERSON = /(ИНН\s+(?:кассира|покупателя|клиента)\D{0,5})\d+/gi;

/** Персональные данные в тексте: почта, телефон, ИНН физлица. */
export function sMaskPdText(s) {
  if (typeof s !== "string") return s;
  return s.replace(rEMAIL, (sMail, nAt, sAll) => (sAll[nAt - 1] === ":" || /\/\/[^\s]*$/.test(sAll.slice(0, nAt)) ? sMail : S_PD))
    .replace(rINN_PERSON, `$1${S_PD}`).replace(rPHONE, S_PD).replace(rINN12, S_PD);
}

let oState = null; // { aQueue, nDropped, sDid }
let oOptions = { fAccess: () => ({}), sVersion: '', fFetch: null };
const sSid = randomUUID();
let nSeq = 0;
let oTimer = null;
let bSending = false;

function oLoad() {
  if (oState) return oState;
  let oSaved = {};
  try { oSaved = vReadJson(S_FILE, {}) || {}; } catch { /* испорчен — начнём заново */ }
  oState = {
    aQueue: Array.isArray(oSaved.aQueue) ? oSaved.aQueue.slice(-N_MAX) : [],
    nDropped: Number(oSaved.nDropped) || 0,
    sDid: typeof oSaved.sDid === 'string' && oSaved.sDid ? oSaved.sDid : randomUUID(),
  };
  return oState;
}

function fSave() {
  try { fWriteJson(S_FILE, oState); } catch { /* нет доступа — останется в памяти */ }
}

/** Адрес приёма журнала — у того же сервера, что и политики (…/api/policy/lease → …/api/log). */
export function sLogUrl(sPolicyUrl) {
  try { return new URL('/api/log', sPolicyUrl).href; } catch { return ''; }
}

/**
 * oNew: { fAccess: () => ({ license, policyUrl }), sVersion, fFetch? }.
 * Вызывается при запуске (main.js); до него записи только копятся.
 */
export function fConfigureRemoteLog(oNew = {}) {
  oOptions = { ...oOptions, ...oNew };
  oLoad();
  if (oState.aQueue.length) fSchedule(1000);
}

/** Запись журнала агента: sLvl — info | warn | error. */
export function fRemoteLog(sLvl, sText) {
  if (sLvl !== 'warn' && sLvl !== 'error' && !bDebugOn()) return;
  oLoad();
  oState.aQueue.push({
    ts: Date.now(), lvl: sLvl === 'warn' || sLvl === 'error' ? sLvl : 'info',
    txt: sMaskPdText(String(sText)).slice(0, N_TXT_MAX), seq: ++nSeq, sid: sSid, did: oState.sDid, ver: `agent-${oOptions.sVersion || 'dev'}`,
  });
  if (oState.aQueue.length > N_MAX) {
    oState.nDropped += oState.aQueue.length - N_MAX;
    oState.aQueue.splice(0, oState.aQueue.length - N_MAX);
  }
  fSchedule(N_FLUSH_MS);
}

function fSchedule(nMs) {
  if (oTimer) return;
  oTimer = setTimeout(() => { oTimer = null; pFlush(); }, nMs);
  oTimer.unref?.();
}

/** Отправить очередь; true — пусто или всё ушло. Для тестов — экспорт. */
export async function pFlush() {
  oLoad();
  if (bSending || !oState.aQueue.length) return !oState.aQueue.length;
  const { license, policyUrl } = oOptions.fAccess() || {};
  const sUrl = sLogUrl(policyUrl);
  if (!license || !sUrl) { fSave(); return false; } // ключа нет — ждём его (касса передаст)
  bSending = true;
  try {
    while (oState.aQueue.length) {
      const aBatch = oState.aQueue.slice(0, N_BATCH);
      const fFetch = oOptions.fFetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch : pHttpFetch);
      let nStatus = 0;
      try {
        const oRes = await fFetch(sUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `License ${license}` },
          body: JSON.stringify({ entries: aBatch, dropped: oState.nDropped }),
        });
        nStatus = oRes.status;
      } catch { /* нет сети */ }
      // 413 — пачку сервер не примет никогда: выбрасываем, иначе застряла бы.
      if ((nStatus >= 200 && nStatus < 300) || nStatus === 413) {
        oState.aQueue.splice(0, aBatch.length);
        oState.nDropped = 0;
        continue;
      }
      fSave();
      fSchedule(N_RETRY_MS);
      return false;
    }
    fSave();
    return true;
  } finally {
    bSending = false;
  }
}

/** Для тестов: сбросить состояние модуля. */
export function fResetRemoteLog() {
  oState = null;
  nSeq = 0;
  if (oTimer) clearTimeout(oTimer);
  oTimer = null;
}
