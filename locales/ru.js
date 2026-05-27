window.CMF2PS_LOCALES = window.CMF2PS_LOCALES || {};

window.CMF2PS_LOCALES.ru = {
  actions: {
    setSelection: "Задать выделение",
    generate: "Генерация",
    inpaintMaskMode: "Режим InpaintMask",
    addRef: "Добавить реф",
    send: "Отправить",
    applySelected: "Применить выбранное",
    installBackend: "Установить backend и ноды",
  },
  labels: {
    aspect: "Соотношение:",
    base: "База",
    layerPadding: "Паддинг слоя +",
    resizeLayer: "Масштабирование слоя",
    applyMask: "Маскировать слой",
    feather: "Растушевка",
    refNode: "Реф-нода:",
    refFolder: "Реф-папка:",
    previewWindow: "Окно предпросмотра",
    interface: "Интерфейс",
    language: "Язык(Beta)",
    languageRu: "Русский",
    languageEn: "Английский(Beta)",
    twoLevelLayout: "Двухуровневый макет",
    about: "О программе",
  },
  hints: {
    twoLevelLayout: "Выносит окно предпросмотра в отдельную правую колонку.",
  },
  placeholders: {
    refFilename: "Название файла.png",
    backendPath: "Папка custom_nodes не выбрана",
  },
  titles: {
    setSelection:
      "Выделить прямоугольник по заготовленным пресетам. Либо в центре документа, либо по центру текущей выделенной области или слоя",
    selectInDocumentCenter: "Выделение по центру документа",
    selectInSelectionCenter: "Выделение по центру текущего выделения / слоя",
    generate: "Отправить выделение в comfy и запустить генерацию",
    inpaintMaskMode:
      "Включить или выключить режим InpaintMask - рисование дополнительной маски для непосредственной участии в генерации в поддерживаемых моделях",
    clearPreview: "Очистить превью",
    refFilename: "Название файла",
    sendRefToFolder:
      "Отправить выделенную область или документ в папку ComfyUI\\input",
    deleteRefFromFolder: "Удалить файл по имени в папке ComfyUI\\input",
    settings: "Настройки",
    browse: "Обзор",
  },
};
