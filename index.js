const { app, core, action } = require("photoshop");
const { storage } = require("uxp");
const fs = storage.localFileSystem;
const formats = storage.formats;

/** ws://127.0.0.1:8188/cmf2ps/ws?platform=ps */
const WS_URL = "ws://127.0.0.1:8188/cmf2ps/ws?platform=ps";
const UI_CLIENT_ID = `psui_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

// http://127.0.0.1:8188/cmf2ps/clients  - адрес подключенных клиентов

let ws = null;
let isConnecting = false;
// Очередь не дает async-обработчикам WebSocket накладываться друг на друга.
let wsMessageQueue = Promise.resolve();
let firstRender = true;
let bSnapshot = false;
let bSelectInCenter = true;

let imageMask;

let previewItems = [];
let refItems = [];

let selectedPreviewIndex = -1;
let selectedRefIndex = -1;

let bApplyMask = true;
let bResizeLayer = false;
let bAutoUpdatePreview = false;

let inpaintMaskMod = false;

let snapshotSize;
let imgPPI = 72;

let generationCount = 1;
let maskBlurValue = 6.0;
let maskPaddingValue = 8;
// let mask2PaddingValue = 4;

let selectedAspect = "1024x1024";

//

/////////////////////// Настройки локализации

const refFilename = "ref";
const DEFAULT_LOCALE = "ru";
let currentLocale = window.CMF2PS_LOCALE || DEFAULT_LOCALE;

function t(key, fallback = "") {
  const locale = window.CMF2PS_LOCALES?.[currentLocale] || {};
  const value = key.split(".").reduce((obj, part) => obj?.[part], locale);

  return typeof value === "string" ? value : fallback || key;
}

// Проходит по DOM и применяет переводы из data-i18n*, оставляя исходный текст fallback'ом.
function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n, el.textContent.trim());
  });

  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const title = t(el.dataset.i18nTitle, el.getAttribute("title") || el.title);
    el.title = title;
    el.setAttribute("title", title);
  });

  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const placeholder = t(
      el.dataset.i18nPlaceholder,
      el.getAttribute("placeholder") || el.placeholder,
    );
    el.placeholder = placeholder;
    el.setAttribute("placeholder", placeholder);
  });

  syncLocaleSelect();
}

// В UXP option.value/select.value могут вести себя нестабильно, поэтому читаем атрибут напрямую.
function getOptionValue(option) {
  return option.getAttribute("value") || option.value;
}

// Текущий выбор берем через selectedIndex, а не через select.value: так надежнее в UXP dialog.
function getSelectedLocaleFromSelect(localeSelect) {
  const selectedIndex = localeSelect.selectedIndex;
  const selectedOption = localeSelect.options[selectedIndex];

  return selectedOption ? getOptionValue(selectedOption) : null;
}

// Синхронизирует визуальный select с currentLocale несколькими способами для совместимости с UXP.
function syncLocaleSelect() {
  const localeSelect = document.getElementById("localeSelect");
  if (!localeSelect) return;

  Array.from(localeSelect.options).forEach((option, index) => {
    const isSelected = getOptionValue(option) === currentLocale;
    option.selected = isSelected;

    if (isSelected) {
      option.setAttribute("selected", "selected");
      localeSelect.selectedIndex = index;
    } else {
      option.removeAttribute("selected");
    }
  });

  localeSelect.value = currentLocale;
  localeSelect.setAttribute("value", currentLocale);
  localeSelect.setAttribute("data-current-locale", currentLocale);
}

// Меняет активный язык и, при необходимости, сразу перерисовывает локализованные элементы.
function setLocale(locale, shouldApply = true) {
  if (!window.CMF2PS_LOCALES?.[locale]) return false;

  currentLocale = locale;
  if (shouldApply) {
    applyI18n();
    setTimeout(syncLocaleSelect, 0);
  }
  return true;
}

window.setCmf2PsLocale = setLocale;

/////////////////////// Функции сохранения параметров

// Ключи настроек в localStorage. Значения переживают закрытие панели/Photoshop.
const SETTINGS_KEYS = {
  twoLevelLayout: "cmf2ps_two_level_layout",
  maskPadding: "cmf2ps_mask_padding",
  maskBlur: "cmf2ps_mask_blur",
  selectedAspect: "cmf2ps_selected_aspect",
  applyMask: "cmf2ps_apply_mask",
  resizeLayer: "cmf2ps_resize_layer",
  refFolderFilename: "cmf2ps_ref_folder_filename",
  locale: "cmf2ps_locale",
  customNodesToken: "cmf2ps_custom_nodes_token",
  customNodesPath: "cmf2ps_custom_nodes_path",
  autoUpdatePreview: "cmf2ps_auto_update_preview",
};

// Безопасная запись настройки: если localStorage недоступен, плагин продолжит работать.
function saveSetting(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (e) {
    console.log("Failed to save setting:", key, e);
  }
}

// Безопасное чтение настройки. null значит, что сохраненного значения еще нет.
function loadSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.log("Failed to load setting:", key, e);
    return null;
  }
}

function normalizePngFilename(value) {
  const clean = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_");

  if (!clean) return refFilename;
  return /\.png$/i.test(clean) ? clean : `${clean.replace(/\.[^.]*$/, "")}.png`;
}

function getRefFolderFilename() {
  const input = document.getElementById("refFolderFilename");
  const filename = normalizePngFilename(input.value);
  return filename;
}

// Читает число и ограничивает его диапазоном контрола, чтобы не применить битое значение.
function loadNumberSetting(key, fallback, min, max) {
  const raw = loadSetting(key);
  if (raw === null) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;

  return Math.min(max, Math.max(min, value));
}

// Булевые настройки храним как "1"/"0", чтобы не зависеть от строк true/false.
function loadBooleanSetting(key, fallback) {
  const raw = loadSetting(key);
  if (raw === null) return fallback;

  return raw === "1";
}

///////////////////////

/////////////////////// Функции профайлера
const PERF = true;

function perfStart(label) {
  if (!PERF) return null;
  const t = performance.now();
  console.log(`[PERF] start ${label}`);
  return { label, t };
}

function perfEnd(token) {
  if (!PERF || !token) return;
  const dt = performance.now() - token.t;
  console.log(`[PERF] ${token.label}: ${dt.toFixed(1)} ms`);
}

let lastThemeIsLight = null;

/////////////////////////////////////// Переключатель иконок

function isLightTheme() {
  const bodyStyle = getComputedStyle(document.body);
  const bgColor = bodyStyle.backgroundColor;
  // console.log("bgColor", bgColor);
  // #535353 #323232
  if (bgColor == "#F0F0F0" || bgColor == "#B8B8B8") {
    return true;
  }
  return false;
}

function updateThemeIcons() {
  const clearIconPath = isLightTheme()
    ? "images/cmf2ps_clearImg_light@2x.png"
    : "images/cmf2ps_clearImg_dark@2x.png";

  document.querySelectorAll('img[data-theme-icon="clear"]').forEach((img) => {
    img.src = clearIconPath;
  });
}

function updateThemeIcons2() {
  const clearIconPath = isLightTheme()
    ? "images/cmf2ps_trashBox_light@2x.png"
    : "images/cmf2ps_trashBox_dark@2x.png";

  document.querySelectorAll('img[data-theme-icon="trash"]').forEach((img) => {
    img.src = clearIconPath;
  });
}

function watchThemeChanges() {
  const tick = () => {
    const current = isLightTheme();
    if (current !== lastThemeIsLight) {
      lastThemeIsLight = current;
      updateThemeIcons();
      updateThemeIcons2();
    }
  };

  tick();
  setInterval(tick, 1000);
}
///////////////////////////////////////

/////////////////////////////////////// Установка comfyui-cmf2ps через uxp

function setBackendPathText(path) {
  const input = document.getElementById("backendPathField");
  if (!input) return;

  input.value = path || "";
}

async function refreshBackendPathText() {
  const savedPath = loadSetting(SETTINGS_KEYS.customNodesPath);
  if (savedPath) {
    setBackendPathText(savedPath);
    return;
  }

  const token = loadSetting(SETTINGS_KEYS.customNodesToken);
  if (!token) return;

  try {
    const folder = await fs.getEntryForPersistentToken(token);
    setBackendPathText(folder.nativePath || folder.name || "");
  } catch (err) {
    console.warn("[CMF2PS] failed to restore custom_nodes path:", err);
    setBackendPathText("");
  }
}

async function deleteEntryRecursive(entry) {
  if (entry.isFolder) {
    const entries = await entry.getEntries();
    for (const child of entries) {
      await deleteEntryRecursive(child);
    }
  }

  await entry.delete();
}

async function selectCustomNodesFolder() {
  // Пользователь выбирает ComfyUI/custom_nodes, UXP выдает доступ только к выбранной папке.
  const folder = await fs.getFolder();
  if (!folder) return;

  // Persistent token нужен, чтобы не спрашивать путь заново после перезапуска Photoshop.
  const token = await fs.createPersistentToken(folder);
  saveSetting(SETTINGS_KEYS.customNodesToken, token);
  saveSetting(
    SETTINGS_KEYS.customNodesPath,
    folder.nativePath || folder.name || "",
  );
  setBackendPathText(folder.nativePath || folder.name || "");
}

async function installComfyNode() {
  const token = loadSetting(SETTINGS_KEYS.customNodesToken);
  if (!token) throw new Error("Custom nodes folder is not selected");

  const customNodesFolder = await fs.getEntryForPersistentToken(token);

  // Backend лежит внутри плагина, поэтому читаем его из read-only plugin folder.
  const pluginFolder = await fs.getPluginFolder();
  const backendFolder = await pluginFolder.getEntry("backend");
  const sourceNodeFolder = await backendFolder.getEntry("comfyui-cmf2ps");

  // Если папка ноды уже установлена, сначала удаляем ее содержимое и саму папку.
  // copyTo с allowFolderCopy не всегда заменяет существующую папку рекурсивно.
  let installedNodeFolder = null;
  try {
    installedNodeFolder = await customNodesFolder.getEntry("comfyui-cmf2ps");
  } catch (err) {
    console.log("[CMF2PS] comfyui-cmf2ps is not installed yet:", err);
  }

  if (installedNodeFolder) {
    await deleteEntryRecursive(installedNodeFolder);
  }

  // Копируем всю папку ноды в custom_nodes уже как новую установку.
  await sourceNodeFolder.copyTo(customNodesFolder, {
    overwrite: true,
    allowFolderCopy: true,
  });
}

///////////////////////////////////////

// Клик по кнопкам
document.getElementById("btnSnapshot").addEventListener("click", async () => {
  try {
    const uiReady = await waitForUiClient(5000);
    if (!uiReady) {
      console.warn("[CMF2PS] UI client is not connected after Comfy restart");
      return;
    }

    const p1 = perfStart("btnSnapshot perf");

    clearPreview();
    await deleteLayerIfExists("cmf2ps_preview");
    firstRender = true;
    if ((await hasSelection()) == false) {
      await require("photoshop").core.executeAsModal(selectAll, {
        commandName: "Action Commands",
      });
    }
    bSnapshot = true;
    if (inpaintMaskMod) {
      await makeMaskAndSnapshot3("snapshot", true);
    } else {
      await makeMaskAndSnapshot3("snapshot", false);
    }
    // запуск генерации
    for (let i = 0; i < generationCount; i++) {
      const r = await fetch("http://127.0.0.1:8188/cmf2ps/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_client_id: UI_CLIENT_ID }),
      });

      const j = await r.json().catch(() => ({}));
      console.log("[CMF2PS] generate:", r.status, j);
      perfEnd(p1);
    }
  } catch (err) {
    console.error("ComfyUI error:", err);
  }
});

document.getElementById("btnSendRef").addEventListener("click", async () => {
  try {
    const p1 = perfStart("SendRef perf");
    await sendRef("_cmf2ps/ref.png", true, "none");
    perfEnd(p1);
  } catch (err) {
    console.error("ComfyUI error:", err);
  }
});

document.getElementById("btnSetBackend").addEventListener("click", async () => {
  try {
    await selectCustomNodesFolder();
  } catch (err) {
    console.error("ComfyUI error:", err);
  }
});

document
  .getElementById("btnBackendInstall")
  .addEventListener("click", async () => {
    try {
      await installComfyNode();
    } catch (err) {
      console.error("ComfyUI error:", err);
    }
  });

document
  .getElementById("btnSendRefInFolder")
  .addEventListener("click", async () => {
    try {
      const p1 = perfStart("SendRef perf");
      await sendRef(getRefFolderFilename(), false, "auto");
      // const r = await fetch("http://127.0.0.1:8188/cmf2ps/refresh", {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify({ target_client_id: UI_CLIENT_ID }),
      // });
      // const j = await r.json().catch(() => ({}));
      perfEnd(p1);
    } catch (err) {
      console.error("ComfyUI error:", err);
    }
  });

document
  .getElementById("btnDelRefInFolder")
  .addEventListener("click", async () => {
    try {
      const r = await fetch("http://127.0.0.1:8188/cmf2ps/del_ref", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_client_id: UI_CLIENT_ID,
          delete_item: getRefFolderFilename(),
        }),
      });
      const j = await r.json().catch(() => ({}));
    } catch (err) {
      console.error("ComfyUI error:", err);
    }
  });

document.getElementById("btnClearRef").addEventListener("click", async () => {
  try {
    clearRef();
  } catch (err) {
    console.error("ComfyUI error:", err);
  }
});

document.getElementById("btnSetSelect").addEventListener("click", async () => {
  try {
    const [w, h] = selectedAspect.split("x").map(Number);

    await require("photoshop").core.executeAsModal(
      async () => {
        await setSelectDS(w, h);
      },
      { commandName: "CMF2PS Set Selection" },
    );
  } catch (err) {
    console.error("btnSetSelect error:", err);
  }
});

document
  .getElementById("btnInpaintMaskMod")
  .addEventListener("click", async () => {
    try {
      await require("photoshop").core.executeAsModal(toggleInpaintMaskChannel, {
        commandName: "Toggle inpaintMask",
      });
    } catch (err) {
      console.error("InpaintMask toggle error:", err);
    }
  });

////////////////////////////

// Импорт макросов

const {
  commandsMakeMaskMerge5p01,
  commandsMakeMaskMerge5p02,
  commandsAddInpaintMask,
  commandsPrepareLayerToCrop,
  commandsPrepareLayerToCropMMAS3,
  commandsMakeInpaintMask,
  commandsMakeInpaintMaskMMAS3,
  commandsFixBackground,
  commandsFixBackgroundMMAS3,
  commandsSetRGB,
  commandsMakeRef,
  // commandsSendBitmapToMask,
  commandsMaskFromImage,
  commandApplyMask,
  commandSelDown,
  commandSelUp,
  commandDelLayer,
  commandsSelectMask,
  commandNewLayerTemp,
  commandMaskFix,
  commandQSelectMask,
  commandSelectMaskDownLayer,
  commandApplyMask2,
} = require("./macros");

////////////////////////////

// document.getElementById("btnTest").addEventListener("click", async () => {
//   try {
//     const p1 = perfStart("btnTest");
//     await runAsSingleHistoryState("CMF2PS btnTest", async () => {
//       // await selectMask();
//       await appendMask();
//       // await require("photoshop").action.batchPlay(commandQSelectMask, {});
//     });

//     perfEnd(p1);
//   } catch (err) {
//     console.error("ComfyUI error:", err);
//   }
// });

////////////////////////////

// Настройки
document.addEventListener("DOMContentLoaded", () => {
  const savedLocale = loadSetting(SETTINGS_KEYS.locale);
  if (savedLocale) {
    setLocale(savedLocale, false);
  }

  applyI18n();

  const main = document.querySelector(".main");
  const dlg = document.getElementById("settingsDialog");
  const btnOpenSettings = document.getElementById("btnOpenSettings");
  const chkTwoLevelLayout = document.getElementById("chkTwoLevelLayout");
  const chkAutoUpdatePreview = document.getElementById("chkAutoUpdatePreview");
  const localeSelect = document.getElementById("localeSelect");

  function applyTwoLevelLayout(enabled) {
    if (!main) return;

    if (enabled) {
      main.classList.add("two-level-layout");
    } else {
      main.classList.remove("two-level-layout");
    }

    saveSetting(SETTINGS_KEYS.twoLevelLayout, enabled ? "1" : "0");
  }

  function loadTwoLevelLayout() {
    const enabled = loadSetting(SETTINGS_KEYS.twoLevelLayout) === "1";

    if (chkTwoLevelLayout) {
      chkTwoLevelLayout.checked = enabled;
    }

    applyTwoLevelLayout(enabled);
  }

  bAutoUpdatePreview = loadBooleanSetting(
    SETTINGS_KEYS.autoUpdatePreview,
    bAutoUpdatePreview,
  );
  chkAutoUpdatePreview.checked = bAutoUpdatePreview;

  if (btnOpenSettings && dlg) {
    btnOpenSettings.addEventListener("click", async () => {
      try {
        syncLocaleSelect();
        setTimeout(syncLocaleSelect, 0);
        setTimeout(syncLocaleSelect, 50);
        await dlg.showModal();
        syncLocaleSelect();
      } catch (e) {
        console.log("settings dialog error:", e);
      }
    });
  }

  if (chkTwoLevelLayout) {
    chkTwoLevelLayout.addEventListener("change", (e) => {
      applyTwoLevelLayout(!!e.target.checked);
    });
  }

  if (chkAutoUpdatePreview) {
    chkAutoUpdatePreview.addEventListener("change", (e) => {
      bAutoUpdatePreview = e.target.checked;
      saveSetting(
        SETTINGS_KEYS.autoUpdatePreview,
        bAutoUpdatePreview ? "1" : "0",
      );
      // console.log("autoUpdatePreview:", bAutoUpdatePreview);
    });
  }

  if (localeSelect) {
    syncLocaleSelect();
    localeSelect.addEventListener("change", (e) => {
      const locale = getSelectedLocaleFromSelect(e.target);

      if (setLocale(locale)) {
        saveSetting(SETTINGS_KEYS.locale, locale);
        syncLocaleSelect();
      }
    });
  }

  loadTwoLevelLayout();

  updateThemeIcons();
  watchThemeChanges();
});

function initAspectDropdown() {
  const dropdown = document.getElementById("aspectDropdown");
  const btn = document.getElementById("aspectDropdownBtn");
  const label = document.getElementById("aspectDropdownLabel");
  const menu = document.getElementById("aspectDropdownMenu");
  const items = Array.from(menu.querySelectorAll(".custom-select-item"));

  function closeMenu() {
    menu.classList.add("hidden");
    btn.classList.remove("open");
  }

  function openMenu() {
    menu.classList.remove("hidden");
    btn.classList.add("open");
  }

  function setSelectedItem(item, shouldSave = true) {
    items.forEach((el) => el.classList.remove("selected"));
    item.classList.add("selected");

    selectedAspect = item.dataset.value;
    label.textContent = item.textContent.trim();

    if (shouldSave) {
      saveSetting(SETTINGS_KEYS.selectedAspect, selectedAspect);
    }
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();

    if (menu.classList.contains("hidden")) {
      openMenu();
    } else {
      closeMenu();
    }
  });

  items.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      setSelectedItem(item);
      closeMenu();
      console.log("selectedAspect:", selectedAspect);
    });
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target)) {
      closeMenu();
    }
  });

  // При старте выбираем последний пресет соотношения, если он есть в списке.
  const savedAspect = loadSetting(SETTINGS_KEYS.selectedAspect);
  const initial =
    items.find((item) => item.dataset.value === savedAspect) ||
    menu.querySelector(".custom-select-item.selected");

  if (initial) {
    setSelectedItem(initial, false);
  }
}

function initControls() {
  const genCountLabel = document.getElementById("genCountValue");
  const btnGenMinus = document.getElementById("btnGenMinus");
  const btnGenPlus = document.getElementById("btnGenPlus");

  const maskBlurSlider = document.getElementById("maskBlurSlider");
  const maskBlurLabel = document.getElementById("maskBlurValue");
  const maskPaddingSlider = document.getElementById("maskPaddingSlider");
  const mask2PaddingSlider = document.getElementById("mask2PaddingSlider");
  const maskPaddingLabel = document.getElementById("maskPaddingValue");
  // const mask2PaddingLabel = document.getElementById("mask2PaddingValue");

  const chkApplyMask = document.getElementById("chkApplyMask");
  const chkResizeLayer = document.getElementById("chkResizeLayer");
  const refFolderFilenameInput = document.getElementById("refFolderFilename");

  // Восстанавливаем значения контролов из прошлой сессии до первого refresh UI.
  if (refFolderFilenameInput) {
    refFolderFilenameInput.value =
      loadSetting(SETTINGS_KEYS.refFolderFilename) || refFilename;
    refFolderFilenameInput.addEventListener("change", () => {
      const filename = refFolderFilenameInput.value;
      refFolderFilenameInput.value = filename;
      saveSetting(SETTINGS_KEYS.refFolderFilename, filename);
    });
  }

  refreshBackendPathText();

  bApplyMask = loadBooleanSetting(SETTINGS_KEYS.applyMask, bApplyMask);
  chkApplyMask.checked = bApplyMask;

  bResizeLayer = loadBooleanSetting(SETTINGS_KEYS.resizeLayer, bResizeLayer);
  chkResizeLayer.checked = bResizeLayer;

  maskBlurValue = loadNumberSetting(
    SETTINGS_KEYS.maskBlur,
    maskBlurValue,
    Number(maskBlurSlider.min),
    Number(maskBlurSlider.max),
  );
  maskPaddingValue = loadNumberSetting(
    SETTINGS_KEYS.maskPadding,
    maskPaddingValue,
    Number(maskPaddingSlider.min),
    Number(maskPaddingSlider.max),
  );

  maskBlurSlider.value = String(maskBlurValue);
  maskPaddingSlider.value = String(maskPaddingValue);

  // const chkInpaintMaskMod = document.getElementById("chkInpaintMaskMod");
  // chkInpaintMaskMod.checked = false;

  const btnSelectInCenter = document.getElementById("btnSelectInCenter");
  bSelectInCenter = false;
  btnSelectInCenter.removeAttribute("selected");
  btnSelectInCenter.dataset.i18nTitle = "titles.selectInSelectionCenter";
  btnSelectInCenter.title = t("titles.selectInSelectionCenter");
  btnSelectInCenter.setAttribute("title", btnSelectInCenter.title);

  function refreshGenCount() {
    genCountLabel.textContent = String(generationCount);
  }

  function refreshMaskBlur() {
    maskBlurLabel.textContent = Number(maskBlurValue).toFixed(2);
  }

  function refreshMaskPadding() {
    maskPaddingLabel.textContent = Number(maskPaddingValue).toFixed(2);
  }

  // function refreshMask2Padding() {
  //   mask2PaddingLabel.textContent = Number(mask2PaddingValue).toFixed(2);
  // }

  btnGenMinus.addEventListener("click", () => {
    generationCount = Math.max(1, generationCount - 1);
    refreshGenCount();
  });

  btnGenPlus.addEventListener("click", () => {
    generationCount = Math.min(5, generationCount + 1);
    refreshGenCount();
  });

  chkApplyMask.addEventListener("change", (e) => {
    bApplyMask = e.target.checked;
    // Сохраняем сразу при изменении, отдельная кнопка "Применить" не нужна.
    saveSetting(SETTINGS_KEYS.applyMask, bApplyMask ? "1" : "0");
    console.log("autoApply:", bApplyMask);
  });

  chkResizeLayer.addEventListener("change", (e) => {
    bResizeLayer = e.target.checked;
    // Сохраняем сразу при изменении, отдельная кнопка "Применить" не нужна.
    saveSetting(SETTINGS_KEYS.resizeLayer, bResizeLayer ? "1" : "0");
    console.log("bResizeLayer:", bResizeLayer);
  });

  maskBlurSlider.addEventListener("input", (e) => {
    maskBlurValue = parseFloat(e.target.value);
    refreshMaskBlur();
    // input срабатывает при движении слайдера, поэтому последнее положение всегда запомнится.
    saveSetting(SETTINGS_KEYS.maskBlur, maskBlurValue);
  });

  maskPaddingSlider.addEventListener("input", (e) => {
    maskPaddingValue = parseFloat(e.target.value);
    refreshMaskPadding();
    // Паддинг восстанавливается вместе с остальными рабочими параметрами.
    saveSetting(SETTINGS_KEYS.maskPadding, maskPaddingValue);
  });

  // mask2PaddingSlider.addEventListener("input", (e) => {
  //   mask2PaddingValue = parseFloat(e.target.value);
  //   refreshMask2Padding();
  // });

  btnSelectInCenter.addEventListener("click", () => {
    bSelectInCenter = !bSelectInCenter;

    if (bSelectInCenter) {
      btnSelectInCenter.setAttribute("selected", "");
      btnSelectInCenter.dataset.i18nTitle = "titles.selectInDocumentCenter";
      btnSelectInCenter.title = t("titles.selectInDocumentCenter");
    } else {
      btnSelectInCenter.removeAttribute("selected");
      btnSelectInCenter.dataset.i18nTitle = "titles.selectInSelectionCenter";
      btnSelectInCenter.title = t("titles.selectInSelectionCenter");
    }
    btnSelectInCenter.setAttribute("title", btnSelectInCenter.title);

    console.log("bSelectInCenter:", bSelectInCenter);
  });

  refreshGenCount();
  refreshMaskBlur();
  refreshMaskPadding();
  // refreshMask2Padding();
  initAspectDropdown();
}

async function getSelectionBounds() {
  const hasSel = await hasSelection();
  if (!hasSel) return null;

  const doc = app.activeDocument;
  const b = doc.selection.bounds;

  return {
    left: b.left,
    top: b.top,
    right: b.right,
    bottom: b.bottom,
    width: b.right - b.left,
    height: b.bottom - b.top,
    centerX: (b.left + b.right) / 2,
    centerY: (b.top + b.bottom) / 2,
  };
}

async function clearPreviewUI() {
  clearPreview();
  await deleteLayerIfExists("cmf2ps_preview");
  firstRender = true;
}

document
  .getElementById("btnClearPreview")
  ?.addEventListener("click", clearPreviewUI);
document
  .getElementById("btnClearPreviewCompact")
  ?.addEventListener("click", clearPreviewUI);

async function applySelectedPreview() {
  if (selectedPreviewIndex < 0) return;
  await runAsSingleHistoryState("CMF2PS Apply Preview", async () => {
    const p1 = perfStart("imageMask");
    await deleteLayerIfExistsInCurrentModal("cmf2ps_preview");
    const item = previewItems[selectedPreviewIndex];

    const imageMaskBase64 = await entryToBase64(imageMask);
    const imageMaskBytes = await base64ToUint8Array(imageMaskBase64);
    perfEnd(p1);
    const p2 = perfStart("импорт маски");
    await require("photoshop").action.batchPlay(commandsSetRGB, {}); // Переключение на rgb чинит некоторые глюки при inpaintmask
    await openImgInPS(imageMaskBytes, item.filename + "_mask");
    await resetTransform();
    await centerActiveLayer();
    // await require("photoshop").core.executeAsModal(qSelectMask, {
    //   commandName: "qSelectMask",
    // });

    // await require("photoshop").action.batchPlay(commandMaskFix, {});
    // await selectMask();

    await require("photoshop").action.batchPlay(commandQSelectMask, {});

    perfEnd(p2);
    const p3 = perfStart("импорт bitmap");
    const imageOutputBytes = base64ToUint8Array(item.data);
    await openImgInPS2(
      imageOutputBytes,
      item.filename,
      item.width,
      item.height,
    );
    if (
      snapshotSize.width == item.width &&
      snapshotSize.height == item.height
    ) {
      await resetTransform();
    }
    // if (
    //   snapshotSize.width != item.width &&
    //   snapshotSize.height != item.height
    // ) {
    //   await correntResize(item.width, item.height);
    // } else {
    //   await resetTransform();
    // }
    perfEnd(p3);
    const p4 = perfStart("применить маску");
    await applyMaskInCurrentModal();
    perfEnd(p4);
  });
}

document
  .getElementById("btnApplyPreview")
  ?.addEventListener("click", applySelectedPreview);
document
  .getElementById("btnApplyPreviewCompact")
  ?.addEventListener("click", applySelectedPreview);

async function addPreviewLayer() {
  if (selectedPreviewIndex < 0) return;
  await runAsSingleHistoryState("CMF2PS Preview", async () => {
    await deleteLayerIfExistsInCurrentModal("cmf2ps_preview");
    const p1 = perfStart("imageMask");
    let item = previewItems[selectedPreviewIndex];
    if (firstRender == true) {
      item = previewItems[0];
    }
    firstRender = false;
    const imageMaskBase64 = await entryToBase64(imageMask);
    const imageMaskBytes = await base64ToUint8Array(imageMaskBase64);
    perfEnd(p1);
    const p2 = perfStart("импорт маски");
    await require("photoshop").action.batchPlay(commandsSetRGB, {}); // Переключение на rgb чинит некоторые глюки при inpaintmask
    await openImgInPS(imageMaskBytes, "cmf2ps_preview_mask");
    await resetTransform();
    await centerActiveLayer();
    // await require("photoshop").core.executeAsModal(qSelectMask, {
    //   commandName: "qSelectMask",
    // });

    // const p2b = perfStart("maskFix");
    // await require("photoshop").action.batchPlay(commandMaskFix, {});
    // perfEnd(p2b);
    // await selectMask();

    await require("photoshop").action.batchPlay(commandQSelectMask, {});

    perfEnd(p2);
    const p3 = perfStart("импорт bitmap");
    const imageOutputBytes = base64ToUint8Array(item.data);
    // await openImgInPS(imageMaskBytes, "cmf2ps_preview.png");
    await openImgInPS2(
      imageOutputBytes,
      "cmf2ps_preview.png",
      item.width,
      item.height,
    );
    if (
      snapshotSize.width == item.width &&
      snapshotSize.height == item.height
    ) {
      await resetTransform();
    }
    perfEnd(p3);
    const p4 = perfStart("применить маску");
    await applyMaskInCurrentModal();
    perfEnd(p4);
  });
}

async function applyMaskInCurrentModal() {
  if (bApplyMask == true) {
    await appendMask_new();
  } else {
    await delTempMask();
  }
}

async function centerActiveLayer() {
  const doc = app.activeDocument;
  const layer = doc.activeLayers[0];

  const bounds = layer.bounds;

  const layerLeft = bounds.left;
  const layerTop = bounds.top;
  const layerRight = bounds.right;
  const layerBottom = bounds.bottom;

  const layerWidth = layerRight - layerLeft;
  const layerHeight = layerBottom - layerTop;

  const docWidth = doc.width;
  const docHeight = doc.height;

  // центр документа
  const docCenterX = docWidth / 2;
  const docCenterY = docHeight / 2;

  // центр слоя
  const layerCenterX = layerLeft + layerWidth / 2;
  const layerCenterY = layerTop + layerHeight / 2;

  // смещение
  const offsetX = docCenterX - layerCenterX;
  const offsetY = docCenterY - layerCenterY;

  console.log("layerCenterX", layerCenterX);
  console.log("layerCenterY", layerCenterY);
  console.log("offsetX", offsetX);
  console.log("offsetY", offsetY);

  await layer.translate(offsetX, offsetY);
}

async function hasSelection() {
  const result = await action.batchPlay(
    [
      {
        _obj: "get",
        _target: [
          { _property: "selection" },
          { _ref: "document", _enum: "ordinal", _value: "targetEnum" },
        ],
      },
    ],
    {},
  );

  return !!result[0].selection;
}

async function isAllSelected() {
  const hasSel = await hasSelection();
  if (!hasSel) return false;

  const doc = require("photoshop").app.activeDocument;

  const bounds = doc.selection.bounds;

  const left = bounds.left;
  const top = bounds.top;
  const right = bounds.right;
  const bottom = bounds.bottom;

  return (
    left === 0 && top === 0 && right === doc.width && bottom === doc.height
  );
}

async function selectAll() {
  let commands = [
    // Задать Выделение
    {
      _obj: "set",
      _target: [
        {
          _property: "selection",
          _ref: "channel",
        },
      ],
      to: {
        _enum: "ordinal",
        _value: "allEnum",
      },
    },
  ];
  return await require("photoshop").action.batchPlay(commands, {});
}

async function getTargetCenter() {
  const doc = app.activeDocument;

  if (bSelectInCenter) {
    return {
      centerX: doc.width / 2,
      centerY: doc.height / 2,
    };
  }

  const selBounds = await getSelectionBounds();
  if (selBounds) {
    return {
      centerX: selBounds.centerX,
      centerY: selBounds.centerY,
    };
  }

  const layer = doc.activeLayers[0];
  const bounds = layer.bounds;

  const left = bounds.left;
  const top = bounds.top;
  const right = bounds.right;
  const bottom = bounds.bottom;

  return {
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

async function setSelectDS(X, Y) {
  const doc = app.activeDocument;

  const { centerX, centerY } = await getTargetCenter();

  const halfW = X / 2;
  const halfH = Y / 2;

  let left = centerX - halfW;
  let top = centerY - halfH;
  let right = centerX + halfW;
  let bottom = centerY + halfH;

  // ограничиваем рамку документом
  if (left < 0) {
    right -= left;
    left = 0;
  }
  if (top < 0) {
    bottom -= top;
    top = 0;
  }
  if (right > doc.width) {
    left -= right - doc.width;
    right = doc.width;
  }
  if (bottom > doc.height) {
    top -= bottom - doc.height;
    bottom = doc.height;
  }

  // повторная страховка
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(doc.width, right);
  bottom = Math.min(doc.height, bottom);

  await core.executeAsModal(
    async () => {
      let commands = [
        // Задать Выделение
        {
          _obj: "set",
          _target: [
            {
              _property: "selection",
              _ref: "channel",
            },
          ],
          to: {
            _obj: "rectangle",
            bottom: {
              _unit: "pixelsUnit",
              _value: bottom,
            },
            left: {
              _unit: "pixelsUnit",
              _value: left,
            },
            right: {
              _unit: "pixelsUnit",
              _value: right,
            },
            top: {
              _unit: "pixelsUnit",
              _value: top,
            },
          },
        },
      ];
      await require("photoshop").action.batchPlay(commands, {});
    },
    { commandName: "Action Commands" },
  );
}

async function layerPlusPaddingCrop() {
  const doc = app.activeDocument;
  const bounds = doc.selection.bounds;

  const selWidth = bounds.right - bounds.left;
  const selHeight = bounds.bottom - bounds.top;

  const layerCenterX = bounds.left + selWidth / 2;
  const layerCenterY = bounds.top + selHeight / 2;

  const sideX = (selWidth + maskPaddingValue * 2) / 2;
  const sideY = (selHeight + maskPaddingValue * 2) / 2;

  let left = layerCenterX - sideX;
  let top = layerCenterY - sideY;
  let right = layerCenterX + sideX;
  let bottom = layerCenterY + sideY;

  // console.log("left:", left);
  // console.log("top:", top);
  // console.log("right:", right);
  // console.log("bottom:", bottom);
  let commands = [
    // Pамка
    {
      AutoFillMethod: 1,
      _obj: "crop",
      angle: {
        _unit: "angleUnit",
        _value: 0.0,
      },
      cropAspectRatioModeKey: {
        _enum: "cropAspectRatioModeClass",
        _value: "targetSize",
      },
      cropFillMode: {
        _enum: "cropFillMode",
        _value: "defaultFill",
      },
      delete: true,
      to: {
        _obj: "rectangle",
        bottom: {
          _unit: "pixelsUnit",
          _value: bottom,
        },
        left: {
          _unit: "pixelsUnit",
          _value: left,
        },
        right: {
          _unit: "pixelsUnit",
          _value: right,
        },
        top: {
          _unit: "pixelsUnit",
          _value: top,
        },
      },
    },
  ];
  await require("photoshop").action.batchPlay(commands, {});
}

function findLayerRecursive(layers, targetName) {
  for (const layer of layers) {
    if (layer.name === targetName) {
      return layer;
    }

    if (layer.layers && layer.layers.length) {
      const found = findLayerRecursive(layer.layers, targetName);
      if (found) return found;
    }
  }

  return null;
}

function findAnyLayerByName(doc, targetName) {
  if (!doc) return null;
  return findLayerRecursive(doc.layers, targetName);
}

async function deleteLayerIfExists(layerName) {
  await core.executeAsModal(
    async () => {
      await deleteLayerIfExistsInCurrentModal(layerName);
    },
    { commandName: `CMF2PS: Delete ${layerName}` },
  );
}

async function deleteLayerIfExistsInCurrentModal(layerName) {
  const doc = app.activeDocument;
  if (!doc) return;

  const layer = findAnyLayerByName(doc, layerName);
  if (!layer) return;

  await action.batchPlay(
    [
      {
        _obj: "delete",
        _target: [
          {
            _ref: "layer",
            _id: layer.id,
          },
        ],
      },
    ],
    {
      synchronousExecution: true,
      modalBehavior: "execute",
    },
  );
}

async function resetTransform() {
  let commands = [
    // Сбросить преобразования
    {
      _obj: "placedLayerResetTransforms",
    },
  ];
  return await require("photoshop").action.batchPlay(commands, {});
}

//////////////// Функции InpaintMask

async function hasInpaintMaskChannel() {
  const { action } = require("photoshop");

  const result = await action.batchPlay(
    [
      {
        _obj: "get",
        _target: [
          {
            _ref: "channel",
            _name: "inpaintMask",
          },
        ],
      },
    ],
    {
      synchronousExecution: true,
    },
  );

  const item = result?.[0];

  if (!item) return false;
  if (item._obj === "error") return false;

  return true;
}

async function initInpaintMaskChannel() {
  const exists = await hasInpaintMaskChannel();
  console.log("initInpaintMaskChannel:", exists);
  if (exists) {
    inpaintMaskMod = true;
  } else {
    inpaintMaskMod = false;
  }
}

async function toggleInpaintMaskChannel() {
  const exists = await hasInpaintMaskChannel();
  console.log("toggleInpaintMaskChannel:", exists);
  if (exists) {
    inpaintMaskMod = false;
    return await deleteInpaintMaskChannel();
  } else {
    inpaintMaskMod = true;
    return await createInpaintMaskChannel();
  }
}

async function createInpaintMaskChannel() {
  const commands = [
    {
      _obj: "make",
      new: {
        _obj: "channel",
        name: "inpaintMask",
        color: {
          _obj: "RGBColor",
          red: 255.0,
          green: 0.0,
          blue: 0.0,
        },
        colorIndicates: {
          _enum: "maskIndicator",
          _value: "maskedAreas",
        },
        opacity: 50,
      },
    },
    {
      _obj: "show",
      null: [
        {
          _enum: "channel",
          _ref: "channel",
          _value: "red",
        },
        {
          _enum: "channel",
          _ref: "channel",
          _value: "grain",
        },
        {
          _enum: "channel",
          _ref: "channel",
          _value: "blue",
        },
      ],
    },
  ];

  return await require("photoshop").action.batchPlay(commands, {});
}

async function deleteInpaintMaskChannel() {
  const commands = [
    {
      _obj: "delete",
      _target: [
        {
          _ref: "channel",
          _name: "inpaintMask",
        },
      ],
    },
    {
      _obj: "show",
      null: [
        {
          _enum: "channel",
          _ref: "channel",
          _value: "red",
        },
        {
          _enum: "channel",
          _ref: "channel",
          _value: "grain",
        },
        {
          _enum: "channel",
          _ref: "channel",
          _value: "blue",
        },
      ],
    },
  ];

  return await require("photoshop").action.batchPlay(commands, {});
}

async function showAllLayers() {
  await core.executeAsModal(
    async () => {
      const doc = app.activeDocument;

      function revealRecursive(layers) {
        for (const layer of layers) {
          try {
            layer.visible = true;
          } catch (e) {}

          // если это группа — раскрываем детей тоже
          if (layer.layers && layer.layers.length) {
            revealRecursive(layer.layers);
          }
        }
      }

      revealRecursive(doc.layers);
    },
    { commandName: "Show All Layers" },
  );
}

function revealAllLayersInDocument(doc) {
  function revealRecursive(layers) {
    for (const layer of layers) {
      try {
        layer.visible = true;
      } catch (e) {}

      if (layer.layers && layer.layers.length) {
        revealRecursive(layer.layers);
      }
    }
  }

  revealRecursive(doc.layers);
}

async function isInpaintMaskEmpty() {
  return await core.executeAsModal(
    async () => {
      const doc = app.activeDocument;
      const ch = [...doc.channels].find((c) => c.name === "inpaintMask");
      if (!ch) return true; // канала нет -> считаем пустым

      const prevVisible = ch.visible;

      try {
        ch.visible = true; // histogram требует видимый канал
        const hist = ch.histogram || [];

        // hist[0] = полностью чёрные пиксели
        // если все пиксели только в нуле — канал пустой
        let nonZeroPixels = 0;
        for (let i = 1; i < hist.length; i++) {
          nonZeroPixels += hist[i] || 0;
        }

        return nonZeroPixels === 0;
      } finally {
        try {
          ch.visible = prevVisible;
        } catch (e) {}
      }
    },
    { commandName: "Check Inpaint Mask" },
  );
}

////////////////

async function setPPI72() {
  let commands = [
    // Pазмер изображения
    {
      _obj: "imageSize",
      resolution: {
        _unit: "densityUnit",
        _value: 72.0,
      },
    },
  ];
  return await require("photoshop").action.batchPlay(commands, {});
}

////////////////

async function restoreHistoryState(historyState) {
  const historyStateId = historyState?._id ?? historyState?.id;
  if (!historyStateId) return;

  await action.batchPlay(
    [
      {
        _obj: "select",
        _target: [
          {
            _ref: "historyState",
            _id: historyStateId,
          },
        ],
      },
    ],
    {},
  );
}

// Основной способ: открыть временную history-зону для операций снапшота.
// Она откатывается к текущему состоянию документа, даже если выделение не создало шаг истории.
async function suspendTemporaryHistory(executionContext, doc, name) {
  const hostControl = executionContext?.hostControl;
  if (!hostControl?.suspendHistory || !hostControl?.resumeHistory) {
    return null;
  }

  try {
    return await hostControl.suspendHistory({
      documentID: doc.id ?? doc._id,
      name,
    });
  } catch (e) {
    console.warn(
      "[CMF2PS] suspendHistory failed, using historyState fallback",
      e,
    );
    return null;
  }
}

// Закрываем временную history-зону с commit=false: все временные слои/кропы отменяются.
// Если suspendHistory недоступен, используем старый откат по historyState как запасной путь.
async function rollbackTemporaryHistory(
  executionContext,
  historySuspension,
  fallbackState,
) {
  if (historySuspension) {
    await executionContext.hostControl.resumeHistory(historySuspension, false);
    return;
  }

  await restoreHistoryState(fallbackState);
}

// Для apply/preview: все внутренние действия записываются в историю одним пунктом.
// commit=true сохраняет результат, но склеивает place/reset/mask/delete в один history state.
async function runAsSingleHistoryState(name, callback) {
  return await core.executeAsModal(
    async (executionContext) => {
      const historySuspension = await suspendTemporaryHistory(
        executionContext,
        app.activeDocument,
        name,
      );

      try {
        const result = await callback();
        if (historySuspension) {
          await executionContext.hostControl.resumeHistory(
            historySuspension,
            true,
          );
        }
        return result;
      } catch (e) {
        if (historySuspension) {
          await executionContext.hostControl.resumeHistory(
            historySuspension,
            false,
          );
        }
        throw e;
      }
    },
    { commandName: name },
  );
}

async function sendRef(sFilename, bAddRefItem, sRefresh) {
  return await core.executeAsModal(
    async () => {
      const folder = await fs.getDataFolder();
      // Сохраняем состояние
      const startState = app.activeDocument.activeHistoryState;
      let vPadding = maskPaddingValue;
      maskPaddingValue = 0;
      // 1) Экспорт
      await require("photoshop").action.batchPlay(commandsMakeRef, {});
      // 2) Кроп
      // const p3 = perfStart("Кроп perf");
      await layerPlusPaddingCrop();
      // perfEnd(p3);
      // 3) Cохраняем кроп
      // const p4 = perfStart("Cохраняем кроп perf");
      const entryImg = await folder.createFile("ref.png", {
        overwrite: true,
      });
      await app.activeDocument.saveAs.png(entryImg, { compression: 5 }, true);
      const imgBase64 = await entryToBase64(entryImg);
      if (bAddRefItem == true) {
        selectedRefIndex++;
        addRefItem("ref", imgBase64);
      }
      await pushRefToComfy(imgBase64, sFilename, sRefresh);
      console.log("saved to:", entryImg.nativePath);
      // perfEnd(p4);
      // 4) Возвращаем в исходное состояние
      maskPaddingValue = vPadding;
      await action.batchPlay(
        [
          {
            _obj: "select",
            _target: [
              {
                _ref: "historyState",
                _id: startState._id,
              },
            ],
          },
        ],
        {},
      );
    },
    { commandName: "CMF2PS Snapshot" },
  );
}

async function makeMaskAndSnapshot3(imgName, bInpaintMask) {
  return await core.executeAsModal(
    async (executionContext) => {
      const folder = await fs.getDataFolder();
      // Сохраняем состояние
      const startState = app.activeDocument.activeHistoryState;
      // activeHistoryState может не обновиться после простого перемещения выделения.
      // Поэтому временные действия снапшота лучше откатывать через suspendHistory.
      const historySuspension = await suspendTemporaryHistory(
        executionContext,
        app.activeDocument,
        "CMF2PS Snapshot",
      );
      // 1) Экспорт
      const p1 = perfStart("Экспорт");
      const p1b = perfStart("commandsMakeMaskMerge5p01");
      if (bInpaintMask == true && (await isInpaintMaskEmpty()) == false) {
        await require("photoshop").action.batchPlay(commandsSetRGB, {});
      }
      await require("photoshop").action.batchPlay(
        commandsMakeMaskMerge5p01,
        {},
      );
      perfEnd(p1b);
      console.log("isInpaintMaskEmpty:", await isInpaintMaskEmpty());
      if (bInpaintMask == true && (await isInpaintMaskEmpty()) == false) {
        // await require("photoshop").action.batchPlay(commandsFixBackgroundMMAS3, {});
        await require("photoshop").action.batchPlay(commandsAddInpaintMask, {});
      }
      await require("photoshop").action.batchPlay(
        commandsMakeMaskMerge5p02,
        {},
      );
      perfEnd(p1);
      // 2) Сохраняем маску
      const p2 = perfStart("Сохраняем маску");
      const entryMask = await folder.createFile("snapshot_mask.png", {
        overwrite: true,
      });
      await app.activeDocument.saveAs.png(entryMask, { compression: 5 }, true);
      imageMask = entryMask;
      perfEnd(p2);
      // 3) Кроп
      const p3 = perfStart("Кроп");
      await require("photoshop").action.batchPlay(
        commandsPrepareLayerToCropMMAS3,
        {},
      );
      await layerPlusPaddingCrop();

      const docCrop = app.activeDocument;
      snapshotSize = {
        width: Math.max(8, Math.floor(toPx(docCrop.width) / 8) * 8),
        height: Math.max(8, Math.floor(toPx(docCrop.height) / 8) * 8),
      };
      console.log("snapshotSize", snapshotSize);
      perfEnd(p3);
      // 4) Cохраняем кроп (это и есть clipboard-doc)
      const p4 = perfStart("Cохраняем кроп perf");
      const entryImg = await folder.createFile(imgName + ".png", {
        overwrite: true,
      });
      await app.activeDocument.saveAs.png(entryImg, { compression: 5 }, true);
      const imgBase64 = await entryToBase64(entryImg);
      await pushSnapshotToComfy(imgBase64);
      console.log("saved to:", entryImg.nativePath);
      perfEnd(p4);
      // 5.1) Генерация InpaintMask
      const p5 = perfStart("Генерация InpaintMask");
      if (bInpaintMask == true) {
        revealAllLayersInDocument(app.activeDocument);
        await require("photoshop").action.batchPlay(
          commandsMakeInpaintMaskMMAS3,
          {},
        );

        // 5.2)Сохраняем InpaintMask
        const entryInpaintMask = await folder.createFile("mask.png", {
          overwrite: true,
        });
        await app.activeDocument.saveAs.png(
          entryInpaintMask,
          { compression: 5 },
          true,
        );
        const inpaintMaskBase64 = await entryToBase64(entryInpaintMask);
        await pushInpaintMaskToComfy(inpaintMaskBase64);
      }
      perfEnd(p5);
      // Возвращаем документ к состоянию на момент запуска снапшота,
      // не откатывая новое положение выделения к старому historyState.
      await rollbackTemporaryHistory(
        executionContext,
        historySuspension,
        startState,
      );
      return;
    },
    { commandName: "CMF2PS Snapshot" },
  );
}

async function exportSnapshotMask() {
  return await core.executeAsModal(
    async () => {
      const folder = await fs.getDataFolder();
      // Сохраняем состояние
      const startState = app.activeDocument.activeHistoryState;
      // 1) Экспорт
      const p1 = perfStart("Экспорт");
      await require("photoshop").action.batchPlay(
        commandsMakeMaskMerge5p01,
        {},
      );
      await require("photoshop").action.batchPlay(
        commandsMakeMaskMerge5p02,
        {},
      );
      const docCrop = app.activeDocument;
      snapshotSize = {
        width: Math.max(8, Math.floor(toPx(docCrop.width) / 8) * 8),
        height: Math.max(8, Math.floor(toPx(docCrop.height) / 8) * 8),
      };
      // 2) Сохраняем маску
      const p2 = perfStart("Сохраняем маску");
      const entryMask = await folder.createFile("snapshot_mask.png", {
        overwrite: true,
      });
      await app.activeDocument.saveAs.png(entryMask, { compression: 5 }, true);
      imageMask = entryMask;
      perfEnd(p2);
      // 6) Возвращаем в исходное состояние
      await action.batchPlay(
        [
          {
            _obj: "select",
            _target: [
              {
                _ref: "historyState",
                _id: startState._id,
              },
            ],
          },
        ],
        {},
      );
    },
    { commandName: "CMF2PS Snapshot" },
  );
}

function ensureComfyLoaded() {
  document.addEventListener("DOMContentLoaded", () => {
    const wv = document.getElementById("comfyWeb");
    wv.src = `http://127.0.0.1:8188/?cmf2ps_client=${encodeURIComponent(UI_CLIENT_ID)}`;
  });
}

