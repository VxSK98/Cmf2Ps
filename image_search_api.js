// Сетевой слой SerpApi. Разбор карточек выполняет image-search-parser.js, отображение — image-search.js.
  const ENDPOINT = "https://serpapi.com/search.json";

  // Приводит ответы Google/Яндекса к единому формату карточки, без сетевых запросов.

  // Принимаем только веб-ссылки без логина/пароля; исключаем file:, javascript: и другие схемы.
  function httpUrl(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        ? url.toString() : "";
    } catch (_) { return ""; }
  }
  // Возвращает { results, page }: оригинал, превью, страницу источника, название и размеры.
  function parseSerpApiImages(payload, provider, page) {
    const seen = new Set();
    const results = (Array.isArray(payload.images_results) ? payload.images_results : [])
      .filter((item) => item && typeof item === "object")
      .map((item, index) => {
        const imageUrl = httpUrl(item.original);
        return {
          id: `${provider}-${page}-${item.position || index + 1}`,
          imageUrl,
          // Для вставки нужен оригинал: маленьким превью его не подменяем.
          insertUrl: imageUrl,
          thumbnailUrl: httpUrl(item.thumbnail) || imageUrl,
          pageUrl: httpUrl(item.link),
          host: typeof item.source === "string" ? item.source : "",
          // Google отдаёт original_width/height, Яндекс — вложенный объект size.
          width: String(item.original_width || item.size?.width || ""),
          height: String(item.original_height || item.size?.height || ""),
          alt: typeof item.title === "string" ? item.title : "",
        };
      })
      // Здесь удаляем повторы внутри страницы; между страницами их удаляет сама панель.
      .filter((item) => {
        const key = item.imageUrl || item.thumbnailUrl;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { results, page };
  }

  // Проверяем ввод до обращения к платному API. Номера страниц начинаются с нуля.
  function normalizeSearchParams(params) {
    const apiKey = (params.apiKey || "").trim();
    const queryText = (params.queryText || "").trim();
    const provider = params.provider || "google";
    if (!apiKey) throw new Error("Введите ключ SerpApi.");
    if (!queryText) throw new Error("Введите поисковый запрос.");
    if (!["google", "yandex"].includes(provider)) throw new Error("Неизвестный поисковик.");
    const page = params.page === undefined ? 0 : params.page;
    if (!Number.isInteger(page) || page < 0 || (provider === "google" && page > 99)) {
      throw new Error("Недопустимый номер страницы.");
    }
    return { apiKey, queryText, provider, page, nextPageUrl: params.nextPageUrl || "" };
  }

  // Принимаем продолжение только с домена SerpApi для ожидаемого движка и страницы.
  // Чужой домен отклоняем, чтобы не отправить ему ключ; ключ из готовой ссылки удаляем.
  function paginationUrl(value, params, expectedPage) {
    try {
      const url = new URL(value);
      const pageParam = params.provider === "google" ? "ijn" : "p";
      if (url.origin !== "https://serpapi.com" ||
          !["/search", "/search.json"].includes(url.pathname) ||
          url.username || url.password ||
          url.searchParams.get("engine") !== `${params.provider}_images` ||
          url.searchParams.get(pageParam) !== String(expectedPage)) return "";
      url.searchParams.delete("api_key");
      return url.toString();
    } catch (_) { return ""; }
  }

  // Google использует q/ijn для запроса/страницы, Яндекс — text/p.
  // В ссылке продолжения сохраняем дополнительные параметры, которые вернул SerpApi.
  function buildSearchUrl(params) {
    const next = params.nextPageUrl && paginationUrl(params.nextPageUrl, params, params.page);
    if (params.nextPageUrl && !next) throw new Error("Некорректная ссылка следующей страницы SerpApi.");
    const url = new URL(next || ENDPOINT);
    url.searchParams.set("engine", `${params.provider}_images`);
    url.searchParams.set(params.provider === "google" ? "q" : "text", params.queryText);
    url.searchParams.set(params.provider === "google" ? "ijn" : "p", String(params.page));
    if (!next) {
      if (params.provider === "google") {
        url.searchParams.set("google_domain", "google.com");
        url.searchParams.set("hl", "ru");
      } else {
        url.searchParams.set("yandex_domain", "yandex.ru");
      }
    }
    url.searchParams.set("api_key", params.apiKey);
    url.searchParams.set("output", "json");
    url.searchParams.set("async", "false");
    url.searchParams.set("no_cache", "false");
    return url.toString();
  }

  // Проверяем HTTP-статус и поле error: сервис может сообщить об ошибке даже при HTTP 200.
  async function performSearch(input) {
    const params = normalizeSearchParams(input);
    const url = buildSearchUrl(params);
    let response;
    let payload;
    try {
      response = await fetch(url, { method: "GET" });
    } catch (_) {
      // Исходная ошибка fetch может содержать URL с ключом — её текст не показываем.
      throw new Error("Не удалось связаться с SerpApi. Проверьте подключение к интернету.");
    }
    try {
      payload = JSON.parse(await response.text());
    } catch (_) {
      throw new Error(`SerpApi вернул некорректный JSON (HTTP ${response.status}).`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Некорректный ответ SerpApi.");
    }
    if (!response.ok || payload.error || payload.search_metadata?.status === "Error") {
      const hints = {
        401: "Неверный ключ API. Проверьте ключ в кабинете SerpApi.",
        403: "Доступ запрещён. Проверьте ключ и доступность аккаунта SerpApi.",
        429: "Исчерпана квота или превышена частота запросов. Проверьте лимиты SerpApi.",
      };
      const raw = typeof payload.error === "string" ? payload.error : "Ошибка выполнения поиска.";
      // Скрываем ключ, если сервис включил его в текст своей ошибки.
      const message = raw.split(params.apiKey).join("[скрыто]")
        .split(encodeURIComponent(params.apiKey)).join("[скрыто]")
        .replace(/api_key=[^&\s"']+/gi, "api_key=[скрыто]");
      throw new Error(`SerpApi: ${hints[response.status] || message}`);
    }
    const parsed = parseSerpApiImages(payload, params.provider, params.page);
    const nextPageUrl = paginationUrl(payload.serpapi_pagination?.next, params, params.page + 1);
    // У Google используем ссылку продолжения. У Яндекса нет явного признака конца:
    // панель остановит подгрузку на пустой странице или странице без новых изображений.
    const hasNextPage = parsed.results.length > 0 && (params.provider === "google"
      ? params.page < 99 && Boolean(nextPageUrl) : true);
    return { ...parsed, hasNextPage, nextPageUrl };
  }
  // Таймаут ограничивает ожидание панели, но не отменяет fetch и не повторяет запрос.
  // Поздний ответ уже не изменит результат Promise.race.
  async function searchImages(input) {
    let timer;
    try {
      return await Promise.race([
        performSearch(input),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("SerpApi не ответил за 45 секунд. Повторите запрос.")), 45000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
