const commandsMakeMaskMerge5p01 = [
  // Выполнить сведение
  {
    _obj: "flattenImage",
  },
  // Сделать слой-заливка
  {
    _obj: "make",
    _target: [
      {
        _ref: "contentLayer",
      },
    ],
    using: {
      _obj: "contentLayer",
      type: {
        _obj: "solidColorLayer",
        color: {
          _obj: "RGBColor",
          blue: 255.0,
          grain: 255.0,
          red: 255.0,
        },
      },
    },
  },
  // Сделать слой-заливка
  {
    _obj: "make",
    _target: [
      {
        _ref: "contentLayer",
      },
    ],
    using: {
      _obj: "contentLayer",
      type: {
        _obj: "solidColorLayer",
        color: {
          _obj: "RGBColor",
          blue: 0.0,
          grain: 0.0,
          red: 0.0,
        },
      },
    },
  },
  // Выделение назад слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "backwardEnum",
      },
    ],
    makeVisible: false,
  },
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
  // Задать Выделение
  {
    _obj: "set",
    _target: [
      {
        _property: "selection",
        _ref: "channel",
      },
    ],
    maskParameters: true,
    to: {
      _enum: "ordinal",
      _ref: "channel",
      _value: "targetEnum",
    },
    version: 1,
  },
  // Выделение назад слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "backwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Kопировать
  {
    _obj: "copyEvent",
    copyHint: "pixels",
  },
  // Вставить
  {
    _obj: "paste",
    antiAlias: {
      _enum: "antiAliasType",
      _value: "antiAliasNone",
    },
    as: {
      _class: "pixel",
    },
    inPlace: true,
  },
];

const commandsMakeMaskMerge5p02 = [
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Перемещение текущ. слой
  {
    _obj: "move",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
    to: {
      _enum: "ordinal",
      _ref: "layer",
      _value: "next",
    },
  },
];

const commandsFixBackground = [
  // Сделать слой-заливка
  {
    _obj: "make",
    _target: [
      {
        _ref: "contentLayer",
      },
    ],
    using: {
      _obj: "contentLayer",
      type: {
        _obj: "solidColorLayer",
        color: {
          _obj: "RGBColor",
          blue: 123.0,
          grain: 123.0,
          red: 123.0,
        },
      },
    },
  },
  // Перемещение текущ. слой
  {
    _obj: "move",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
    to: {
      _enum: "ordinal",
      _ref: "layer",
      _value: "previous",
    },
  },
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],

    makeVisible: false,
    selectionModifier: {
      _enum: "selectionModifierType",
      _value: "addToSelection",
    },
  },
  // Объединить слои
  {
    _obj: "mergeLayersNew",
  },
];

const commandsFixBackgroundMMAS3 = [
  // Выделение назад слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "backwardEnum",
      },
    ],

    makeVisible: false,
  },
  // Задать Фон
  {
    _obj: "set",
    _target: [
      {
        _property: "background",
        _ref: "layer",
      },
    ],

    to: {
      _obj: "layer",
      mode: {
        _enum: "blendMode",
        _value: "normal",
      },
      opacity: {
        _unit: "percentUnit",
        _value: 100.0,
      },
    },
  },
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],

    makeVisible: false,
  },
];

const commandsAddInpaintMask = [
  // Выделение канал "inpaintMask"
  {
    _obj: "select",
    _target: [
      {
        _name: "inpaintMask",
        _ref: "channel",
      },
    ],
  },
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
      _ref: "channel",
      _value: "targetEnum",
    },
  },
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

const commandsSetRGB = [
  // Выделение RGB канал
  {
    _obj: "select",
    _target: [
      {
        _enum: "channel",
        _ref: "channel",
        _value: "RGB",
      },
    ],
  },
];