async function runWorkflow() {
  try {
    // 1. Загружаем workflow json
    const response = await fetch("workflow\\workflow_template_api.json");
    const workflow = await response.json();
    // 2. Отправляем в ComfyUI
    const comfyResponse = await fetch("http://127.0.0.1:8188/prompt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: workflow,
        client_id: "ps",
      }),
    });
    const result = await comfyResponse.json();
    console.log("ComfyUI response:", result);
  } catch (err) {
    console.error("ComfyUI error:", err);
  }
}

//=====================================

/** base64 (без data:image/png;base64,) -> Uint8Array */
function base64ToUint8Array(base64) {
  // на случай если прилетит dataURL
  const clear = base64.includes(",") ? base64.split(",").pop() : base64;

  const binary = atob(clear);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function writeTempPng(bytes, filename = "_temp.png") {
  const dataFolder = await fs.getDataFolder();
  const file = await dataFolder.createFile(filename, { overwrite: true });
  await file.write(bytes, { format: formats.binary });
  return file;
}

async function selectLayer() {
  await core.executeAsModal(async () => {
    const doc = app.activeDocument;
    const layer = doc.activeLayers[0];

    await doc.selection.load(layer);
  });
}

async function blurMask(vBlur) {
  let commands = [
    // Выделение маска канал
    {
      _obj: "select",
      _target: [
        {
          _enum: "channel",
          _ref: "channel",
          _value: "mask",
        },
      ],
      makeVisible: false,
    },
    // Задать текущ. слой
    {
      _obj: "set",
      _target: [
        {
          _enum: "ordinal",
          _ref: "layer",
          _value: "targetEnum",
        },
      ],
      to: {
        _obj: "layer",
        userMaskFeather: {
          _unit: "pixelsUnit",
          _value: vBlur,
        },
      },
    },
  ];
  return await require("photoshop").action.batchPlay(commands, {});
}

async function maskPaddingMinus(vPadding) {
  let commands = [
    // Сжать
    {
      _obj: "contract",
      by: {
        _unit: "pixelsUnit",
        _value: vPadding,
      },
      selectionModifyEffectAtCanvasBounds: false,
    },
  ];
  return await require("photoshop").action.batchPlay(commands, {});
}

async function selectMask() {
  await require("photoshop").action.batchPlay(commandNewLayerTemp, {});
  await require("photoshop").action.batchPlay(commandsMaskFromImage, {});
  await require("photoshop").action.batchPlay(commandsSelectMask, {});
  await require("photoshop").action.batchPlay(commandDelLayer, {});
}

async function applyMaskMacros() {
  let commands = [
    // Сделать
    {
      _obj: "make",
      at: {
        _enum: "channel",
        _ref: "channel",
        _value: "mask",
      },
      new: {
        _class: "channel",
      },
      using: {
        _enum: "userMaskEnabled",
        _value: "revealSelection",
      },
    },
  ];
  return await require("photoshop").action.batchPlay(commands, {});
}

async function appendMask_new() {
  // await require("photoshop").action.batchPlay(commandsMaskFromImage, {});
  await require("photoshop").action.batchPlay(commandSelectMaskDownLayer, {});
  // await require("photoshop").action.batchPlay(commandSelectMaskCurrent, {});
  // await require("photoshop").action.batchPlay(commandSelDown, {});
  await require("photoshop").action.batchPlay(commandDelLayer, {});
  await require("photoshop").action.batchPlay(commandSelUp, {});
  await require("photoshop").action.batchPlay(commandApplyMask2, {});

  // console.log("maskBlurValue", maskBlurValue);
  if (maskBlurValue != 0) {
    await blurMask(maskBlurValue);
  }
}

async function appendMask() {
  await require("photoshop").action.batchPlay(commandsMaskFromImage, {});
  await require("photoshop").action.batchPlay(commandsSelectMask, {});
  await require("photoshop").action.batchPlay(commandSelDown, {});
  await require("photoshop").action.batchPlay(commandDelLayer, {});
  await require("photoshop").action.batchPlay(commandSelUp, {});

  console.log("maskBlurValue", maskBlurValue);
  await blurMask(maskBlurValue);
}

async function delTempMask() {
  await require("photoshop").action.batchPlay(commandSelDown, {});
  await require("photoshop").action.batchPlay(commandDelLayer, {});
  await require("photoshop").action.batchPlay(commandSelUp, {});
}

function toPx(v) {
  if (typeof v === "number") return v;
  if (v && typeof v._value === "number") return v._value;
  return Number(v) || 0;
}

async function getImageSize(fileEntry) {
  const prevDoc = app.activeDocument;

  const doc = await app.open(fileEntry);
  // imgPPI = app.activeDocument.resolution;
  try {
    return {
      width: Math.round(toPx(doc.width)),
      height: Math.round(toPx(doc.height)),
    };
  } finally {
    await doc.closeWithoutSaving();
    if (prevDoc) {
      // app.activeDocument = prevDoc;
    }
  }
}

function getSelectionCenter() {
  const b = app.activeDocument.selection.bounds;

  const left = toPx(b.left);
  const top = toPx(b.top);
  const right = toPx(b.right);
  const bottom = toPx(b.bottom);

  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}

async function getResizeDuringPlace() {
  const [prefs] = await action.batchPlay(
    [
      {
        _obj: "get",
        _target: [
          { _property: "generalPreferences" },
          { _ref: "application", _enum: "ordinal", _value: "targetEnum" },
        ],
      },
    ],
    { synchronousExecution: true, modalBehavior: "execute" },
  );
  return !!(
    prefs.resizePastePlace ?? prefs.generalPreferences?.resizePastePlace
  );
}

async function setResizeDuringPlace(enabled) {
  await action.batchPlay(
    [
      {
        _obj: "set",
        _target: [
          { _property: "generalPreferences" },
          { _ref: "application", _enum: "ordinal", _value: "targetEnum" },
        ],
        to: {
          _obj: "generalPreferences",
          resizePastePlace: !!enabled,
        },
      },
    ],
    { synchronousExecution: true, modalBehavior: "execute" },
  );
}

// Открыть PNG и задублировать слой в исходный документ с коррекцией трансформации
async function openImgInPS2(bytes, nameLayer, imgWidth, imgHeight) {
  const file = await writeTempPng(bytes, nameLayer);
  const targetDoc = app.activeDocument;
  const docPPI = app.activeDocument.resolution;
  const ppiFactor = docPPI / 72;

  const docW = Math.round(toPx(targetDoc.width));
  const docH = Math.round(toPx(targetDoc.height));
  const sel = getSelectionCenter();

  const autoFit = Math.min(
    1,
    docW / snapshotSize.width,
    docH / snapshotSize.height,
  );
  const correction = ((1 / autoFit) * 100) / ppiFactor;
  let correctionWidth = correction;
  let correctionHeight = correction;
  if (
    snapshotSize.width != imgWidth &&
    snapshotSize.height != imgHeight &&
    bResizeLayer == true
  ) {
    correctionWidth = correction * (snapshotSize.width / imgWidth);
    correctionHeight = correction * (snapshotSize.height / imgHeight);
  }

  const prevResizeDuringPlace = await getResizeDuringPlace();
  await setResizeDuringPlace(false);

  // console.log("[CMF2PS] imgPPI", imgPPI);
  // console.log("[CMF2PS] docPPI", docPPI);
  // console.log("[CMF2PS] imgWidth", imgWidth);
  // console.log("[CMF2PS] imgHeight", imgHeight);
  // console.log("[CMF2PS] snapshotSize", snapshotSize);
  // console.log("[CMF2PS] docSize", { width: docW, height: docH });
  // console.log("[CMF2PS] selection", sel);
  // console.log("[CMF2PS] autoFit", autoFit);
  // console.log("[CMF2PS] correctionWidth", correctionWidth);
  // console.log("[CMF2PS] correctionHeight", correctionHeight);

  const token = await fs.createSessionToken(file);

  const res = await action.batchPlay(
    [
      {
        _obj: "placeEvent",
        null: {
          _kind: "local",
          _path: token,
        },
        linked: false,
        freeTransformCenterState: {
          _enum: "quadCenterState",
          _value: "QCSAverage",
        },
        width: {
          _unit: "percentUnit",
          _value: correctionWidth,
        },
        height: {
          _unit: "percentUnit",
          _value: correctionHeight,
        },
        _options: {
          dialogOptions: "dontDisplay",
        },
      },
    ],
    {
      synchronousExecution: true,
      modalBehavior: "execute",
    },
  );
  setResizeDuringPlace(prevResizeDuringPlace);
  console.log("[CMF2PS] placeEvent result", res);
}

// Открыть PNG и задублировать слой в исходный документ
async function openImgInPS(bytes, nameLayer) {
  const file = await writeTempPng(bytes, nameLayer);
  if (app.documents.length === 0) {
    await app.open(file);
    return;
  }

  const targetDoc = app.activeDocument;
  const token = await fs.createSessionToken(file);
  app.activeDocument = targetDoc;

  const res = await action.batchPlay(
    [
      {
        _obj: "placeEvent",
        target: { _path: token, _kind: "local" },
        _options: { dialogOptions: "dontDisplay" },
      },
    ],
    { synchronousExecution: true, modalBehavior: "execute" },
  );
  console.log("[CMF2PS] placeEvent result:", res);
}

///////// Функции для превью:

function addPreviewItem(filename, data, width, height) {
  previewItems.push({ filename, data, width, height });

  if (selectedPreviewIndex === -1) {
    selectedPreviewIndex = 0;
  }

  renderPreviewList();
}

function clearPreview() {
  previewItems = [];
  selectedPreviewIndex = -1;
  renderPreviewList();
}

function getPreviewLists() {
  return [
    document.getElementById("previewList"),
    document.getElementById("previewListCompact"),
  ].filter(Boolean);
}

function renderPreviewList() {
  const lists = getPreviewLists();

  lists.forEach((list) => {
    list.innerHTML = "";

    previewItems.forEach((item, index) => {
      const wrap = document.createElement("div");
      wrap.className =
        "preview-item" + (index === selectedPreviewIndex ? " selected" : "");

      const img = document.createElement("img");
      img.className = "preview-thumb";
      img.src = `data:image/png;base64,${item.data}`;

      wrap.appendChild(img);

      wrap.addEventListener("click", async () => {
        selectedPreviewIndex = index;
        console.log("selectedPreviewIndex", selectedPreviewIndex);
        await addPreviewLayer();
        renderPreviewList();
      });

      list.appendChild(wrap);
    });
  });
}

/////////
///////// Дубликат для рефов:

function addRefItem(filename, data) {
  refItems.push({ filename, data });

  if (selectedRefIndex === -1) {
    selectedRefIndex = 0;
  }

  renderRefList();
}

function clearRef() {
  refItems = [];
  selectedRefIndex = -1;
  renderRefList();
}

function renderRefList() {
  const list = document.getElementById("previewRef");
  if (!list) return;

  list.innerHTML = "";

  refItems.forEach((item, index) => {
    const wrap = document.createElement("div");
    wrap.className =
      "preview-item" + (index === selectedRefIndex ? " selected" : "");

    const img = document.createElement("img");
    img.className = "preview-thumb";
    img.src = `data:image/png;base64,${item.data}`;
    wrap.appendChild(img);

    wrap.addEventListener("click", async () => {
      selectedRefIndex = index;
      renderRefList();
      let item = refItems[selectedRefIndex];
      await pushRefToComfy(item.data, "_cmf2ps/ref.png", "none");
    });

    list.appendChild(wrap);
  });
}

/////////

function uint8ToBase64(u8) {
  // безопасный вариант без переполнения стека
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function entryToBase64(entry) {
  const ab = await entry.read({ format: storage.formats.binary }); // ArrayBuffer
  const u8 = ab instanceof ArrayBuffer ? new Uint8Array(ab) : ab; // на всякий случай
  const b64 = uint8ToBase64(u8);

  console.log("[CMF2PS] base64 length:", b64.length);
  return b64;
}

async function pushSnapshotToComfy(b64) {
  const r = await fetch("http://127.0.0.1:8188/cmf2ps/push_image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "ps",
      filename: "snapshot.png",
      png_base64: b64,
    }),
  });
  const j = await r.json().catch(() => ({}));
  console.log("[CMF2PS] push_image:", r.status, j);
  return j;
}

