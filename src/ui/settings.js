// Страница настроек агента. Работает только через API /api/v2 — те же
// запросы, что у страницы самого «АТОЛ. Web Requests» (devices, setDefaultDevice,
// activate/deactivateDevice, utils/mapping, settings), поэтому всё, что
// делается здесь, можно сделать и curl-ом.

const S_API = '/api/v2/';
const N_REFRESH_MS = 3000;

const $ = (sId) => document.getElementById(sId);

let oMapping = null;
let aDevices = [];
const mChecks = new Map(); // id → результат «Проверить связь»: переживает перерисовку списка
const sBusy = new Set(); // id ККТ, по которым идёт запрос: кнопки неактивны
const mModes = new Map(); // id Штриха-М → режим USB ({ usb, ppp, socks }) или { sError }
const sSwitching = new Set(); // id ККТ, у которых меняется режим
let aPorts = []; // COM-порты ПК с распознанными ККТ (agentPorts)
const bCore = (vModel) => vModel === 'shtrih';
// Модели на странице — две: Атол (драйвер сам узнаёт модель) и Штрих-М. Полный
// список Web Requests остаётся в API (utils/mapping) и для уже сохранённых ККТ.
const A_UI_MODELS = [{ key: '500', description: 'Атол' }, { key: 'shtrih', description: 'Штрих-М' }];
const sModelName = (vModel) => A_UI_MODELS.find((o) => o.key === String(vModel))?.description ?? sDescribe('model', vModel);
const mSwitchStart = new Map(); // id → { nAt, nSec } — начало смены связи и ожидаемая длительность

async function pApi(sMethod, sPath, vBody) {
  let oRes;
  try {
    oRes = await fetch(S_API + sPath, {
      method: sMethod,
      headers: vBody === undefined ? {} : { 'Content-Type': 'application/json' },
      body: vBody === undefined ? undefined : JSON.stringify(vBody),
    });
  } catch {
    throw new Error('Сервер кассы не отвечает');
  }
  const sText = await oRes.text();
  let vData = null;
  try { vData = sText ? JSON.parse(sText) : null; } catch { /* не JSON — ниже по коду ответа */ }
  if (!oRes.ok) throw new Error(vData?.error?.description || `Ошибка ${oRes.status}`);
  return vData;
}

// Уведомления — как в приложении кассы (oNotify из apps/app/src/App.jsx: Toolpad
// useNotifications): по одному, остальные ждут в очереди (счётчик в углу), 5 с, крестик;
// пока мышь над уведомлением — не исчезает.
const N_NOTIFY_MS = 5e3;
const O_NOTIFY_ICONS = {
  success: 'M20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4C12.76,4 13.5,4.11 14.2, 4.31L15.77,2.74C14.61,2.26 13.34,2 12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0, 0 22,12M7.91,10.08L6.5,11.5L11,16L21,6L19.59,4.58L11,13.17L7.91,10.08Z',
  warning: 'M12 5.99L19.53 19H4.47L12 5.99M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z',
  error: 'M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
  info: 'M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20, 12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10, 10 0 0,0 12,2M11,17H13V11H11V17Z',
};
const S_CLOSE_ICON = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
const aNotifyQueue = [];
let nNotifyTimer = 0;
let nNotifyLeft = 0;
let nNotifyStarted = 0;

const sSvg = (sPath) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${sPath}"/></svg>`;

function fNotifyShow(sText, sSeverity) {
  aNotifyQueue.push({ sText, sSeverity });
  if (aNotifyQueue.length === 1) fNotifyRender();
  else fNotifyBadge();
}

function fNotifyBadge() {
  const oBadge = $('notify').querySelector('.notify-badge');
  if (oBadge) {
    oBadge.textContent = String(aNotifyQueue.length);
    oBadge.hidden = aNotifyQueue.length < 2;
  }
}

function fNotifyRender() {
  const oBox = $('notify');
  const { sText, sSeverity } = aNotifyQueue[0];
  oBox.innerHTML = `<div class="notify-alert ${sSeverity}">
    <div class="notify-icon">${sSvg(O_NOTIFY_ICONS[sSeverity])}</div>
    <div class="notify-text"></div>
    <div class="notify-action"><button type="button" class="notify-close" title="Закрыть" aria-label="Закрыть">${sSvg(S_CLOSE_ICON)}</button></div>
  </div><span class="notify-badge" hidden></span>`;
  oBox.querySelector('.notify-text').textContent = sText;
  oBox.querySelector('.notify-close').addEventListener('click', fNotifyClose);
  fNotifyBadge();
  oBox.classList.remove('leaving');
  oBox.classList.add('away');
  oBox.hidden = false;
  oBox.getBoundingClientRect(); // чтобы выезд начался из-за края
  oBox.classList.remove('away');
  nNotifyLeft = N_NOTIFY_MS;
  fNotifyResume();
}

function fNotifyResume() {
  clearTimeout(nNotifyTimer);
  nNotifyStarted = Date.now();
  nNotifyTimer = setTimeout(fNotifyClose, nNotifyLeft);
}

function fNotifyPause() {
  clearTimeout(nNotifyTimer);
  nNotifyLeft = Math.max(nNotifyLeft - (Date.now() - nNotifyStarted), 1000);
}

function fNotifyClose() {
  const oBox = $('notify');
  if (!aNotifyQueue.length || oBox.classList.contains('leaving')) return;
  clearTimeout(nNotifyTimer);
  oBox.classList.add('leaving', 'away');
  setTimeout(() => {
    aNotifyQueue.shift();
    if (aNotifyQueue.length) fNotifyRender();
    else oBox.hidden = true;
  }, 195);
}

const oNotify = {
  info(sText) { fNotifyShow(sText, 'info'); },
  success(sText) { fNotifyShow(sText, 'success'); },
  warning(sText) { fNotifyShow(sText, 'warning'); },
  error(sText) { fNotifyShow(sText, 'error'); },
};

const sDescribe = (sField, vKey) =>
  oMapping?.[sField]?.find((o) => o.key === String(vKey))?.description ?? String(vKey ?? '');

function sConnectionSummary(oConn) {
  const aParts = [sModelName(oConn.model)];
  switch (oConn.port) {
    case 'usb': aParts.push(oConn.usbDevice && oConn.usbDevice !== 'auto' ? `USB ${oConn.usbDevice}` : 'USB, автоматически'); break;
    case 'com': aParts.push(bCore(oConn.model) ? (oConn.com || 'COM ?') : `${oConn.com || 'COM ?'}, ${oConn.baudRate} бод`); break;
    case 'tcp':
    case 'tcpip': aParts.push(`TCP/IP ${oConn.ipAddress || '?'}:${oConn.ipPort || 5555}`); break;
    case 'bluetooth': aParts.push(`Bluetooth ${oConn.mac || '?'}`); break;
    default: aParts.push(oConn.port);
  }
  if (!bCore(oConn.model)) aParts.push(`ОФД: ${oConn.ofdChannel === 'none' ? 'нет' : 'через кассу'}`);
  return aParts.join(' · ');
}

