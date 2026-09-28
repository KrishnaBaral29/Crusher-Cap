// geetest page script hook
(function () {
  'use strict';

  // optimize canvas readback performance
  try {
    const _getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type === '2d') {
        options = Object.assign({}, options, { willReadFrequently: true });
      }
      return _getContext.call(this, type, options);
    };
  } catch (_) {}

  // expose synthetic event marker
  try {
    Object.defineProperty(window, '__CC_SYNTHETIC_MARKER__', {
      value: '__cc_synthetic__',
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (_) {}
})();