async function pushInpaintMaskToComfy(b64) {
  const r = await fetch("http://127.0.0.1:8188/cmf2ps/push_mask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "ps",
      filename: "mask.png",
      png_base64: b64,
    }),
  });
  const j = await r.json().catch(() => ({}));
  console.log("[CMF2PS] push_mask:", r.status, j);
  return j;
}

async function pushRefToComfy(b64, sFilename, sRefresh) {
  const r = await fetch("http://127.0.0.1:8188/cmf2ps/push_ref", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "ps",
      target_client_id: UI_CLIENT_ID,
      filename: sFilename,
      png_base64: b64,
      refresh_mode: sRefresh,
      delete_item: false,
    }),
  });
  const j = await r.json().catch(() => ({}));
  console.log("[CMF2PS] push_ref:", r.status, j);
  return j;
}

async function waitForUiClient(timeoutMs = 5000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch("http://127.0.0.1:8188/cmf2ps/clients");
      const j = await r.json();

      const found =
        Array.isArray(j.clients) &&
        j.clients.some(
          (c) => c.client_id === UI_CLIENT_ID && c.platform === "ui",
        );

      if (found) return true;
    } catch (e) {
      // ignore
    }

    await new Promise((res) => setTimeout(res, 300));
  }

  return false;
}