// ——— шапка и драйвер ———

async function pLoadServerInfo() {
  const oInfo = await pApi('GET', 'serverInfo');
  const aLine = [`kktsite-agent ${oInfo.serverVersion}`];
  aLine.push(oInfo.driverVersion ? `драйвер ДТО ${oInfo.driverVersion}` : 'драйвер ДТО не загружен');
  aLine.push(oInfo.os);
  $('server-line').textContent = aLine.join(' · ');

  const oAlerts = $('driver-alerts');
  oAlerts.replaceChildren();
  const fAlert = (sClass, sText) => {
    const oDiv = document.createElement('div');
    oDiv.className = `alert ${sClass}`;
    oDiv.textContent = sText;
    oAlerts.append(oDiv);
    return oDiv;
  };
  if (oInfo.driverError) {
    const oDiv = fAlert('err', `Драйвер ДТО 10 не загружен — ККТ не подключить. ${oInfo.driverError} `);
    // Поставили или обновили драйвер — он подхватится только перезапуском сервера.
    if (oInfo.canRestart) {
      const oButton = document.createElement('button');
      oButton.type = 'button';
      oButton.textContent = 'Драйвер поставлен — перезапустить сервер';
      oButton.addEventListener('click', () => pRestart(oButton));
      oDiv.append(oButton);
    }
  }
  if (oInfo.driverWarning) fAlert('warn', oInfo.driverWarning);
  // Скрывается вложенный блок, а не раздел: hidden разделов — у вкладок.
  $('restart-panel').hidden = !oInfo.canRestart;
  $('restart-none').hidden = Boolean(oInfo.canRestart);
}

// ——— перезапуск сервера ———

/** Дождаться, пока сервер снова ответит, и перечитать страницу. */
function fReloadWhenBack() {
  setTimeout(function fWait() {
    pApi('GET', 'serverInfo').then(() => location.reload(), () => setTimeout(fWait, 2000));
  }, 4000);
}

async function pRestart(oButton) {
  if (!await pConfirm('Перезапустить сервер? Он дождётся, пока очереди ККТ опустеют; несколько секунд касса не сможет печатать.', 'Перезапустить')) return;
  oButton.disabled = true;
  try {
    await pApi('POST', 'agentRestart');
    oNotify.info('Сервер перезапускается — страница обновится сама');
    fReloadWhenBack();
  } catch (oError) {
    oButton.disabled = false;
    oNotify.error(oError.message);
  }
}

// ——— учётные записи сервера ———

function fRenderUsers(aUsers) {
  $('users-state').textContent = aUsers.length
    ? 'Вход по логину и паролю включён.'
    : 'Учётных записей нет — вход выключен, сервер открыт всем в локальной сети.';
  $('users-list').replaceChildren(...aUsers.map((sName) => {
    const oLi = document.createElement('li');
    const oName = document.createElement('b');
    oName.textContent = sName;
    const oDel = document.createElement('button');
    oDel.type = 'button';
    oDel.className = 'danger-text';
    oDel.textContent = 'Удалить';
    oDel.addEventListener('click', () => pDeleteUser(sName, aUsers.length === 1));
    oLi.append(oName, ' ', oDel);
    return oLi;
  }));
}

async function pLoadUsers() {
  fRenderUsers((await pApi('GET', 'agentUsers')).users);
}

async function pSaveUser(oEvent) {
  oEvent.preventDefault();
  const oForm = $('users-form');
  if (!oForm.reportValidity()) return;
  const sName = oForm.elements.name.value.trim();
  const bFirst = !$('users-list').children.length;
  try {
    const { users: aUsers } = await pApi('POST', 'agentUsers', { name: sName, password: oForm.elements.password.value });
    oForm.reset();
    fRenderUsers(aUsers);
    if (bFirst) {
      // Вход только что включился: браузер спросит логин при следующем запросе.
      oNotify.success(`Учётная запись ${sName} создана, вход включён. В кассе адрес — http://${sName}:пароль@…`);
      setTimeout(() => location.reload(), 2500);
    } else {
      oNotify.success(`Учётная запись ${sName} сохранена`);
    }
  } catch (oError) {
    oNotify.error(oError.message);
  }
}

async function pDeleteUser(sName, bLast) {
  const sText = bLast
    ? `Удалить ${sName}? Это последняя учётная запись — вход выключится, сервер будет открыт всем в локальной сети.`
    : `Удалить учётную запись ${sName}? Касса с этим логином перестанет печатать.`;
  if (!await pConfirm(sText)) return;
  try {
    fRenderUsers((await pApi('DELETE', `agentUsers?name=${encodeURIComponent(sName)}`)).users);
    oNotify.success(`Учётная запись ${sName} удалена`);
  } catch (oError) {
    oNotify.error(oError.message);
  }
}

// ——— список ККТ ———

async function pRefreshDevices() {
  aDevices = await pApi('GET', 'devices');
  // Сколько заданий ждёт — только у подключённых: у остальных очередь стоит.
  await Promise.all(aDevices.filter((o) => o.isActive).map(async (oDevice) => {
    try {
      oDevice.oQueue = await pApi('GET', `getRequestsQueueStatus?deviceID=${encodeURIComponent(oDevice.id)}`);
    } catch { /* не критично — просто не покажем */ }
    // Режим USB Штриха-М — один раз, потом после переключения: запрос идёт к ККТ.
    if (bCore(oDevice.connectionSettings.model) && !mModes.has(oDevice.id) && !sSwitching.has(oDevice.id)) {
      try {
        mModes.set(oDevice.id, await pApi('GET', `agentShtrihMode?deviceID=${encodeURIComponent(oDevice.id)}`));
      } catch (oError) {
        mModes.set(oDevice.id, { sError: oError.message });
      }
    }
  }));
  for (const oDevice of aDevices) if (!oDevice.isActive && !sSwitching.has(oDevice.id)) mModes.delete(oDevice.id);
  fRenderDevices();
}

const O_BLOCK_REASONS = {
  connectionError: 'пропала связь с ККТ во время фискального документа — пока неизвестно, пробит ли он',
  fnError: 'сбой ФН во время фискального документа — пока неизвестно, пробит ли он',
  paperError: 'нет бумаги или открыта крышка — документ допечатается, когда бумагу вставят',
};

