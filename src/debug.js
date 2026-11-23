// Отладочный журнал агента — галочка в общих настройках (debugLog, settings.js)
// или KKT_AGENT_DEBUG (прежнее KKT_AGENT_DRV_DEBUG — тоже). Пишет в журнал
// агента: запросы к API с временем ответа, задания очереди ККТ, сообщения
// kkt-core, вызовы драйвера Посцентра — чтобы найти, где ККТ задумывается.
// Содержимое заданий (позиции, коды маркировки) не пишется.

const bFromEnv = () => Boolean(process.env.KKT_AGENT_DEBUG || process.env.KKT_AGENT_DRV_DEBUG);
let bOn = bFromEnv();

export const bDebugOn = () => bOn;

export function fSetDebug(b) {
  bOn = Boolean(b) || bFromEnv();
}
