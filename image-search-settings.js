// Общий ключ SerpApi: актуальное значение в памяти, сохранённая копия в защищённом хранилище UXP.
(function setupImageSearchSettings() {
  const secureStorage = require("uxp").storage.secureStorage;
  const KEY = "cmf2ps.imageSearch.serpapi.apiKey";
  let value = "";
  let revision = 0;
  let writes = Promise.resolve();
  // Читаем ключ один раз. revision не даёт позднему чтению затереть новый ввод.
  // UXP возвращает байты; ASCII-символы ключа преобразуем напрямую в строку.
  const ready = (async () => {
    try {
      const bytes = await secureStorage.getItem(KEY);
      if (revision === 0 && bytes) value = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    } catch (_) { /* Первый запуск или очищенное хранилище: оставляем пустой ключ. */ }
  })();

  // В памяти обновляем сразу, записи в хранилище ставим в очередь.
  // Так предыдущая запись не восстановит ключ после команды удаления.
  function setKey(next) {
    value = next.trim();
    revision += 1;
    const saved = value;
    const operation = writes.then(async () => {
      if (saved) await secureStorage.setItem(KEY, saved);
      else {
        let exists;
        try { exists = await secureStorage.getItem(KEY); } catch (_) { return; }
        if (exists) await secureStorage.removeItem(KEY);
      }
    });
    // Ошибка записи не блокирует очередь; вызывающий код получает её через operation.
    writes = operation.catch(() => {});
    return operation;
  }

  window.CMF2PSImageSearchSettings = {
    ready,
    getKey: () => value,
    setKey,
    // Связываем поля общего окна настроек с хранилищем, без повторных обработчиков.
    bind: async (root) => {
      const field = root.querySelector("#imageSearchApiKeyField");
      const status = root.querySelector("#imageSearchKeyStatus");
      const clear = root.querySelector("#imageSearchClearKeyButton");
      if (!field || field.dataset.bound === "true") return;
      field.dataset.bound = "true";
      let edited = false;
      async function update(next) {
        edited = true;
        const operation = setKey(next);
        // Завершение старой записи не должно менять статус более свежего ввода.
        const editRevision = revision;
        try {
          await operation;
          if (revision === editRevision) status.textContent = next.trim()
            ? "Ключ сохранён в защищённом хранилище UXP." : "Ключ удалён.";
        } catch (_) {
          if (revision === editRevision) status.textContent = next.trim()
            ? "Не удалось сохранить ключ. Он доступен до закрытия плагина."
            : "Не удалось удалить сохранённый ключ. Повторите удаление.";
        }
      }
      field.addEventListener("input", () => update(field.value));
      clear.addEventListener("click", () => { field.value = ""; return update(""); });
      await ready;
      if (!edited) field.value = value;
    },
  };
  document.addEventListener("DOMContentLoaded", () => window.CMF2PSImageSearchSettings.bind(document));
})();