function fRenderDevices() {
  const oList = $('devices');
  const oTemplate = $('device-item');
  $('devices-empty').hidden = aDevices.length > 0;
  oList.replaceChildren(...aDevices.map((oDevice) => {
    const oItem = oTemplate.content.firstElementChild.cloneNode(true);
    const q = (s) => oItem.querySelector(s);
    const bBusy = sBusy.has(oDevice.id);

    q('.name').textContent = oDevice.name;
    q('.id').textContent = `#${oDevice.id}`;
    q('.default-badge').hidden = !oDevice.isDefault;
    q('.summary').textContent = sConnectionSummary(oDevice.connectionSettings);
    q('.dot').classList.add(oDevice.isActive ? 'on' : oDevice.lastError ? 'fail' : 'off');

    let sState = oDevice.isActive ? 'Подключена' : 'Не подключена';
    if (sSwitching.has(oDevice.id)) sState = 'Подключена, меняется связь — задания кассы ждут';
    if (oDevice.isActive && oDevice.oQueue) {
      sState += oDevice.oQueue.number ? `, заданий в очереди: ${oDevice.oQueue.number}` : ', очередь пуста';
    }
    q('.state').textContent = sState;
    const sError = oDevice.isLock
      ? `Очередь остановлена: ${O_BLOCK_REASONS[oDevice.oQueue?.blockReason] || 'сбой ККТ'}.`
        + (oDevice.isActive ? ' Сервер проверяет ККТ каждые 3 секунды и продолжит сам.' : ' Подключите ККТ — сервер выяснит исход и продолжит.')
      : !oDevice.isActive && oDevice.lastError;
    if (sError) {
      q('.error').hidden = false;
      q('.error').textContent = sError;
    }

    q('.kassa').textContent = sKassaUrl(oDevice.id);

    // Штрих-М: связь ККТ с ОФД и ОИСМ (режим USB) и кнопка переключения.
    oItem.dataset.id = oDevice.id;
    const oModeButton = q('[data-act="mode"]');
    // Пока режим меняется, ККТ на секунды «не подключена» (сервер открывает её заново) — строку не прячем.
    if (bCore(oDevice.connectionSettings.model) && (oDevice.isActive || sSwitching.has(oDevice.id))) {
      const oMode = mModes.get(oDevice.id);
      q('.mode-row').hidden = false;
      const bNet = oMode && oMode.ppp === 3 && oMode.socks;
      if (sSwitching.has(oDevice.id)) {
        q('.mode').textContent = 'меняется…';
        q('.mode-progress').hidden = false;
        fUpdateProgress(oItem, oDevice.id);
      } else if (!oMode) {
        q('.mode').textContent = '…';
      } else if (oMode.sError) {
        q('.mode').textContent = `не прочитана: ${oMode.sError}`;
      } else {
        q('.mode').textContent = bNet
          ? 'с ОФД и ОИСМ — через этот компьютер (USB PPP)'
          : oMode.ppp === 3 ? 'через компьютер (USB PPP), но не включена до конца — включите заново' : 'только USB (VCOM), без выхода в сеть';
        q('.mode-hint').textContent = bNet ? ''
          : 'Документы не уходят в ОФД, коды маркировки не проверяются онлайн: своей сети у ККТ по USB нет.';
        oModeButton.hidden = false;
        oModeButton.dataset.marking = bNet ? '' : '1';
        oModeButton.textContent = bNet ? 'Отключить связь через компьютер' : 'Включить связь через компьютер';
        if (!bNet) oModeButton.classList.add('primary');
      }
    }

    const oCheck = mChecks.get(oDevice.id);
    if (oCheck) {
      q('.check').hidden = false;
      q('.check').replaceChildren(oCheck);
    }

    const oToggle = q('[data-act="toggle"]');
    oToggle.textContent = oDevice.isActive ? 'Отключить' : 'Подключить';
    if (!oDevice.isActive) oToggle.classList.add('primary');
    q('[data-act="check"]').hidden = !oDevice.isActive;
    q('[data-act="default"]').hidden = oDevice.isDefault;
    for (const oButton of oItem.querySelectorAll('button')) {
      oButton.disabled = bBusy;
      oButton.addEventListener('click', () => pDeviceAction(oButton.dataset.act, oDevice, oButton));
    }
    return oItem;
  }));
}

async function pDeviceAction(sAct, oDevice, oButton) {
  if (sAct === 'copy') return pCopy(oButton.closest('.device').querySelector('.kassa'));
  if (sAct === 'edit') return fOpenDeviceDialog(oDevice);
  if (sAct === 'delete') return pDeleteDevice(oDevice);
  if (sAct === 'mode') return pSwitchMode(oDevice, Boolean(oButton.dataset.marking));

  const sId = encodeURIComponent(oDevice.id);
  sBusy.add(oDevice.id);
  fRenderDevices();
  try {
    if (sAct === 'toggle') {
      await pApi('POST', `${oDevice.isActive ? 'deactivateDevice' : 'activateDevice'}?deviceID=${sId}`);
      if (oDevice.isActive) mChecks.delete(oDevice.id);
      oNotify.success(`${oDevice.name}: ${oDevice.isActive ? 'отключена' : 'подключена'}`);
    } else if (sAct === 'default') {
      await pApi('POST', 'setDefaultDevice', { id: oDevice.id });
      oNotify.success(`«${oDevice.name}» — ККТ по умолчанию: на ней печатают кассы с адресом без deviceID`);
    } else if (sAct === 'check') {
      const oResult = await pApi('POST', `operations/queryDeviceInfo?deviceID=${sId}`);
      mChecks.set(oDevice.id, oCheckView(oResult));
    }
  } catch (oError) {
    if (sAct === 'check') mChecks.set(oDevice.id, oCheckView(null, oError.message));
    else oNotify.error(oError.message);
  } finally {
    sBusy.delete(oDevice.id);
    await pRefreshDevices().catch((oError) => oNotify.error(oError.message));
  }
}

// Полоса смены связи: сервер отвечает одним запросом в конце, поэтому — по
// времени от ожидаемого (с перезагрузкой ККТ ~30 с, без — ~20 с), не дальше 95 %.
function fUpdateProgress(oItem, sId) {
  const o = mSwitchStart.get(sId);
  if (!o) return;
  const nSec = (Date.now() - o.nAt) / 1000;
  oItem.querySelector('.mode-progress').value = Math.min(0.95, nSec / o.nSec);
  oItem.querySelector('.mode-hint').textContent = `${Math.round(nSec)} с. ККТ может перезагрузиться — до двух минут. Задания кассы подождут.`;
}
setInterval(() => {
  for (const sId of sSwitching) {
    const oItem = document.querySelector(`.device[data-id="${CSS.escape(sId)}"]`);
    if (oItem) fUpdateProgress(oItem, sId);
  }
}, 500);

