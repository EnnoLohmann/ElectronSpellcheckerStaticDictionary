import ContextMenuBuilder from './context-menu-builder';
import ContextMenuListener from './context-menu-listener';
import SpellCheckHandler from './spell-check-handler';

/**
 * Overrides the default logging function (the `debug` library) with another
 * logger.
 *
 * @param {Function}  fn    The `console.log` like function that will write debug
 *                          information to.
 */
function setGlobalLogger(fn) {
  for (let klass of [ContextMenuBuilder, ContextMenuListener, SpellCheckHandler]) {
    klass.setLogger(fn);
  }
}

module.exports = {
  ContextMenuBuilder,
  ContextMenuListener,
  SpellCheckHandler,
  setGlobalLogger,
};