const commandsPrepareLayerToCrop = [
  // Скрыть текущ. слой
  {
    _obj: "hide",
    null: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
  },
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],
    layerID: [4],
    makeVisible: false,
  },
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
  // Задать Выделение
  {
    _obj: "set",
    _target: [
      {
        _property: "selection",
        _ref: "channel",
      },
    ],
    maskParameters: true,
    to: {
      _enum: "ordinal",
      _ref: "channel",
      _value: "targetEnum",
    },
    version: 1,
  },
  // Скрыть текущ. слой
  {
    _obj: "hide",
    null: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
  },
];

const commandsPrepareLayerToCropMMAS3 = [
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
      _enum: "channel",
      _ref: "channel",
      _value: "RGB",
    },
  },
  // Скрыть текущ. слой
  {
    _obj: "hide",
    null: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
  },
  // Выделение назад слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "backwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Скрыть текущ. слой
  {
    _obj: "hide",
    null: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
  },
  // Выделение назад слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "backwardEnum",
      },
    ],
    makeVisible: false,
  },
];

const commandsMakeInpaintMask = [
  // Выделение назад слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "backwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Перемещение текущ. слой
  {
    _obj: "move",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
    to: {
      _enum: "ordinal",
      _ref: "layer",
      _value: "previous",
    },
  },
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Создать обтравочную маску текущ. слой
  {
    _obj: "groupEvent",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
  },
];

const commandsMakeInpaintMaskMMAS3 = [
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Перемещение текущ. слой
  {
    _obj: "move",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
    to: {
      _enum: "ordinal",
      _ref: "layer",
      _value: "previous",
    },
  },
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],
    makeVisible: false,
  },
  // Создать обтравочную маску текущ. слой
  {
    _obj: "groupEvent",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
  },
];

const commandsMakeRef = [
  // Сделать слой
  {
    _obj: "make",
    _target: [
      {
        _ref: "layer",
      },
    ],
  },
  // Объединить видимые
  {
    _obj: "mergeVisible",
    duplicate: true,
  },
  // Kопировать
  {
    _obj: "copyEvent",
    copyHint: "pixels",
  },
  // Вставить
  {
    _obj: "paste",
    antiAlias: {
      _enum: "antiAliasType",
      _value: "antiAliasNone",
    },
    as: {
      _class: "pixel",
    },
    inPlace: true,
  },
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
      _enum: "channel",
      _ref: "channel",
      _value: "transparencyEnum",
    },
  },
];

/////////// Макросы работы с маской

const commandsSendBitmapToMask = [
  // Выделение назад слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "backwardEnum",
      },
    ],
    makeVisible: false,
  },
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
  // Kопировать
  {
    _obj: "copyEvent",
    copyHint: "pixels",
  },
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],

    makeVisible: false,
  },
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
  // Показать текущ. канал
  {
    _obj: "show",
    null: [
      {
        _enum: "ordinal",
        _ref: "channel",
        _value: "targetEnum",
      },
    ],
  },
  // Вставить
  {
    _obj: "paste",
    antiAlias: {
      _enum: "antiAliasType",
      _value: "antiAliasNone",
    },
    as: {
      _class: "pixel",
    },
    inPlace: true,
  },
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
      _ref: "channel",
      _value: "targetEnum",
    },
  },
  // Выделение RGB канал
  {
    _obj: "select",
    _target: [
      {
        _enum: "channel",
        _ref: "channel",
        _value: "RGB",
      },
    ],
    makeVisible: false,
  },
];

const commandApplyMask = [
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
      _value: "revealAll",
    },
  },
];

const commandSelDown = [
  // Выделение назад слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "backwardEnum",
      },
    ],
    makeVisible: false,
  },
];

const commandSelUp = [
  // Выделение вперед слой
  {
    _obj: "select",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "forwardEnum",
      },
    ],
    makeVisible: false,
  },
];
const commandDelLayer = [
  // Удалить текущ. слой
  {
    _obj: "delete",
    _target: [
      {
        _enum: "ordinal",
        _ref: "layer",
        _value: "targetEnum",
      },
    ],
  },
];

module.exports = {
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
  commandsSendBitmapToMask,
  commandApplyMask,
  commandSelDown,
  commandSelUp,
  commandDelLayer,
};
