window.CMF2PS_LOCALES = window.CMF2PS_LOCALES || {};

window.CMF2PS_LOCALES.en = {
  actions: {
    setSelection: "Set Selection",
    generate: "Generate",
    inpaintMaskMode: "InpaintMask Mode",
    addRef: "Add Ref",
    send: "Send",
    applySelected: "Apply Selected",
    installBackend: "Install Backend and Nodes",
  },
  labels: {
    aspect: "Aspect:",
    base: "Base",
    layerPadding: "Layer Padding +",
    resizeLayer: "Scale Layer",
    applyMask: "Mask Layer",
    feather: "Feather",
    refNode: "Ref Node:",
    refFolder: "Ref Folder:",
    previewWindow: "Preview Window",
    interface: "Interface",
    language: "Language(Beta)",
    languageRu: "Russian",
    languageEn: "English(Beta)",
    twoLevelLayout: "Two-Level Layout",
    about: "About",
  },
  hints: {
    twoLevelLayout: "Moves the preview window into a separate right column.",
  },
  placeholders: {
    refFilename: "File name.png",
    backendPath: "custom_nodes folder is not selected",
  },
  titles: {
    setSelection:
      "Select a rectangle using prepared presets. It can be centered in the document, current selection, or current layer",
    selectInDocumentCenter: "Selection centered in the document",
    selectInSelectionCenter: "Selection centered in the current selection / layer",
    generate: "Send the selection to comfy and start generation",
    inpaintMaskMode:
      "Toggle InpaintMask mode - painting an additional mask for direct use in generation by supported models",
    clearPreview: "Clear preview",
    refFilename: "File name",
    sendRefToFolder: "Send the selected area or document to the ComfyUI\\input folder",
    deleteRefFromFolder: "Delete a file by name from the ComfyUI\\input folder",
    settings: "Settings",
    browse: "Browse",
  },
};
