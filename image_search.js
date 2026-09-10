// Управление поиском: ввод → SerpApi → карточки → Photoshop или ComfyUI.
// API и ключ берём из соседних модулей; функции вставки и отправки экспортирует index.js.
// Загрузка панели и обработчики находятся в этом файле; функции объявлены без обёртки.
const photoshopCore = require("photoshop").core;
const { shell: uxpShell } = require("uxp");
// В localStorage только запрос и поисковик. Ключ хранит image-search-settings.js.

// Основная таблица, куда записываются данные о файлах, поиске и состояниях
let imageSearchState = {
  busy: false,
  inserting: false,
  revision: 0,
  page: -1,
  hasNextPage: false,
  nextPageUrl: "",
  search: null,
  seen: new Set(),
  provider: ""
};

function setImageSearchStatus(root, text) {
  const status = document.getElementById("imageSearchStatus");
  status.textContent = text;
  status.title = text;
}

function updateButtons(root) {
  const state = imageSearchState;
  document.getElementById("imageSearchButton").disabled = state.busy;
  document.getElementById("imageSearchNextButton").disabled =
    state.busy || !state.hasNextPage;
}

// Чистка результатов поиска
function delSearch(root) {
  const state = imageSearchState;
  state.revision += 1;
  state.search = null;
  state.page = -1;
  state.nextPageUrl = "";
  state.hasNextPage = false;
  state.seen.clear();
  state.provider = loadSetting(SETTINGS_KEYS.provider) || "google"
  document.getElementById("imageSearchPreviewGrid").innerHTML =
    '<div class="image-search-empty">Здесь появятся результаты поиска</div>';
  setImageSearchStatus(root, "Ожидает запрос");
  updateButtons(root);
}

function formatResultSize(result) {
  return result.width && result.height
    ? `${result.width} × ${result.height}`
    : "Размер неизвестен";
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
  if (starts(0x49, 0x49, 0x2a, 0) || starts(0x4d, 0x4d, 0, 0x2a)) return ".tif";
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
  if (!imageUrl || imageSearchState.inserting) return;
  const revision = imageSearchState.revision;
  const setStatus = (text) => {
    if (revision === imageSearchState.revision)
      setImageSearchStatus(root, text);
  };
  try {
    imageSearchState.inserting = true;
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
      await pushRefToComfy(uint8ToBase64(bytes), filename, "auto", true);
      setStatus(`Сохранено в ComfyUI/input/${filename}`);
      return;
    }
    setStatus("Вставляю в Photoshop...");
    if (!bResizeLayer) {
      await photoshopCore.executeAsModal(
        async () => {
          await openImgInPS(bytes, filename);
          await resetTransform();
        },
        { commandName: "Insert Image Search Result" },
      );
    } 
    else {
      await photoshopCore.executeAsModal(
        async () => {
          await openImgInPSImgSrch(bytes, filename);
        },
        { commandName: "Insert Image Search Result" },
      );
    }
    setStatus("Картинка вставлена");
  } catch (error) {
    setStatus(
      error.message ||
        "Не удалось вставить оригинал.",
    );
  } finally {
    imageSearchState.inserting = false;
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
  const insertButton = document.createElement("sp-action-button");
  insertButton.textContent = "В PS";
  insertButton.disabled = !result.imageUrl;
  insertButton.addEventListener("click", () =>
    insertImageResult(root, result, insertButton),
  );
  const comfyButton = document.createElement("sp-action-button");
  comfyButton.textContent = "В Comfy";
  comfyButton.disabled = !result.imageUrl;
  comfyButton.addEventListener("click", () =>
    insertImageResult(root, result, comfyButton, "comfy"),
  );
  actions.appendChild(insertButton);
  actions.appendChild(comfyButton);
  thumbWrap.appendChild(actions);
  card.appendChild(thumbWrap);
  card.appendChild(meta);
  return card;
}

// Берём актуальный ключ из общего модуля настроек, а не из поля панели поиска.
function getSearchParams(root) {
  return {
    provider: loadSetting(SETTINGS_KEYS.provider) || "google",
    apiKey: window.CMF2PSImageSearchSettings.getKey(),
    queryText: document.getElementById("imageSearchQueryField").value.trim(),
  };
}