// ——— Штрих-М в режиме сетевой карты USB (RNDIS) ———
let aRndis = [];
let nRndisAt = 0; // начало перевода; 0 — не идёт

async function pLoadRndis() {
  if (nRndisAt) return;
  aRndis = await pApi('GET', 'agentRndis').catch(() => []);
  $('rndis-box').hidden = !aRndis.length;
  $('rndis-list').textContent = aRndis.map((o) => o.description).join('; ');
}

async function pRndisToCom() {
  if (!aRndis.length) return;
  nRndisAt = Date.now();
  $('rndis-button').disabled = true;
  $('rndis-progress').hidden = false;
  $('rndis-hint').hidden = false;
  const nTimer = setInterval(() => {
    const nSec = (Date.now() - nRndisAt) / 1000;
    $('rndis-progress').value = Math.min(0.95, nSec / 25);
    $('rndis-hint').textContent = `${Math.round(nSec)} с. Связь с ККТ по USB, запись режима, перезагрузка.`;
  }, 500);
  try {
    const oDone = await pApi('POST', 'agentRndis', { id: aRndis[0].id });
    // Перезагрузка ККТ — ~15 с; дождаться, что COM-порт появился.
    for (let n = 0; n < 30; n += 1) {
      await new Promise((f) => setTimeout(f, 1000));
      const aPorts = await pApi('GET', 'agentPorts').catch(() => []);
      if (aPorts.some((o) => o.model === 'shtrih')) break;
    }
    oNotify.success(`${oDone.name || 'ККТ'}: теперь USB-COM. Если её нет в списке — добавьте (модель «Штрих-М»); если есть — подключите и включите связь через компьютер.`);
  } catch (oError) {
    oNotify.error(oError.message);
  } finally {
    clearInterval(nTimer);
    nRndisAt = 0;
    $('rndis-button').disabled = false;
    $('rndis-progress').hidden = true;
    $('rndis-hint').hidden = true;
    await pLoadRndis();
    await pRefreshDevices().catch(() => {});
  }
}

async function pSwitchMode(oDevice, bMarking) {
  const oMode = mModes.get(oDevice.id);
  const sText = bMarking
    ? `Включить для «${oDevice.name}» связь через этот компьютер? ККТ сама будет отправлять документы в ОФД и проверять коды маркировки в ОИСМ — через сеть компьютера (USB PPP и SOCKS). Если понадобится, ККТ перезагрузится — до двух минут.`
    : `Отключить для «${oDevice.name}» связь через компьютер? ККТ останется только на USB (VCOM): документы перестанут уходить в ОФД, коды маркировки — проверяться онлайн.`;
  if (!await pConfirm(sText, bMarking ? 'Включить' : 'Отключить')) return;
  // Ожидаемая длительность: из «только USB» — до перезагрузки по таймеру (~90 с).
  mSwitchStart.set(oDevice.id, { nAt: Date.now(), nSec: !bMarking ? 10 : oMode?.ppp !== 3 ? 90 : !oMode?.socks ? 30 : 10 });
  sSwitching.add(oDevice.id);
  sBusy.add(oDevice.id);
  mModes.delete(oDevice.id);
  fRenderDevices();
  try {
    mModes.set(oDevice.id, await pApi('POST', `agentShtrihMode?deviceID=${encodeURIComponent(oDevice.id)}`, { marking: bMarking }));
    oNotify.success(`${oDevice.name}: ${bMarking ? 'связь с ОФД и ОИСМ — через этот компьютер (USB PPP)' : 'только USB (VCOM), без выхода в сеть'}`);
  } catch (oError) {
    oNotify.error(oError.message);
  } finally {
    sSwitching.delete(oDevice.id);
    mSwitchStart.delete(oDevice.id);
    sBusy.delete(oDevice.id);
    await pRefreshDevices().catch((oError) => oNotify.error(oError.message));
  }
}

const O_INFO_LABELS = {
  modelName: 'Модель',
  serial: 'Заводской номер',
  firmwareVersion: 'Прошивка',
  configurationVersion: 'Конфигурация',
  ffdVersion: 'ФФД ККТ',
  fnFfdVersion: 'ФФД ФН',
};

function oCheckView(oResult, sError) {
  if (sError) {
    const oP = document.createElement('p');
    oP.className = 'error';
    oP.textContent = `Нет связи: ${sError}`;
    return oP;
  }
  const oInfo = oResult?.deviceInfo || oResult || {};
  const oList = document.createElement('dl');
  const fRow = (sLabel, vValue) => {
    const oDt = document.createElement('dt');
    const oDd = document.createElement('dd');
    oDt.textContent = sLabel;
    oDd.textContent = String(vValue);
    oList.append(oDt, oDd);
  };
  fRow('Связь', `есть, ${new Date().toLocaleTimeString()}`);
  for (const [sKey, sLabel] of Object.entries(O_INFO_LABELS)) {
    if (oInfo[sKey] !== undefined && oInfo[sKey] !== '') fRow(sLabel, oInfo[sKey]);
  }
  return oList;
}

// ——— удаление ———

function pConfirm(sText, sOk = 'Удалить') {
  const oDialog = $('confirm-dialog');
  $('confirm-text').textContent = sText;
  $('confirm-ok').textContent = sOk;
  oDialog.returnValue = '';
  oDialog.showModal();
  return new Promise((fResolve) => {
    oDialog.addEventListener('close', () => fResolve(oDialog.returnValue === 'ok'), { once: true });
  });
}

async function pDeleteDevice(oDevice) {
  const sExtra = oDevice.isDefault && aDevices.length > 1
    ? ' Это ККТ по умолчанию — после удаления выберите другую, иначе кассы с адресом без deviceID печатать не смогут.'
    : '';
  if (!await pConfirm(`Удалить ККТ «${oDevice.name}» (#${oDevice.id}) из списка сервера?${sExtra}`)) return;
  try {
    await pApi('DELETE', `devices/${encodeURIComponent(oDevice.id)}`);
    mChecks.delete(oDevice.id);
    oNotify.success(`ККТ «${oDevice.name}» удалена`);
  } catch (oError) {
    oNotify.error(oError.message);
  }
  await pRefreshDevices().catch((oError) => oNotify.error(oError.message));
}

// ——— добавление и настройка ККТ ———

