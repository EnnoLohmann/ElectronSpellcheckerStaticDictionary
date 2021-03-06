import { requireTaskPool } from 'electron-remote';
import LRU from 'lru-cache';

import { Subscription } from 'rxjs/Subscription';
import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import SerialSubscription from 'rxjs-serial-subscription';

import 'rxjs/add/observable/defer';
import 'rxjs/add/observable/empty';
import 'rxjs/add/observable/fromEvent';
import 'rxjs/add/observable/fromPromise';
import 'rxjs/add/observable/of';

import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/concat';
import 'rxjs/add/operator/concatMap';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/merge';
import 'rxjs/add/operator/observeOn';
import 'rxjs/add/operator/reduce';
import 'rxjs/add/operator/startWith';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/takeUntil';
import 'rxjs/add/operator/throttle';
import 'rxjs/add/operator/toPromise';

import './custom-operators';

import { SpellCheckerProvider } from 'electron-hunspell';
import { normalizeLanguageCode } from './utility';

let Spellchecker;
let concatenate = require('concatenate');
let d = require('debug')('electron-spellchecker:spell-check-handler');

let fallbackLocaleTable = null;
let webFrame = (process.type === 'renderer' ?
  require('electron').webFrame :
  null);

// NB: Linux and Windows uses underscore in languages (i.e. 'en_US'), whereas
// we're trying really hard to match the Chromium way of `en-US`
const validLangCodeWindowsLinux = /[a-z]{2}[_][A-Z]{2}/;

const isMac = process.platform === 'darwin';

const alternatesTable = {};

const dictionaryPath = './assets/dictionaries/';

/**
 * This method mimics Observable.fromEvent, but with capture semantics.
 */
function fromEventCapture(element, name) {
  return Observable.create((subj) => {
    const handler = function (...args) {
      if (args.length > 1) {
        subj.next(args);
      } else {
        subj.next(args[0] || true);
      }
    };

    element.addEventListener(name, handler, true);
    return new Subscription(() => element.removeEventListener(name, handler, true));
  });
}

/**
 * SpellCheckHandler is the main class of this library, and handles all of the
 * different pieces of spell checking except for the context menu information.
 *
 * Instantiate the class, then call {{attachToInput}} to wire it up. The spell
 * checker will attempt to automatically check the language that the user is
 * typing in and switch on-the fly. However, giving it an explicit hint by
 * calling {{switchLanguage}}, or providing it a block of sample text via
 * {{provideHintText}} will result in much better results.
 *
 * Sample text should be text that is reasonably likely to be in the same language
 * as the user typing - for example, in an Email reply box, the original Email text
 * would be a great sample, or in the case of Slack, the existing channel messages
 * are used as the sample text.
 */
export default class SpellCheckHandler {
  /**
   * Constructs a SpellCheckHandler
   * @param  {LocalStorage} localStorage      Deprecated.
   * @param  {Scheduler} scheduler            The Rx scheduler to use, for
   *                                          testing.
   */
  constructor(localStorage = null, scheduler = null) {
    // NB: Require here so that consumers can handle native module exceptions.

    this.switchToLanguage = new Subject();
    this.currentSpellchecker = null;
    this.currentSpellcheckerLanguage = null;
    this.currentSpellcheckerChanged = new Subject();
    this.spellCheckInvoked = new Subject();
    this.spellingErrorOccurred = new Subject();
    this.isMisspelledCache = new LRU({
      max: 512, maxAge: 4 * 1000
    });

    this.scheduler = scheduler;
    this.shouldAutoCorrect = true;

    this.disp = new SerialSubscription();

    if (isMac) {
      // NB: OS X does automatic language detection, we're gonna trust it
      this.currentSpellchecker = new SpellCheckerProvider();
      this.currentSpellcheckerLanguage = 'de-DE';

      if (webFrame) {
        webFrame.setSpellCheckProvider(
          this.currentSpellcheckerLanguage,
          this.shouldAutoCorrect,
          { spellCheck: this.handleElectronSpellCheck.bind(this) });
      }
      return;
    }
  }

  /**
   * Disconnect the events that we connected in {{attachToInput}} or other places
   * in the class.
   */
  unsubscribe() {
    this.disp.unsubscribe();
  }

  /**
   * Override the default logger for this class. You probably want to use
   * {{setGlobalLogger}} instead
   *
   * @param {Function} fn   The function which will operate like console.log
   */
  static setLogger(fn) {
    d = fn;
  }

  /**
   * Attach to document.body and register ourselves for Electron spell checking.
   * This method will start to watch text entered by the user and automatically
   * switch languages as well as enable Electron spell checking (i.e. the red
   * squigglies).
   *
   * @param  {Observable<String>} inputText     Simulate the user typing text,
   *                                            for testing.
   *
   * @return {Disposable}       A Disposable which will unregister all of the
   *                            things that this method registered.
   */
  attachToInput(inputText = null) {
    let possiblySwitchedCharacterSets = new Subject();
    let wordsTyped = 0;

    if (!inputText && !document.body) {
      throw new Error("document.body is null, if you're calling this in a preload script you need to wrap it in a setTimeout");
    }

    let input = inputText || (fromEventCapture(document.body, 'input')
      .mergeMap((e) => {
        if (!e.target || !e.target.value) return Observable.empty();
        if (e.target.value.match(/\S\s$/)) {
          wordsTyped++;
        }

        if (wordsTyped > 2) {
          d(`${wordsTyped} words typed without spell checking invoked, redetecting language`);
          possiblySwitchedCharacterSets.next(true);
        }

        return Observable.of(e.target.value);
      }));
  }