// shouldAppend=false начинает поиск заново, true продолжает выдачу по кнопке «Ещё».
async function runSearch(root, shouldAppend = false) {
  const state = imageSearchState;
  if (state.busy || (shouldAppend && !state.hasNextPage)) return;
  let params = getSearchParams(root);
  if (!params.apiKey) {
    setImageSearchStatus(root, "Введите ключ SerpApi.");
    return;
  } else if (!params.queryText) {
    setImageSearchStatus(root, "Введите поисковый запрос.");
    return;
  }
  if (!shouldAppend) {
    delSearch(root);
  }
  else if(shouldAppend && state.provider != params.provider){
    params.provider = state.provider;
  }
  const page = state.page + 1;
  console.log("page = ", page);
  const revision = state.revision;

  // При ошибке подгрузки восстановим кнопку, не увеличивая номер успешной страницы.
  const retryNext = state.hasNextPage;
  state.busy = true;
  updateButtons(root);
  setImageSearchStatus(root, shouldAppend ? "Загружаю ещё..." : "Ищу...");
  try {
    // Отправляем запрос и ждём ответ
    const response = await searchImages({
      ...params,
      page,
      nextPageUrl: shouldAppend ? state.nextPageUrl : "",
    });
    // Пока ждали API, запрос мог измениться - устаревший ответ не рисуем.
    if (revision !== state.revision) return;
    // В seen живёт весь текущий поиск и убирает повторы между страницами.
    // response.results - массив картинок, полученный от API
    // results - фильтрация на новых запрсов дубликаты
    const results = response.results.filter((result) => {
      const key = result.imageUrl || result.thumbnailUrl;
      // Если в seen был ранее зарегестрирован - пропускаем
      if (state.seen.has(key)) return false;
      // В инном случае добавляем новый элемент
      state.seen.add(key);
      return true;
    });
    const grid = document.getElementById("imageSearchPreviewGrid");
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
    setImageSearchStatus(
      root,
      `${params.provider} - Показано: ${state.seen.size}${state.hasNextPage ? "" : " - Конец выдачи"}`,
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

// Регистрация событий
function initImageSearchPanel(root) {
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";
  // busy — поиск; inserting — вставка/отправка; revision — версия запроса.
  // page=-1 — успешных страниц ещё нет; search — параметры текущей выдачи.
  // nextPageUrl — продолжение Google; seen — уже показанные изображения.

  const queryField = document.getElementById("imageSearchQueryField");
  queryField.value = loadSetting(SETTINGS_KEYS.query);
  // Изменения полей очищают выдачу; запрос запускается только кнопками/Enter.

  queryField.addEventListener("input", () => {
    saveSetting(SETTINGS_KEYS.query, queryField.value);
  });
  document
    .getElementById("imageSearchButton")
    .addEventListener("click", () => runSearch(root));
  document
    .getElementById("imageSearchNextButton")
    .addEventListener("click", () => runSearch(root, true));
  queryField.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(root);
    }
  });

  // Кнопки подключаем после загрузки HTML, когда они уже доступны в документе.
  // delSearch(root);
}

// Контейнер и его содержимое сохраняются между открытиями окна.
let searchHost;
let searchPanelLoading;

function showImageSearch(rootNode) {
  if (!searchHost) {
    searchHost = document.createElement("div");
    searchHost.className = "image-search-host";
  }
  if (searchHost.parentNode !== rootNode) rootNode.appendChild(searchHost);
  if (searchHost.dataset.initialized === "true" || searchPanelLoading) return;

  // Не задерживаем обработчик show: чтение файла продолжается асинхронно.
  searchPanelLoading = loadImageSearch()
    .catch((error) => {
      searchHost.dataset.initialized = "false";
      console.warn("[CMF2PS] Image Search:", error.message);
    })
    .finally(() => {
      searchPanelLoading = null;
    });
}

// Загрузка html и событий
async function loadImageSearch() {
  const folder = await require("uxp").storage.localFileSystem.getPluginFolder();
  const file = await folder.getEntry("image_search.html");
  searchHost.innerHTML = await file.read();

  initImageSearchPanel(searchHost);
}

// Основную панель Photoshop показывает автоматически, здесь регистрируем только дополнительную.
require("uxp").entrypoints.setup({
  panels: {
    imageSearchPanel: { show: showImageSearch },
  },
});