let oEditing = null; // ККТ, которую правят; null — добавление

function fFillSelect(oSelect, aItems, vCurrent) {
  const aAll = [...aItems];
  const sCurrent = vCurrent === undefined || vCurrent === null ? '' : String(vCurrent);
  // Значение, которого нет в списке (ККТ перенесли с другого ПК) — не теряем.
  if (sCurrent && !aAll.some((o) => o.key === sCurrent)) aAll.push({ key: sCurrent, description: sCurrent });
  oSelect.replaceChildren(...aAll.map((o) => new Option(o.description, o.key)));
  if (sCurrent) oSelect.value = sCurrent;
}

function fShowPortFields() {
  const oForm = $('device-form');
  const oEl = oForm.elements;
  // Штрих-М — только COM-порт; порт с ККТ — из найденных, если не выбран свой.
  const bShtrih = bCore(oEl.model.value);
  if (bShtrih) {
    oEl.port.value = 'com';
    const sFound = aPorts.find((o) => o.model === 'shtrih')?.key;
    if (sFound && !aPorts.some((o) => o.key === oEl.com.value && o.model === 'shtrih')) oEl.com.value = sFound;
  }
  oEl.port.disabled = bShtrih;
  for (const oItem of oForm.querySelectorAll('[data-core]')) oItem.hidden = (oItem.dataset.core === 'yes') !== bShtrih;
  let sPort = oEl.port.value;
  if (sPort === 'tcpip') sPort = 'tcp';
  for (const oLabel of oForm.querySelectorAll('[data-port]')) oLabel.hidden = oLabel.dataset.port !== sPort;
  // Скорость у USB VCOM ни на что не влияет — у Штриха на найденном USB-порту не спрашиваем.
  if (bShtrih && aPorts.some((o) => o.key === oEl.com.value && o.model === 'shtrih')) oEl.baudRate.closest('label').hidden = true;
}

async function fOpenDeviceDialog(oDevice) {
  oEditing = oDevice;
  const oForm = $('device-form');
  let oBase = oDevice;
  if (!oBase) {
    oBase = await pApi('GET', 'utils/deviceParametersStruct');
    // Web Requests предлагает COM1 и 1200 бод; ККТ Атола по умолчанию — 115200.
    oBase.connectionSettings.baudRate = 115200;
    oBase.connectionSettings.com = oMapping.com[0]?.key ?? '';
  }
  const oConn = oBase.connectionSettings;

  $('device-dialog-title').textContent = oDevice ? `Настройка ККТ #${oDevice.id}` : 'Новая ККТ';
  oForm.reset();
  oForm.querySelectorAll('.touched').forEach((o) => o.classList.remove('touched'));
  oForm.elements.name.value = oBase.name || '';
  oForm.elements.id.value = oDevice ? oDevice.id : '';
  oForm.elements.id.disabled = Boolean(oDevice);
  // Сохранённая модель Атола, которой нет среди двух, — показываем её как есть.
  const aModels = A_UI_MODELS.some((o) => o.key === String(oConn.model))
    ? A_UI_MODELS : [...A_UI_MODELS, { key: String(oConn.model), description: sDescribe('model', oConn.model) }];
  fFillSelect(oForm.elements.model, aModels, oConn.model);
  fFillSelect(oForm.elements.port, oMapping.port, oConn.port);
  fFillSelect(oForm.elements.usbDevice, oMapping.usbDevice, oConn.usbDevice || 'auto');
  fFillSelect(oForm.elements.baudRate, oMapping.baudRate, oConn.baudRate);
  fFillSelect(oForm.elements.ofdChannel, oMapping.ofdChannel, oConn.ofdChannel || 'auto');
  // Порты — найденные на ПК (с подписью, что за ККТ); не вышло — из mapping.
  aPorts = await pApi('GET', 'agentPorts').catch(() => []);
  $('com-list').replaceChildren(...(aPorts.length ? aPorts : oMapping.com).map((o) => new Option(o.description, o.key)));
  oForm.elements.com.value = oConn.com ?? '';
  oForm.elements.ipAddress.value = oConn.ipAddress || '';
  oForm.elements.ipPort.value = oConn.ipPort || '';
  oForm.elements.mac.value = oConn.mac || '';
  oForm.elements.accessPassword.value = oConn.accessPassword || '';
  oForm.elements.userPassword.value = oConn.userPassword || '';
  oForm.querySelector('details').open = Boolean(oConn.accessPassword || oConn.userPassword);
  $('activate-row').hidden = Boolean(oDevice);
  oForm.elements.activate.checked = true;
  $('device-error').hidden = true;
  fShowPortFields();
  $('device-dialog').showModal();
  oForm.elements.name.focus();
}

function oConnectionFromForm() {
  const oEl = $('device-form').elements;
  const sPort = oEl.port.value;
  const oConn = {
    ...(oEditing?.connectionSettings || {}),
    // Модели Атола — числа (как у Web Requests), Штрих-М — 'shtrih'.
    model: /^\d+$/.test(oEl.model.value) ? Number(oEl.model.value) : oEl.model.value,
    port: sPort,
    ofdChannel: oEl.ofdChannel.value,
    accessPassword: oEl.accessPassword.value,
    userPassword: oEl.userPassword.value,
  };
  if (sPort === 'usb') oConn.usbDevice = oEl.usbDevice.value || 'auto';
  if (sPort === 'com') Object.assign(oConn, { com: oEl.com.value.trim(), baudRate: Number(oEl.baudRate.value) });
  if (sPort === 'tcp' || sPort === 'tcpip') {
    Object.assign(oConn, { ipAddress: oEl.ipAddress.value.trim(), ipPort: Number(oEl.ipPort.value) || 5555 });
  }
  if (sPort === 'bluetooth') oConn.mac = oEl.mac.value.trim();
  return oConn;
}

function sFormProblem() {
  const oForm = $('device-form');
  const oEl = oForm.elements;
  // Проверяем только видимые поля: скрытые (другой канал связи) не мешают.
  for (const oInput of oForm.querySelectorAll('input, select')) {
    if (oInput.closest('[hidden]') || oInput.disabled) continue;
    if (!oInput.checkValidity()) {
      oInput.classList.add('touched');
      oInput.focus();
      return `${oInput.closest('label')?.firstChild?.textContent.trim() || oInput.name}: ${oInput.validationMessage}`;
    }
  }
  if (oEl.port.value === 'com' && !oEl.com.value.trim()) return 'Укажите порт';
  if ((oEl.port.value === 'tcp' || oEl.port.value === 'tcpip') && !oEl.ipAddress.value.trim()) return 'Укажите IP-адрес ККТ';
  if (oEl.port.value === 'bluetooth' && !oEl.mac.value.trim()) return 'Укажите MAC-адрес';
  return '';
}

