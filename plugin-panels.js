// Две панели Photoshop из manifest.json разделяют JS-контекст, но получают разные корневые узлы.
(function setupPluginPanels() {
  const { entrypoints, storage } = require("uxp");
  let mainContent;
  let searchHost;
  let loading;

  // Переносим существующий DOM Cmf2Ps вместе с обработчиками, не создавая копию.
  function showMain(rootNode) {
    mainContent = mainContent || document.querySelector(".main");
    if (mainContent && mainContent.parentNode !== rootNode) rootNode.appendChild(mainContent);
  }

  // Контейнер создаётся один раз: повторное открытие сохраняет запрос и карточки.
  function showSearch(rootNode) {
    if (!searchHost) {
      searchHost = document.createElement("div");
      searchHost.className = "image-search-host";
    }
    if (searchHost.parentNode !== rootNode) rootNode.appendChild(searchHost);
    // initialized защищает готовую панель, loading — ещё не завершённую загрузку.
    if (searchHost.dataset.initialized === "true" || loading) return;
    searchHost.textContent = "Загружаю Image Search...";
    // У обработчиков жизненного цикла UXP короткий срок выполнения.
    // Не возвращаем Promise загрузки из showSearch, чтобы не задерживать обработчик show.
    loading = (async () => {
      const folder = await storage.localFileSystem.getPluginFolder();
      const file = await folder.getEntry("image-search.html");
      searchHost.innerHTML = await file.read();
      await window.initImageSearchPanel(searchHost);
    })().catch(() => {
      searchHost.dataset.initialized = "false";
      searchHost.textContent = "Не удалось загрузить поиск. Закройте и снова откройте Image Search.";
    }).finally(() => { loading = null; });
  }

  // Идентификаторы должны совпадать с id панелей в manifest.json.
  entrypoints.setup({
    panels: {
      mainPanel: { show: showMain },
      imageSearchPanel: { show: showSearch },
    },
  });
})();
