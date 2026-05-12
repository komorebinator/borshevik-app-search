import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GioUnix from 'gi://GioUnix';
import Shell from 'gi://Shell';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const XKB_SYMBOLS_DIR = '/usr/share/X11/xkb/symbols';

// Row AD (top row): AD01–AD12 → 0–11
// Row AC (home row): AC01–AC11 → 12–22
// Row AB (bottom row): AB01–AB09 → 23–31
const KEY_INDEX = Object.fromEntries([
    ...Array.from({length: 12}, (_, i) => [`AD${String(i + 1).padStart(2, '0')}`, i]),
    ...Array.from({length: 11}, (_, i) => [`AC${String(i + 1).padStart(2, '0')}`, 12 + i]),
    ...Array.from({length: 9},  (_, i) => [`AB${String(i + 1).padStart(2, '0')}`, 23 + i]),
]);

function parseLayoutChars(bytes) {
    const content = new TextDecoder().decode(bytes);
    const chars = new Array(32).fill(null);
    for (const [, code, sym] of content.matchAll(/key\s+<([A-Z0-9]+)>\s*\{\s*\[\s*(\w+)/g)) {
        const idx = KEY_INDEX[code];
        if (idx === undefined || chars[idx] !== null) continue;
        const keyval = Gdk.keyval_from_name(sym);
        if (keyval === Gdk.KEY_VoidSymbol) continue;
        const cp = Gdk.keyval_to_unicode(keyval);
        if (cp > 0x20) chars[idx] = String.fromCodePoint(cp);
    }
    return chars.some(c => c !== null) ? chars : null;
}

// Async: reads one XKB symbol file, returns chars[] or null.
function loadLayoutChars(layoutId) {
    const fileId = layoutId.replace(/\(.*\)/, ''); // "ru(phonetic)" → "ru"
    const gfile = Gio.File.new_for_path(`${XKB_SYMBOLS_DIR}/${fileId}`);
    return new Promise(resolve => {
        gfile.load_contents_async(null, (source, result) => {
            try {
                const [, bytes] = source.load_contents_finish(result);
                resolve(parseLayoutChars(bytes));
            } catch {
                resolve(null);
            }
        });
    });
}

function buildMap(fromChars, toChars) {
    const map = new Map();
    for (let i = 0; i < 32; i++) {
        if (fromChars[i] && toChars[i] && fromChars[i] !== toChars[i])
            map.set(fromChars[i], toChars[i]);
    }
    return map;
}

function transcode(str, map) {
    return [...str].map(ch => map.get(ch) ?? ch).join('');
}

const LOG_PREFIX = '[borshevik-app-search]';
const log = (...args) => console.log(LOG_PREFIX, ...args);
const logErr = (msg, err) => console.error(LOG_PREFIX, msg, err);

export default class BorshevikAppSearchExtension extends Extension {
    _layoutCache = new Map(); // id → chars[]
    _maps = [];
    _original = null;
    _settings = null;
    _settingsSignalId = 0;
    _syncGeneration = 0;

    enable() {
        this._settings = new Gio.Settings({schema: 'org.gnome.desktop.input-sources'});
        this._settingsSignalId = this._settings.connect('changed::sources', () => {
            this._syncLayouts().catch(err => logErr('syncLayouts failed', err));
        });

        this._original = AppDisplay.AppSearchProvider.prototype.getInitialResultSet;
        const self = this;

        AppDisplay.AppSearchProvider.prototype.getInitialResultSet = async function (terms, cancellable) {
            const origResults = await self._original.call(this, terms, cancellable);
            const results = Array.isArray(origResults) ? origResults : [];

            const query = terms.join(' ').toLowerCase();
            const extraQueries = new Set();

            for (const map of self._maps) {
                const q = transcode(query, map);
                if (q !== query) extraQueries.add(q);
            }

            if (extraQueries.size === 0)
                return results;

            const usage = Shell.AppUsage.get_default();
            const extra = [];

            for (const q of extraQueries) {
                for (const group of GioUnix.DesktopAppInfo.search(q) ?? []) {
                    if (!Array.isArray(group)) continue;
                    for (const appId of group) {
                        const app = GioUnix.DesktopAppInfo.new(appId);
                        if (app?.should_show())
                            extra.push(appId);
                    }
                }
            }

            extra.sort((a, b) => usage.compare(a, b));

            const seen = new Set(results);
            const merged = [...results];
            for (const id of extra) {
                if (!seen.has(id)) {
                    seen.add(id);
                    merged.push(id);
                }
            }
            return merged;
        };

        this._syncLayouts().catch(err => logErr('syncLayouts failed', err));
    }

    async _syncLayouts() {
        const generation = ++this._syncGeneration;

        const sources = this._settings.get_value('sources').deep_unpack();
        const currentIds = new Set(
            sources.filter(([type]) => type === 'xkb').map(([, id]) => id)
        );
        for (const id of this._layoutCache.keys()) {
            if (!currentIds.has(id)) {
                this._layoutCache.delete(id);
            }
        }

        const toLoad = [...currentIds].filter(id => !this._layoutCache.has(id));
        await Promise.all(toLoad.map(id => this._loadLayout(id)));

        if (this._syncGeneration !== generation)
            return;

        const ids = [...this._layoutCache.keys()];
        const maps = [];
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                maps.push(
                    buildMap(this._layoutCache.get(ids[i]), this._layoutCache.get(ids[j])),
                    buildMap(this._layoutCache.get(ids[j]), this._layoutCache.get(ids[i])),
                );
            }
        }
        this._maps = maps;
    }

    async _loadLayout(id) {
        const chars = await loadLayoutChars(id);
        if (chars) {
            this._layoutCache.set(id, chars);
            log(`loaded layout: ${id}`);
        } else {
            log(`failed to load layout: ${id}`);
        }
    }

    disable() {
        this._syncGeneration++;

        if (this._settings) {
            this._settings.disconnect(this._settingsSignalId);
            this._settings = null;
            this._settingsSignalId = 0;
        }

        if (this._original) {
            AppDisplay.AppSearchProvider.prototype.getInitialResultSet = this._original;
            this._original = null;
        }

        this._layoutCache.clear();
        this._maps = [];
    }
}