async function pSaveDevice(oEvent) {
  oEvent.preventDefault();
  const oEl = $('device-form').elements;
  const oError = $('device-error');
  const sProblem = sFormProblem();
  if (sProblem) {
    oError.textContent = sProblem;
    oError.hidden = false;
    return;
  }
  oError.hidden = true;
  $('device-save').disabled = true;
  try {
    const oBody = { name: oEl.name.value.trim(), connectionSettings: oConnectionFromForm() };
    if (oEditing) {
      await pApi('PUT', `devices/${encodeURIComponent(oEditing.id)}`, { id: oEditing.id, ...oBody });
      mChecks.delete(oEditing.id);
      $('device-dialog').close();
      oNotify.success(`ККТ «${oBody.name}» сохранена`);
    } else {
      if (oEl.id.value.trim()) oBody.id = oEl.id.value.trim();
      const oAdded = await pApi('POST', 'devices', oBody);
      $('device-dialog').close();
      if (oEl.activate.checked) {
        // Добавляют ККТ, чтобы на ней печатать: подключаем сразу. Не вышло —
        // ККТ в списке остаётся, причина видна у неё.
        try {
          await pApi('POST', `activateDevice?deviceID=${encodeURIComponent(oAdded.id)}`);
          oNotify.success(`ККТ «${oAdded.name}» добавлена и подключена`);
        } catch (oActivateError) {
          oNotify.warning(`ККТ добавлена, но не подключилась: ${oActivateError.message}`);
        }
      } else {
        oNotify.success(`ККТ «${oAdded.name}» добавлена`);
      }
    }
  } catch (oSaveError) {
    oError.textContent = oSaveError.message;
    oError.hidden = false;
  } finally {
    $('device-save').disabled = false;
    await pRefreshDevices().catch((oRefreshError) => oNotify.error(oRefreshError.message));
  }
}

// ——— версия и обновление ———

const O_UPDATE_STATES = { checking: 'проверяю…', downloading: 'скачиваю…', installing: 'устанавливаю…', restarting: 'перезапускаюсь…' };

function fRenderUpdate(oStatus) {
  const aLine = [oStatus.version ? `Версия ${oStatus.version}, ${oStatus.platform}` : 'Запуск из репозитория'];
  if (O_UPDATE_STATES[oStatus.state]) aLine.push(`обновление: ${O_UPDATE_STATES[oStatus.state]}`);
  else if (oStatus.available) aLine.push(`доступна ${oStatus.available.version}`);
  else if (oStatus.lastCheck) aLine.push(`новее нет (проверено ${new Date(oStatus.lastCheck).toLocaleString()})`);
  $('update-version').textContent = aLine.join(' · ');
  const sError = oStatus.installed ? oStatus.lastError : oStatus.reason;
  $('update-error').hidden = !sError;
  $('update-error').textContent = sError || '';
  $('update-error').classList.toggle('muted', !oStatus.installed);
  $('update-controls').hidden = !oStatus.installed;
  if (oStatus.updateUrl) $('update-downloads').href = oStatus.updateUrl;
  $('update-auto').checked = oStatus.auto;
  $('update-install').hidden = !oStatus.available || oStatus.state !== 'idle';
  $('update-install').textContent = oStatus.available ? `Обновить до ${oStatus.available.version}` : '';
}

async function pLoadUpdate() {
  fRenderUpdate(await pApi('GET', 'agentUpdate'));
}

async function pUpdateAction(oBody, oButton) {
  if (oButton) oButton.disabled = true;
  try {
    const oStatus = await pApi('POST', 'agentUpdate', oBody);
    fRenderUpdate(oStatus);
    if (oStatus.state === 'restarting') {
      oNotify.info('Обновлено, агент перезапускается — страница обновится сама');
      // Агент вернётся уже новой версией: ждём и перечитываем страницу.
      fReloadWhenBack();
    } else if (oBody.action === 'check') {
      if (oStatus.available) oNotify.info(`Доступна версия ${oStatus.available.version}`);
      else oNotify.success('Установлена последняя версия');
    }
  } catch (oError) {
    oNotify.error(oError.message);
    await pLoadUpdate().catch(() => {});
  } finally {
    if (oButton) oButton.disabled = false;
  }
}

// ——— HTTPS ———

function fRenderHttps(oStatus) {
  $('https-off').hidden = oStatus.enabled;
  $('https-on').hidden = !oStatus.enabled;
  if (!oStatus.enabled) return;
  const sUrl = `https://${location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname}:${oStatus.port}/api/v2/`;
  $('https-url').textContent = sUrl;
  $('https-state').textContent = oStatus.listening ? `Включён, порт ${oStatus.port}` : 'Включён, но не слушает';
  const sProblem = oStatus.error ? `HTTPS не работает: ${oStatus.error}` : oStatus.problem;
  $('https-problem').hidden = !sProblem;
  $('https-problem').textContent = sProblem || '';
  const oCert = oStatus.certificate;
  const aRows = oCert ? [
    ['Отпечаток SHA-256', oCert.fingerprint],
    ['Действует до', new Date(oCert.validTo).toLocaleDateString()],
    ['Имена и адреса', oCert.names.join(', ')],
  ] : [];
  $('https-cert').replaceChildren(...aRows.flatMap(([sLabel, sValue]) => {
    const oDt = document.createElement('dt');
    const oDd = document.createElement('dd');
    oDt.textContent = sLabel;
    oDd.textContent = sValue;
    return [oDt, oDd];
  }));
}

async function pLoadHttps() {
  fRenderHttps(await pApi('GET', 'agentHttps'));
}

async function pHttpsAction(sAction, oButton) {
  oButton.disabled = true;
  try {
    fRenderHttps(await pApi('POST', 'agentHttps', { action: sAction }));
    oNotify.success(sAction === 'disable' ? 'HTTPS выключен' : 'Сертификат выпущен, HTTPS включён');
  } catch (oError) {
    oNotify.error(oError.message);
    await pLoadHttps().catch(() => {});
  } finally {
    oButton.disabled = false;
  }
}

// ——— модуль ТС ПИоТ ———

const O_PIOT_TRUST = {
  system: 'сертификату доверяет система',
  first: 'сертификат запомнен при первом подключении',
  pinned: 'сертификат тот же, что запомнен',
  changed: 'сертификат сменился',
};

let sPiotSeen = ''; // отпечаток, который можно подтвердить

