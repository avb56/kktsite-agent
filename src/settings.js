// Общие настройки агента — GET/PUT /api/v2/settings, формат Web Requests
// (GlobalSettings). Хранятся в settings.json каталога данных.
//
// Применяются deleteRequestsAfter (в минутах), blockQueueOnPrintErrors
// (device.js, «Блокировка очереди») и cancelWaitingRequestsAfter — своя
// настройка агента, у Web Requests её нет (device.js, «Срок ожидания»), и
// vendorData и socksServer — тоже свои (core.js, socks.js). Остальные поля принимаются и хранятся,
// чтобы настройки переносились между Web Requests и агентом как есть, но агент
// по ним ещё ничего не делает: задания не проверяются при добавлении
// (validateRequestsOnAdd), скрипты ДТО и доп. строки документа не подключены.

import { AgentError, oQueueOptions } from './device.js';
import { vReadJson, fWriteJson } from './store.js';
import { fSetVendorData } from './core.js';
import { fSetSocksServer } from './socks.js';

const S_FILE = 'settings.json';

const O_DEFAULTS = {
  scriptsPath: '',
  invertCashDrawerStatus: false,
  additionalHeaderLines: '',
  additionalFooterLines: '',
  // У Web Requests по умолчанию false; у агента — true (решение пользователя,
  // 02.10.2026): чек без бумаги допечатывается, следующие ждут.
  blockQueueOnPrintErrors: true,
  deleteRequestsAfter: 43200,
  validateRequestsOnAdd: false,
  // Секунды; 0 — ждущие задания не отменяются (как у Web Requests).
  cancelWaitingRequestsAfter: 120,
  // Своя настройка агента: служебные данные производителю ККТ (Штрих-М
  // Посцентра шлёт состояние и заводской номер в DNS-именах *.kktlab.ru,
  // core.js). По умолчанию — да (решение пользователя, 20.11.2026).
  vendorData: true,
  // Своя настройка агента: SOCKS5-сервер для ККТ на порту 1080 (socks.js), как
  // kktproxy Посцентра. По умолчанию — нет: ККТ выходит в сеть и через стек
  // kkt-core или общий доступ Windows (решение пользователя, 21.11.2026).
  socksServer: false,
};

let oSettings = null;

export function oGetSettings() {
  if (!oSettings) {
    oSettings = { ...O_DEFAULTS, ...vReadJson(S_FILE, {}) };
    fApply(oSettings);
  }
  return oSettings;
}

function fApply(oNew) {
  oQueueOptions.nKeepMinutes = oNew.deleteRequestsAfter;
  oQueueOptions.bBlockOnPrintErrors = oNew.blockQueueOnPrintErrors;
  oQueueOptions.nWaitLimitSec = oNew.cancelWaitingRequestsAfter;
  fSetVendorData(oNew.vendorData);
  fSetSocksServer(oNew.socksServer, { vendorData: oNew.vendorData });
}

/** PUT /settings: меняются только переданные поля; ошибка — как у Web Requests. */
export function oPutSettings(oNew) {
  if (!oNew || typeof oNew !== 'object' || Array.isArray(oNew)) throw new AgentError(400, 'Ожидается объект настроек');
  const oNext = { ...oGetSettings() };
  for (const [sKey, vValue] of Object.entries(oNew)) {
    if (!(sKey in O_DEFAULTS)) continue;
    const bOk = sKey === 'deleteRequestsAfter' || sKey === 'cancelWaitingRequestsAfter'
      ? Number.isInteger(vValue) && vValue >= 0 && vValue <= 4294967295
      : typeof vValue === typeof O_DEFAULTS[sKey];
    if (!bOk) throw new AgentError(400, `Некорректное значение или тип поля '${sKey}' (${typeof vValue})`);
    oNext[sKey] = vValue;
  }
  fWriteJson(S_FILE, oNext);
  oSettings = oNext;
  fApply(oNext);
  return oNext;
}
