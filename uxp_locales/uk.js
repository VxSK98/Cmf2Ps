window.CMF2PS_LOCALES = window.CMF2PS_LOCALES || {};

window.CMF2PS_LOCALES.uk = {
  actions: {
    setSelection: "Задати виділення",
    generate: "Генерація",
    inpaintMaskMode: "Режим InpaintMask",
    addRef: "Додати реф",
    send: "Відправити",
    applySelected: "Застосувати прев'ю",
    installBackend: "Встановити backend і ноди",
  },
  labels: {
    aspect: "Співвідношення:",
    base: "База",
    layerPadding: "Паддинг шару +",
    resizeLayer: "Масштабування шару",
    applyMask: "Маскувати шар",
    feather: "Розтушовка",
    refNode: "Реф-нода:",
    refFolder: "Реф-папка:",
    previewWindow: "Вікно перегляду",
    interface: "Інтерфейс",
    language: "Мова",
    twoLevelLayout: "Дворівневий макет",
    autoUpdatePreview: "Автооновлення превью",
    about: "О програме",
  },
  hints: {
    twoLevelLayout: "Виносить вікно попереднього перегляду в окрему праву колонку",
    autoUpdatePreview: "При отриманні даних із comfy автоматично перемикається на крайній результат.",
    serverAddress: "Адрес сервера (Beta)",
  },
  placeholders: {
    refFilename: "Назва файлу.png",
    backendPath: "Папка custom_nodes не выбрана",
  },
  titles: {
    setSelection:
      "Виділити прямокутник за заготовленими пресетами. Або в центрі документа, або в центрі поточної виділеної області або шару",
    selectInDocumentCenter: "Виділення по центру документа",
    selectInSelectionCenter: "Виділення по центру поточного виділення / шару",
    generate: "Надіслати виділення до comfy та запустити генерацію",
    inpaintMaskMode:
      "Увімкнути або вимкнути режим InpaintMask - малювання додаткової маски для безпосередньої участі в генерації у підтримуваних моделях",
    clearPreview: "Очистити прев'ю",
    refFilename: "Назва файлу",
    sendRefToFolder:
      "Надіслати виділену область або документ до папки ComfyUI\\input",
    deleteRefFromFolder: "Видалити файл на ім'я в папці ComfyUI\\input",
    settings: "Налаштування",
    browse: "Огляд",
    reset: "Повернути значення за замовчуванням",
  },
};