function fRenderPiot(oStatus) {
  $('piot-default').textContent = oStatus.defaultUrl;
  $('piot-url').placeholder = oStatus.defaultUrl;
  if (document.activeElement !== $('piot-url')) $('piot-url').value = oStatus.url;
}

function fRenderPiotCheck(oResult) {
  const oInfo = oResult.info ?? {};
  const oCert = oResult.certificate;
  let sState;
  if (oResult.ok) sState = `Модуль ${oInfo.tspiotId ?? 'без номера'} отвечает (${oResult.target})`;
  else if (oResult.error) sState = oResult.error;
  else sState = `Модуль ответил кодом ${oResult.httpStatus}`;
  $('piot-state').textContent = sState;
  $('piot-state').className = oResult.ok ? 'state' : 'state error';
  const aRows = [];
  if (oResult.ok) {
    aRows.push(['Касса', oInfo.kktSerial ?? '—'], ['ИНН', oInfo.kktInn ?? '—'],
      ['Локальный модуль «Честного знака»', oInfo.lm?.status ?? 'нет сведений']);
  }
  if (oCert) {
    aRows.push(['Сертификат', O_PIOT_TRUST[oCert.trust] ?? oCert.trust], ['Отпечаток SHA-256', oCert.fingerprint]);
    if (oCert.trust === 'changed' && oResult.fingerprint) aRows.push(['Был', oResult.fingerprint]);
    if (oCert.validTo) aRows.push(['Действует до', new Date(oCert.validTo).toLocaleDateString()]);
    if (oCert.names?.length) aRows.push(['Имена', oCert.names.join(', ')]);
  }
  $('piot-info').replaceChildren(...aRows.flatMap(([sLabel, sValue]) => {
    const oDt = document.createElement('dt');
    const oDd = document.createElement('dd');
    oDt.textContent = sLabel;
    oDd.textContent = sValue;
    return [oDt, oDd];
  }));
  sPiotSeen = oCert?.trust === 'changed' ? oCert.fingerprint : '';
  $('piot-trust-row').hidden = !sPiotSeen;
  $('piot-result').hidden = false;
}

async function pLoadPiot() {
  fRenderPiot(await pApi('GET', 'agentPiot'));
}

async function pSavePiot(oEvent) {
  oEvent.preventDefault();
  try {
    fRenderPiot(await pApi('PUT', 'agentPiot', { url: $('piot-url').value.trim() }));
    $('piot-result').hidden = true;
    oNotify.success('Адрес модуля сохранён');
  } catch (oError) {
    oNotify.error(oError.message);
  }
}

async function pCheckPiot(oButton) {
  oButton.disabled = true;
  try {
    fRenderPiotCheck(await pApi('POST', 'agentPiot', { action: 'check' }));
  } catch (oError) {
    oNotify.error(oError.message);
  } finally {
    oButton.disabled = false;
  }
}

async function pTrustPiot(oButton) {
  if (!await pConfirm('Доверять новому сертификату модуля? Подтверждайте, только если модуль переустанавливали '
    + 'или ему продлили сертификат: иначе коды маркировки могут уйти на чужой компьютер.', 'Доверять')) return;
  oButton.disabled = true;
  try {
    await pApi('POST', 'agentPiot', { action: 'trust', fingerprint: sPiotSeen });
    oNotify.success('Новый сертификат модуля запомнен');
    await pCheckPiot($('piot-check'));
  } catch (oError) {
    oNotify.error(oError.message);
  } finally {
    oButton.disabled = false;
  }
}

// ——— общие настройки ———

async function pLoadSettings() {
  const oSettings = await pApi('GET', 'settings');
  $('settings-form').elements.deleteRequestsAfter.value = oSettings.deleteRequestsAfter;
  $('settings-form').elements.blockQueueOnPrintErrors.checked = oSettings.blockQueueOnPrintErrors;
  $('settings-form').elements.cancelWaitingRequestsAfter.value = oSettings.cancelWaitingRequestsAfter;
  $('settings-form').elements.vendorData.checked = oSettings.vendorData !== false;
}

async function pSaveSettings(oEvent) {
  oEvent.preventDefault();
  const oEl = $('settings-form').elements;
  const oInput = oEl.deleteRequestsAfter;
  for (const oField of [oInput, oEl.cancelWaitingRequestsAfter]) {
    if (!oField.checkValidity()) {
      oNotify.error(oField.validationMessage);
      return;
    }
  }
  try {
    await pApi('PUT', 'settings', {
      deleteRequestsAfter: Number(oInput.value),
      blockQueueOnPrintErrors: oEl.blockQueueOnPrintErrors.checked,
      cancelWaitingRequestsAfter: Number(oEl.cancelWaitingRequestsAfter.value),
      vendorData: oEl.vendorData.checked,
    });
    oNotify.success('Настройки сохранены');
  } catch (oError) {
    oNotify.error(oError.message);
  }
}

// ——— вкладки ———

const A_TABS = ['access', 'kkt', 'connect', 'piot', 'update', 'settings'];

/** Показать вкладку; она же — в адресе (#connect), чтобы перезагрузка и ссылка открывали её. */
function fShowTab(sTab, bFocus = false) {
  const sShown = A_TABS.includes(sTab) ? sTab : A_TABS[0];
  for (const oButton of document.querySelectorAll('[role="tab"]')) {
    const bOn = oButton.dataset.tab === sShown;
    oButton.setAttribute('aria-selected', String(bOn));
    oButton.tabIndex = bOn ? 0 : -1;
    if (bOn && bFocus) oButton.focus();
  }
  for (const oPane of document.querySelectorAll('[data-pane]')) oPane.hidden = oPane.dataset.pane !== sShown;
  if (location.hash.slice(1) !== sShown) history.replaceState(null, '', `#${sShown}`);
}

function fInitTabs() {
  const oList = document.querySelector('[role="tablist"]');
  oList.addEventListener('click', (oEvent) => {
    const oTab = oEvent.target.closest('[role="tab"]');
    if (oTab) fShowTab(oTab.dataset.tab);
  });
  // Стрелки — как в обычных вкладках ОС.
  oList.addEventListener('keydown', (oEvent) => {
    const nStep = { ArrowRight: 1, ArrowLeft: -1 }[oEvent.key];
    if (!nStep) return;
    const nNow = A_TABS.indexOf(location.hash.slice(1));
    fShowTab(A_TABS[(Math.max(nNow, 0) + nStep + A_TABS.length) % A_TABS.length], true);
    oEvent.preventDefault();
  });
  window.addEventListener('hashchange', () => fShowTab(location.hash.slice(1)));
  fShowTab(location.hash.slice(1));
}

