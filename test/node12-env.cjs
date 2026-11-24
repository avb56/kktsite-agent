// Среда Node 12 поверх нового Node — для кода агента (src/), который на
// Windows 7 едет под Node 12 (scripts/pack.mjs --bundle-node12). esbuild с
// target node12 переписывает только синтаксис, а глобальные функции и новые
// методы оставляет как есть: в Node 12 их нет, и код падает или молча работает
// не так (0.3.16: AbortController в /piot — любой запрос к модулю падал с 500).
// Копия kkt-core test/node12-env.cjs, только «свой» код — src/ агента.
//
//   node --require ./test/node12-env.cjs --test     (npm run test:node12)
//
// То, чего нет в Node 12.22, — геттер: читает код агента — undefined, как в
// Node 12 (typeof … === 'undefined', вызов — «is not a function»); читают тесты
// или сам Node — настоящее.
'use strict';

const S_SRC = require('path').join(__dirname, '..', 'src') + require('path').sep;
const S_SRC_URL = require('url').pathToFileURL(S_SRC).href;
const fFromLib = () => {
  // [0] Error, [1] fFromLib, [2] геттер, [3] кто читает.
  const sCaller = String(new Error().stack).split('\n')[3] || '';
  return sCaller.includes(S_SRC) || sCaller.includes(S_SRC_URL);
};

function fHide(oOwner, sKey) {
  const oDesc = Object.getOwnPropertyDescriptor(oOwner, sKey);
  if (!oDesc || !oDesc.configurable) return;
  let vValue = oDesc.get ? undefined : oDesc.value;
  const fGet = oDesc.get ? () => oDesc.get.call(oOwner) : () => vValue;
  Object.defineProperty(oOwner, sKey, {
    configurable: true,
    enumerable: oDesc.enumerable,
    get() { return fFromLib() ? undefined : (oDesc.get ? oDesc.get.call(this) : vValue); },
    set(v) { if (oDesc.set) oDesc.set.call(this, v); else vValue = v; },
  });
  return fGet;
}

// Глобальные функции, классы и объекты Node 13+ (fetch — ниже: в Node 12 его
// агент берёт свой — src/http-fetch.js). crypto: в Node 12 globalThis.crypto нет.
for (const s of ['atob', 'btoa', 'AbortController', 'AbortSignal', 'structuredClone', 'Headers', 'Request', 'Response',
  'FormData', 'Blob', 'BroadcastChannel', 'MessageChannel', 'EventTarget', 'Event', 'WebSocket', 'crypto', 'performance',
  'navigator']) fHide(globalThis, s);
// Новые методы.
for (const [oOwner, aKeys] of [
  [Array.prototype, ['at', 'findLast', 'findLastIndex', 'toSorted', 'toReversed', 'toSpliced', 'with']],
  [String.prototype, ['at', 'replaceAll']],
  [Object, ['hasOwn']],
  [Promise, ['any']],
  [require('crypto'), ['randomUUID', 'webcrypto', 'subtle']],
]) for (const s of aKeys) fHide(oOwner, s);

// fetch в Node 12 нет: код агента должен проверять typeof и брать свой
// (src/http-fetch.js). Здесь коду агента fetch не виден.
void [globalThis.Headers, globalThis.Response]; // undici — загрузить сейчас: при загрузке он читает Blob, AbortSignal…
fHide(globalThis, 'fetch');