  /**
   * autoUnloadDictionariesOnBlur attempts to save memory by unloading
   * dictionaries when the window loses focus.
   *
   * @return {Disposable}   A {{Disposable}} that will unhook the events listened
   *                        to by this method.
   */
  autoUnloadDictionariesOnBlur() {
    let ret = new Subscription();
    let hasUnloaded = false;

    if (isMac) return Subscription.EMPTY;

    ret.add(Observable.fromEvent(window, 'blur').subscribe(() => {
      d(`Unloading spellchecker`);
      this.currentSpellchecker = null;
      hasUnloaded = true;
    }));

    ret.add(Observable.fromEvent(window, 'focus').mergeMap(() => {
      if (!hasUnloaded) return Observable.empty();
      if (!this.currentSpellcheckerLanguage) return Observable.empty();

      d(`Restoring spellchecker`);
      return Observable.fromPromise(this.switchLanguage(this.currentSpellcheckerLanguage))
        .catch((e) => {
          d(`Failed to restore spellchecker: ${e.message}`);
          return Observable.empty();
        });
    }).subscribe());

    return ret;
  }

  /**
   * Explicitly switch the language to a specific language. This method will
   * automatically download the dictionary for the specific language and locale
   * and on failure, will attempt to switch to dictionaries that are the same
   * language but a default locale.
   *
   * @param  {String} langCode    A language code (i.e. 'en-US')
   *
   * @return {Promise}            Completion
   */
  async switchLanguage(langCode) {
    let dict = null;

    // Set language on Linux & Windows (Hunspell)
    this.isMisspelledCache.reset();

    this.currentSpellchecker = new SpellCheckerProvider();
    concatenate.sync([dictionaryPath + langCode + '.dic', dictionaryPath + langCode + '.dic-diff'], dictionaryPath + langCode + '.dic-complete');
    this.currentSpellchecker.loadDictionary(langCode, dictionaryPath + langCode + '.dic-complete', dictionaryPath + langCode + '.aff');
    setTimeout(async () => this.currentSpellchecker.switchDictionary(langCode), 1000);
    this.currentSpellcheckerLanguage = langCode;
    this.currentSpellcheckerChanged.next(true);
  }



  /**
   *  The actual callout called by Electron to handle spellchecking
   *  @private
   */
  handleElectronSpellCheck(text) {
    if (!this.currentSpellchecker) return true;

    this.spellCheckInvoked.next(true);
    let result = this.isMisspelled(text);
    if (result) this.spellingErrorOccurred.next(text);
    return !result;
  }

  /**
   * Calculates whether a word is missspelled, using an LRU cache to memoize
   * the callout to the actual spell check code.
   *
   * @private
   */
  isMisspelled(text) {
    let result = this.isMisspelledCache.get(text);
    if (result !== undefined) {
      return result;
    }

    result = (() => {
      if (contractionMap[text.toLocaleLowerCase()]) {
        return false;
      }

      if (!this.currentSpellchecker) return false;

      // NB: I'm not smart enough to fix this bug in Chromium's version of
      // Hunspell so I'm going to fix it here instead. Chromium Hunspell for
      // whatever reason marks the first word in a sentence as mispelled if it is
      // capitalized.
      result = this.currentSpellchecker.checkSpelling(text);
      if (result.length < 1) {
        return false;
      }

      if (result[0].start !== 0) {
        // If we're not at the beginning, we know it's not a false positive
        return true;
      }

      // Retry with lowercase
      return this.currentSpellchecker.isMisspelled(text.toLocaleLowerCase());
    })();

    this.isMisspelledCache.set(text, result);
    return result;
  }

  /**
   * A proxy for the current spellchecker's method of the same name
   * @private
   */
  async getCorrectionsForMisspelling(text) {
    // NB: This is async even though we don't use await, to make it easy for
    // ContextMenuBuilder to use this method even when it's hosted in another
    // renderer process via electron-remote.
    if (!this.currentSpellchecker) {
      return null;
    }

    return this.currentSpellchecker.getSuggestion(text);
  }

  /**
   * To add a Word to the Dictionary the .dic will be changed.
   * The Word is added to the file and then the changed dictionary is loaded
   * into the checker.
   */
  async addToDictionary(text) {
    if (!this.currentSpellchecker) return;
    this.currentSpellchecker.unloadDictionary(this.currentSpellcheckerLanguage);
    var fs = require('fs');
    fs.appendFileSync(dictionaryPath + this.currentSpellcheckerLanguage + '.dic-diff', '\n' + text);
    concatenate.sync([dictionaryPath + this.currentSpellcheckerLanguage + '.dic', dictionaryPath + this.currentSpellcheckerLanguage + '.dic-diff'], dictionaryPath + this.currentSpellcheckerLanguage + '.dic-complete');
    this.currentSpellchecker.loadDictionary(this.currentSpellcheckerLanguage, dictionaryPath + this.currentSpellcheckerLanguage + '.dic-complete', dictionaryPath + this.currentSpellcheckerLanguage + '.aff');
    setTimeout(async () => this.currentSpellchecker.switchDictionary(this.currentSpellcheckerLanguage), 1000);
  }
}