// ——— запуск ———

// Адрес «Атол Сервер» для кассы: ?deviceID выбирает ККТ, без него — ККТ по
// умолчанию (касса передаёт параметр и с заданием, и с опросом результата).
const sKassaUrl = (sId) => `${location.origin}/api/v2/${sId ? `?deviceID=${encodeURIComponent(sId)}` : ''}`;

/**
 * Скопировать текст элемента. Буфер обмена (navigator.clipboard) браузер даёт
 * только по https и с localhost; иначе — старый путь через скрытое поле и
 * execCommand('copy'); не вышло и так — выделить и попросить Ctrl+C. В
 * сообщении — что именно скопировано: видно, попал ли ?deviceID.
 */
async function pCopy(oCode) {
  const sText = oCode.textContent;
  try {
    await navigator.clipboard.writeText(sText);
    oNotify.success(`Скопировано: ${sText}`);
    return;
  } catch { /* нет доступа к буферу — дальше */ }
  const oArea = document.createElement('textarea');
  oArea.value = sText;
  oArea.setAttribute('readonly', '');
  oArea.style.position = 'fixed';
  oArea.style.opacity = '0';
  document.body.append(oArea);
  oArea.select();
  let bCopied = false;
  try { bCopied = document.execCommand('copy'); } catch { /* запрещено */ }
  oArea.remove();
  if (bCopied) {
    oNotify.success(`Скопировано: ${sText}`);
  } else {
    getSelection().selectAllChildren(oCode);
    oNotify.info('Адрес выделен — скопируйте его сочетанием Ctrl+C');
  }
}

function fRenderPolicy(oPolicy) {
  $('policy-state').textContent = oPolicy.license
    ? `Ключ лицензии: ${oPolicy.license}`
    : 'Ключа лицензии нет — новые ККТ работают в демо-режиме';
  $('policy-url').textContent = oPolicy.policyUrl || 'не задан';
  $('policy-clear').hidden = !oPolicy.license;
}

async function pLoadPolicy() {
  try {
    fRenderPolicy(await pApi('GET', 'agentPolicy'));
  } catch (oError) {
    $('policy-state').textContent = oError.message;
  }
}

async function pSavePolicy(sLicense) {
  try {
    fRenderPolicy(await pApi('PUT', 'agentPolicy', { license: sLicense }));
    $('policy-license').value = '';
    oNotify.success(sLicense ? 'Ключ лицензии сохранён' : 'Ключ лицензии убран — демо-режим');
  } catch (oError) {
    oNotify.error(oError.message);
  }
}

function fInitPolicy() {
  $('policy-form').addEventListener('submit', (oEvent) => {
    oEvent.preventDefault();
    const sLicense = $('policy-license').value.trim();
    if (!sLicense) return oNotify.error('Вставьте ключ лицензии из личного кабинета');
    pSavePolicy(sLicense);
  });
  $('policy-clear').addEventListener('click', () => pSavePolicy(''));
  pLoadPolicy();
}

function fInitKassaUrl() {
  $('kassa-url').textContent = sKassaUrl('');
  $('kassa-host').textContent = location.hostname;
  $('piot-kassa-url').textContent = `${location.origin}/piot`;
  $('piot-copy').addEventListener('click', () => pCopy($('piot-kassa-url')));
  $('copy-url').addEventListener('click', () => pCopy($('kassa-url')));
}

async function pStart() {
  fInitTabs();
  fInitKassaUrl();
  fInitPolicy();
  $('add-device').addEventListener('click', () => fOpenDeviceDialog(null).catch((oError) => oNotify.error(oError.message)));
  $('device-form').addEventListener('submit', pSaveDevice);
  $('device-form').elements.port.addEventListener('change', fShowPortFields);
  $('device-form').elements.model.addEventListener('change', fShowPortFields);
  $('rndis-button').addEventListener('click', pRndisToCom);
  // ККТ в RNDIS — при открытии и раз в 15 с (на Windows поиск — PowerShell).
  pLoadRndis();
  setInterval(() => { if (!document.hidden) pLoadRndis(); }, 15e3);
  $('device-form').elements.com.addEventListener('change', fShowPortFields);
  $('device-cancel').addEventListener('click', () => $('device-dialog').close());
  $('settings-form').addEventListener('submit', pSaveSettings);
  $('update-check').addEventListener('click', (oEvent) => pUpdateAction({ action: 'check' }, oEvent.currentTarget));
  $('update-install').addEventListener('click', (oEvent) => pUpdateAction({ action: 'install' }, oEvent.currentTarget));
  $('update-auto').addEventListener('change', (oEvent) => pUpdateAction({ action: 'auto', auto: oEvent.currentTarget.checked }));
  $('https-issue').addEventListener('click', (oEvent) => pHttpsAction('issue', oEvent.currentTarget));
  $('https-renew').addEventListener('click', async (oEvent) => {
    const oButton = oEvent.currentTarget;
    if (await pConfirm('Перевыпустить сертификат? Новому сертификату на кассовых ПК придётся доверять заново.', 'Перевыпустить')) {
      pHttpsAction('issue', oButton);
    }
  });
  $('https-disable').addEventListener('click', (oEvent) => pHttpsAction('disable', oEvent.currentTarget));
  $('https-copy').addEventListener('click', () => pCopy($('https-url')));
  $('users-form').addEventListener('submit', pSaveUser);
  $('piot-form').addEventListener('submit', pSavePiot);
  $('piot-check').addEventListener('click', (oEvent) => pCheckPiot(oEvent.currentTarget));
  $('piot-trust').addEventListener('click', (oEvent) => pTrustPiot(oEvent.currentTarget));
  $('notify').addEventListener('mouseenter', fNotifyPause);
  $('notify').addEventListener('mouseleave', () => { if (aNotifyQueue.length) fNotifyResume(); });
  $('restart-button').addEventListener('click', (oEvent) => pRestart(oEvent.currentTarget));

  try {
    oMapping = await pApi('GET', 'utils/mapping');
    await Promise.all([pLoadServerInfo(), pRefreshDevices(), pLoadSettings(), pLoadHttps(), pLoadUpdate(), pLoadUsers(), pLoadPiot()]);
  } catch (oError) {
    oNotify.error(oError.message);
  }

  // Состояние ККТ меняется и без этой страницы (касса, перезапуск ККТ) —
  // перечитываем. Пока открыт диалог — нет: список под ним не нужен.
  setInterval(() => {
    if (document.hidden || $('device-dialog').open || $('confirm-dialog').open) return;
    pRefreshDevices().catch(() => {});
  }, N_REFRESH_MS);
}

pStart();
