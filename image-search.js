// Управление поиском: ввод → SerpApi → карточки → Photoshop или ComfyUI.
// API и ключ берём из соседних модулей; функции вставки и отправки экспортирует index.js.
// Обёртка изолирует функции; наружу доступна initImageSearchPanel.
(function setupImageSearchPanel() {
  const photoshopCore = require("photoshop").core;
  const { shell: uxpShell } = require("uxp");
  // В localStorage только запрос и поисковик. Ключ хранит image-search-settings.js.
  const STORAGE_KEYS = {
    provider: "cmf2ps.imageSearch.serpapi.provider",
    query: "cmf2ps.imageSearch.query",
  };

  function loadStoredValue(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch (_) {
      return "";
    }
  }

  function saveStoredValue(key, value) {
    try {
      localStorage.setItem(key, value || "");
    } catch (_) {
      /* При ошибке сохранения панель продолжает работать. */
    }
  }

  // В UXP надёжнее читать выбранный option через selectedIndex и атрибут value.
  function getSelectedProvider(root) {
    const select = root.querySelector("#imageSearchProviderSelect");
    const option = select.options?.[select.selectedIndex];
    return (option?.getAttribute("value") || option?.value || select.value) ===
      "yandex"
      ? "yandex"
      : "google";
  }

  // Синхронизируем свойства и атрибуты select/option для корректного отображения в UXP.
  function selectProvider(select, value) {
    Array.from(select.options).forEach((option, index) => {
      const selected = option.getAttribute("value") === value;
      option.selected = selected;
      if (selected) {
        option.setAttribute("selected", "selected");
        select.selectedIndex = index;
      } else {
        option.removeAttribute("selected");
      }
    });
    select.value = value;
  }

  function setImageSearchStatus(root, text) {
    const status = root.querySelector("#imageSearchStatus");
    status.textContent = text;
    status.title = text;
  }

  function updateButtons(root) {
    const state = root.imageSearchState;
    root.querySelector("#imageSearchButton").disabled = state.busy;
    root.querySelector("#imageSearchNextButton").disabled =
      state.busy || !state.hasNextPage;
  }

  // Смена запроса/движка делает старую выдачу неактуальной.
  // revision позволяет игнорировать поздний ответ, не отменяя сетевой запрос.
  function invalidateSearch(root) {
    const state = root.imageSearchState;
    state.revision += 1;
    state.search = null;
    state.page = -1;
    state.nextPageUrl = "";
    state.hasNextPage = false;
    state.seen.clear();
    root.querySelector("#imageSearchPreviewGrid").innerHTML =
      '<div class="image-search-empty">Здесь появятся результаты поиска</div>';
    setImageSearchStatus(root, "Ожидает запрос");
    updateButtons(root);
  }

  function formatResultSize(result) {
    return result.width && result.height
      ? `${result.width} × ${result.height}`
      : "Размер неизвестен";
  }

  async function openExternalUrl(root, url) {
    if (!url) return;
    try {
      const error = await uxpShell.openExternal(url);
      if (error) throw new Error(error);
    } catch (_) {
      setImageSearchStatus(root, "Не удалось открыть страницу источника.");
    }
  }

  // Определяем формат по сигнатуре: URL может быть без расширения или возвращать HTML.
  // Это проверка заголовка файла, а не полное декодирование изображения.
  function getImageFileExtension(bytes) {
    const starts = (...values) =>
      values.every((value, index) => bytes[index] === value);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return ".png";
    if (starts(0xff, 0xd8, 0xff)) return ".jpg";
    if (starts(0x47, 0x49, 0x46, 0x38)) return ".gif";
    if (starts(0x42, 0x4d)) return ".bmp";
    if (starts(0x49, 0x49, 0x2a, 0) || starts(0x4d, 0x4d, 0, 0x2a))
      return ".tif";
    if (
      starts(0x52, 0x49, 0x46, 0x46) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    )
      return ".webp";
    throw new Error(
      "Источник вернул неподдерживаемый файл вместо PNG/JPEG/WebP/GIF/BMP/TIFF. Откройте страницу источника.",
    );
  }

  // Оригинал скачиваем с сайта источника по кнопке карточки.
  // Таймаут ограничивает ожидание результата, но сам fetch не отменяет.
  async function downloadOriginal(imageUrl) {
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(imageUrl);
          if (!response.ok)
            throw new Error(
              `Оригинал недоступен (HTTP ${response.status}). Откройте страницу источника.`,
            );
          return new Uint8Array(await response.arrayBuffer());
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Источник не ответил за 45 секунд. Попробуйте другую картинку или откройте страницу источника.",
                ),
              ),
            45000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Общая загрузка для двух направлений; inserting исключает одновременные отправки.
  // Смена запроса не отменяет вставку, но не даёт ей менять статус новой выдачи.
  async function insertImageResult(
    root,
    result,
    button,
    destination = "photoshop",
  ) {
    const imageUrl = result.insertUrl || result.imageUrl;
    if (!imageUrl || root.imageSearchState.inserting) return;
    const revision = root.imageSearchState.revision;
    const setStatus = (text) => {
      if (revision === root.imageSearchState.revision)
        setImageSearchStatus(root, text);
    };
    try {
      root.imageSearchState.inserting = true;
      button.disabled = true;
      setStatus("Скачиваю оригинал...");
      const bytes = await downloadOriginal(imageUrl);
      const extension = getImageFileExtension(bytes);
      const safeId = String(result.id)
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(0, 80);
      const filename = `cmf2ps_search_${safeId}_${Date.now()}${extension}`;
      // auto обновляет список input в Comfy, true сохраняет расширение на backend.
      // Base64 передаёт исходные байты; перекодирования изображения здесь нет.
      if (destination === "comfy") {
        setStatus("Отправляю в ComfyUI/input...");
        await window.CMF2PSPushRefToComfy(
          window.CMF2PSBytesToBase64(bytes),
          filename,
          "auto",
          true,
        );
        setStatus(`Сохранено в ComfyUI/input/${filename}`);
        return;
      }
      setStatus("Вставляю в Photoshop...");
      // Модальный контекст нужен для изменения документа; загрузка выполнена до него.
      await photoshopCore.executeAsModal(
        async () => {
          await window.CMF2PSOpenImgInPS(bytes, filename);
        },
        { commandName: "Insert Image Search Result" },
      );
      setStatus("Картинка вставлена");
    } catch (error) {
      setStatus(
        error.message ||
          "Не удалось вставить оригинал. Откройте страницу источника.",
      );
    } finally {
      root.imageSearchState.inserting = false;
      button.disabled = false;
    }
  }

  // Карточка получает единый формат из парсера. Названия задаём через textContent,
  // чтобы текст источника не интерпретировался как HTML.
  function createResultCard(root, result) {
    const card = document.createElement("div");
    card.className = "image-search-result-card";
    card.title = result.alt || result.pageUrl;
    const thumbWrap = document.createElement("div");
    thumbWrap.className = "image-search-result-thumb-wrap";
    const image = document.createElement("img");
    image.className = "image-search-result-thumb";
    image.alt = result.alt || result.host || "Image search result";
    image.addEventListener("error", () => card.classList.add("is-broken"));
    image.src = result.thumbnailUrl;
    const broken = document.createElement("div");
    broken.className = "image-search-result-broken";
    broken.textContent = "Превью недоступно";
    thumbWrap.appendChild(image);
    thumbWrap.appendChild(broken);
    const meta = document.createElement("div");
    meta.className = "image-search-result-meta";
    const title = document.createElement("div");
    title.className = "image-search-result-host";
    title.textContent = result.alt || "Без названия";
    const host = document.createElement("div");
    host.className = "image-search-result-host";
    host.textContent = result.host || "Источник неизвестен";
    const size = document.createElement("div");
    size.className = "image-search-result-size";
    size.textContent = formatResultSize(result);
    meta.appendChild(title);
    meta.appendChild(host);
    meta.appendChild(size);
    const actions = document.createElement("div");
    actions.className = "image-search-result-actions";
    const openPageButton = document.createElement("sp-action-button");
    openPageButton.className = "image-search-source-button";
    openPageButton.textContent = "Страница";
    openPageButton.disabled = !result.pageUrl;
    openPageButton.addEventListener("click", () =>
      openExternalUrl(root, result.pageUrl),
    );
    const insertButton = document.createElement("sp-action-button");
    insertButton.textContent = "Вставить в PS";
    insertButton.disabled = !result.imageUrl;
    insertButton.addEventListener("click", () =>
      insertImageResult(root, result, insertButton),
    );
    const comfyButton = document.createElement("sp-action-button");
    comfyButton.textContent = "Вставить в Comfy";
    comfyButton.disabled = !result.imageUrl;
    comfyButton.addEventListener("click", () =>
      insertImageResult(root, result, comfyButton, "comfy"),
    );
    actions.appendChild(openPageButton);
    actions.appendChild(insertButton);
    actions.appendChild(comfyButton);
    card.appendChild(thumbWrap);
    card.appendChild(meta);
    card.appendChild(actions);
    return card;
  }

  // Берём актуальный ключ из общего модуля настроек, а не из поля панели поиска.
  function getSearchParams(root) {
    return {
      provider: getSelectedProvider(root),
      apiKey: window.CMF2PSImageSearchSettings.getKey(),
      queryText: root.querySelector("#imageSearchQueryField").value.trim(),
    };
  }

  // shouldAppend=false начинает поиск заново, true продолжает выдачу по кнопке «Ещё».
  async function runSearch(root, shouldAppend = false) {
    const state = root.imageSearchState;
    if (state.busy || (shouldAppend && !state.hasNextPage)) return;
    const params = getSearchParams(root);
    if (!params.apiKey || !params.queryText) {
      setImageSearchStatus(
        root,
        !params.apiKey ? "Введите ключ SerpApi." : "Введите поисковый запрос.",
      );
      return;
    }
    if (
      shouldAppend &&
      (!state.search ||
        params.provider !== state.search.provider ||
        params.queryText !== state.search.queryText)
    ) {
      invalidateSearch(root);
      return;
    }
    if (!shouldAppend) invalidateSearch(root);
    const revision = state.revision;
    const page = shouldAppend ? state.page + 1 : 0;
    // При ошибке подгрузки восстановим кнопку, не увеличивая номер успешной страницы.
    const retryNext = state.hasNextPage;
    state.busy = true;
    updateButtons(root);
    setImageSearchStatus(root, shouldAppend ? "Загружаю ещё..." : "Ищу...");
    try {
      const response = await window.CMF2PSImageSearchApi.searchImages({
        ...params,
        page,
        nextPageUrl: shouldAppend ? state.nextPageUrl : "",
      });
      // Пока ждали API, запрос мог измениться — устаревший ответ не рисуем.
      if (revision !== state.revision) return;
      // seen живёт весь текущий поиск и убирает повторы между страницами.
      const results = response.results.filter((result) => {
        const key = result.imageUrl || result.thumbnailUrl;
        if (state.seen.has(key)) return false;
        state.seen.add(key);
        return true;
      });
      const grid = root.querySelector("#imageSearchPreviewGrid");
      if (!shouldAppend) grid.innerHTML = "";
      results.forEach((result) =>
        grid.appendChild(createResultCard(root, result)),
      );
      if (!state.seen.size)
        grid.innerHTML =
          '<div class="image-search-empty">По этому запросу ничего не найдено</div>';
      state.search = { provider: params.provider, queryText: params.queryText };
      state.page = page;
      state.nextPageUrl = response.nextPageUrl;
      state.hasNextPage = response.hasNextPage && results.length > 0;
      const providerName = params.provider === "google" ? "Google" : "Яндекс";
      setImageSearchStatus(
        root,
        `${providerName} · Показано: ${state.seen.size}${state.hasNextPage ? "" : " · Конец выдачи"}`,
      );
    } catch (error) {
      if (revision !== state.revision) return;
      state.hasNextPage = shouldAppend && retryNext;
      setImageSearchStatus(root, error.message || "Ошибка поиска");
    } finally {
      state.busy = false;
      updateButtons(root);
    }
  }

  // Вызывается из plugin-panels.js после загрузки HTML. initialized предотвращает
  // повторное добавление обработчиков при открытии уже созданной панели.
  window.initImageSearchPanel = async function initImageSearchPanel(root) {
    if (!root || root.dataset.initialized === "true") return;
    root.dataset.initialized = "true";
    // busy — поиск; inserting — вставка/отправка; revision — версия запроса.
    // page=-1 — успешных страниц ещё нет; search — параметры текущей выдачи.
    // nextPageUrl — продолжение Google; seen — уже показанные изображения.
    root.imageSearchState = {
      busy: false,
      inserting: false,
      revision: 0,
      page: -1,
      hasNextPage: false,
      nextPageUrl: "",
      search: null,
      seen: new Set(),
    };
    const providerSelect = root.querySelector("#imageSearchProviderSelect");
    const queryField = root.querySelector("#imageSearchQueryField");
    selectProvider(
      providerSelect,
      loadStoredValue(STORAGE_KEYS.provider) === "yandex" ? "yandex" : "google",
    );
    queryField.value = loadStoredValue(STORAGE_KEYS.query);
    // Изменения полей очищают выдачу; запрос запускается только кнопками/Enter.
    providerSelect.addEventListener("change", () => {
      saveStoredValue(STORAGE_KEYS.provider, getSelectedProvider(root));
      invalidateSearch(root);
    });
    queryField.addEventListener("input", () => {
      saveStoredValue(STORAGE_KEYS.query, queryField.value);
      invalidateSearch(root);
    });
    root
      .querySelector("#imageSearchButton")
      .addEventListener("click", () => runSearch(root));
    root
      .querySelector("#imageSearchNextButton")
      .addEventListener("click", () => runSearch(root, true));
    queryField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch(root);
      }
    });
    // Неактивные обработчики скрытых кнопок оставлены вместе с заготовками в HTML.
    // root
    //   .querySelector("#imageSearchResetButton")
    //   .addEventListener("click", () => {
    //     queryField.value = "";
    //     selectProvider(providerSelect, "google");
    //     saveStoredValue(STORAGE_KEYS.provider, "google");
    //     saveStoredValue(STORAGE_KEYS.query, "");
    //     invalidateSearch(root);
    //   });
    invalidateSearch(root);
    // root.querySelector("#imageSearchSettingsButton").addEventListener("click", () => window.CMF2PSShowSettings(root));
    // await window.CMF2PSImageSearchSettings.ready;
  };
})();
