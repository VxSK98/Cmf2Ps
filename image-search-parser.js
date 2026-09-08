// Приводит ответы Google/Яндекса к единому формату карточки, без сетевых запросов.
(function setupImageSearchParser() {
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
  window.CMF2PSImageSearchParser = { parseSerpApiImages };
})();
