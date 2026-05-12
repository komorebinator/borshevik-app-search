# borshevik-app-search — Requirements

## What it does

A GNOME Shell extension that makes app search work regardless of which keyboard
layout is currently active. When the user types a query in the Activities search
or the app grid search, the extension transcodes the query into every other
loaded keyboard layout and merges the results.

Example: the user has EN + RU layouts loaded. They type "кал" while in the RU
layout — the extension additionally searches for "rfk" (what those keys produce
in EN) and returns combined results. Conversely, typing "rfk" in EN layout also
finds "калькулятор". Both directions are always active regardless of which layout
is currently selected.

## Approach

### Layout detection

Read active input sources at runtime from GSettings:
`org.gnome.desktop.input-sources` → `sources` (array of `(type, id)` tuples).

Listen for `changed::sources` on that GSettings object to rebuild translation
maps whenever the user adds or removes a layout. The active layout is not
tracked; all pairwise translations are always applied.

### Character transcoding

Parse XKB symbol files from `/usr/share/X11/xkb/symbols` directly. For each
layout `id` (e.g. `"ru"`, `"us"`, `"ru(phonetic)"`):

1. Strip the variant suffix to get the file name: `"ru(phonetic)"` → `"ru"`.
2. Read the file asynchronously via `Gio.File.load_contents_async`.
3. Extract the first keysym per physical key position using the regex
   `/key\s+<([A-Z0-9]+)>\s*\{\s*\[\s*(\w+)/g`.
4. Map positions AD01–AD12 / AC01–AC11 / AB01–AB09 to indices 0–31.
5. Convert keysym names to Unicode via `Gdk.keyval_from_name` +
   `Gdk.keyval_to_unicode`.

Build a `Map<char, char>` for each ordered layout pair (both directions).
Cache parsed chars per layout id; rebuild maps whenever sources change.

### Search integration

Monkey-patch `AppDisplay.AppSearchProvider.prototype.getInitialResultSet`.
The patched function:

1. Awaits the original result set.
2. Transcodes the query using every cached translation map.
3. For each unique transcoded query, calls `GioUnix.DesktopAppInfo.search()`.
4. Filters results to only include apps that `should_show()`.
5. Sorts extra results by `Shell.AppUsage` frequency.
6. Deduplicates and appends to the original results, preserving original order.

Restore the original method on `disable()`.

## API constraints (GNOME Shell 50+)

- Use `GioUnix.DesktopAppInfo` (`gi://GioUnix`), NOT `Gio.DesktopAppInfo`.
  The latter was moved to the platform-specific library in GLib 2.88 and causes
  a nested main-loop crash via mutter's X11 focus callback.
- No GSettings schema. The extension has no user-facing settings; all behaviour
  is derived from the system's loaded keyboard layouts.
- `Extension.getSettings()` must NOT be called (requires a schema_id in GNOME
  Shell 50 and will throw if none is registered).

## Files

```
borshevik-app-search@komorebinator/
  extension.js      — all logic
  metadata.json     — uuid, name, shell-version
```

No schemas directory, no prefs.js.

## metadata.json

```json
{
  "uuid": "borshevik-app-search@komorebinator",
  "name": "Borshevik App Search",
  "description": "Transcodes app search queries across loaded keyboard layouts. Searches in both directions: Cyrillic → QWERTY and QWERTY → Cyrillic, for all configured Cyrillic layouts.",
  "shell-version": ["50"],
  "version": 1
}
```