///////// Вызовы вебсокета

async function handleWsMessage(msg) {
  // Все сообщения проходят через эту функцию строго по очереди.
  if (msg.type === "init") {
    const uiReady = await waitForUiClient(5000);
    if (!uiReady) {
      console.warn("[CMF2PS] UI client is not connected after Comfy restart");
      return;
    }
    console.log("[CMF2PS] init:", msg);
    await require("photoshop").core.executeAsModal(initInpaintMaskChannel, {
      commandName: "Action Commands",
    });
    bImageState = true;
    return;
  }

  if (msg.type === "preview_item") {
    // Несколько preview_item могут прийти почти одновременно, но очередь выше
    // гарантирует, что этот блок выполнится только для одного сообщения за раз.
    if (bSnapshot == false) {
      if ((await hasSelection()) == false) {
        await require("photoshop").core.executeAsModal(selectAll, {
          commandName: "Action Commands",
        });
      }
      await exportSnapshotMask();
      bSnapshot = true;
    }
    let docPPI = app.activeDocument.resolution;
    if (docPPI != imgPPI) {
      await require("photoshop").core.executeAsModal(setPPI72, {});
    }
    console.log("docPPI", docPPI);
    //
    // selectedPreviewIndex++;
    if (bSnapshot == true) {
      addPreviewItem(msg.filename, msg.data, msg.width, msg.height);

      console.log("msg.width", msg.width);
      console.log("msg.height", msg.height);
      // console.log("msg.data", msg.data);
      if (firstRender == true) {
        console.log("firstRender");
        await addPreviewLayer();
      } else if (bAutoUpdatePreview == true) {
        selectedPreviewIndex = previewItems.length - 1;
        renderPreviewList();
        await addPreviewLayer();
      }
    }
    return;
  }

  if (msg.type === "preview_done") {
    console.log("[CMF2PS] preview batch complete");
    return;
  }

  if (msg.type === "error") {
    console.warn("[CMF2PS] backend error:", msg.message || msg);
    return;
  }

  console.log("[CMF2PS] message:", msg);
}

// Очередь запросов

function enqueueWsMessage(msg) {
  // Добавляем сообщение в цепочку Promise, сохраняя порядок прихода из WebSocket.
  wsMessageQueue = wsMessageQueue
    .then(() => handleWsMessage(msg))
    .catch((e) => {
      console.warn("[CMF2PS] message handler failed:", e, msg);
    });
}

function connectWs() {
  if (isConnecting) return;
  isConnecting = true;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    isConnecting = false;
    console.log("[CMF2PS] WS connected");
    ws.send(JSON.stringify({ type: "hello" }));
    // можно ping
    ws.send(JSON.stringify({ type: "ping" }));
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      enqueueWsMessage(msg);
    } catch (e) {
      console.warn("[CMF2PS] bad message:", e, ev.data);
    }
  };

  ws.onerror = (e) => {
    isConnecting = false;
    console.warn("[CMF2PS] WS error:", e);
  };

  ws.onclose = () => {
    isConnecting = false;
    console.warn("[CMF2PS] WS closed, reconnect in 1s");
    setTimeout(connectWs, 1000);
  };
}

// вызов при старте
connectWs();
ensureComfyLoaded();
initControls();
