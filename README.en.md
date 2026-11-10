# dsh-update-guard

**A guard for DSH desktop updates: check whether an update will break your plugins before you install it, and recover when it does.**

English · [中文](README.md)

---

## Why this exists: one update, four crashes in a row

On 2026-11-05 I upgraded to `0.2.2-rc.1` and DSH stopped starting. No window, no message — just this in the log:

```
DesktopHostFatalError: ENOENT: no such file or directory, open
  'D:\deep\resources\runtime\office-skills\office\SKILL.md'
    at readFileSync (node:fs:483:20)
    at @deepseek-ai/dsh-skill-office/lib/index.js:64:38
    at new apply
    at Fiber.execute (cordis/lib/index.js:362:24)
    at main (dsh-desktop-host/lib/index.js:594:2)
```

The updater had emptied `resources\runtime`. `dsh-skill-office` reads `SKILL.md` from there at startup; a missing file throws inside a Fiber and **the whole host fails to boot**. And runtime is not inside `app.asar`, so there was nothing on disk to restore from — reinstalling was the only way out.

Four crash logs, all within the same minute.

This plugin exists so that does not happen again.

## With and without

|  | Without | With |
|---|---|---|
| Before updating | No idea which plugins will break | Lists the plugins and the exact members |
| After it breaks | Reinstall DSH | Launcher restores runtime from the installer, ~10s |
| Config reset | Plugins gone | Surgical restore, skipping only the broken one |
| Icon reverted | The healing is gone too | Re-pointed on next launch |

## Two halves

### 1. Pre-update compatibility check

Once the app has downloaded an update but not installed it: extract two interface surfaces from the installer, scan what the installed plugins actually use, and **report only the ones that reference something the new version no longer exposes**.

| Evidence | If missing | Auto-lock |
|---|---|---|
| Client members (`UiPrimitives.xxx`) | Render throws, UI dies | ✅ locked |
| Host services (`inject: [...]`) | Plugin cannot activate; a required one takes the whole app down | ❌ reported only |

Host services are never auto-locked: a service may be provided dynamically in ways the scanner does not model, and a false positive would disable a healthy plugin. It is reported; you decide.

**"Cannot parse" is never reported as "everything is missing":** when a module table fails to parse, the entry is marked `unverified` and listed under `surfaceUnverifiedModules`, and it **does not trigger auto-lock**.

No extractor is not a failure: it degrades to comparing version declarations only (`engines.dsh` / `peerDependencies`), which is what the loader checks anyway. A partial check is never displayed as "nothing incompatible found".

### 2. Recovery

A launcher shim on the desktop (`wscript` + hidden window, no console flash):

- **runtime emptied** → extracted back from the installer in `pending` (measured: 10.2s, 6144 files); if that fails, startup is refused with a clear message instead of looping
- Start fails → retry → still failing, asks you (default button is "no")
- Plugin config wiped → restored from backup, skipping only the broken entry
- Shortcut reverted to the exe → re-pointed on next launch
- Only one launcher at a time

## Measured, not assumed

```
runtime restore     10.2s, 6144 files, SKILL.md back
extraction + read   5.2s, 951,974 characters of shell bundle
cache reuse         second run on the same package does not re-extract (asar mtime unchanged)
tests               27/27 pass, 47s, 0 skipped
real crash          4 crashes on 2026-11-05; boots normally after this plugin restores runtime
```

## Install

Node.js 18+, Windows, DSH desktop.

```bash
dsh plugin --profile web add github:jiuyuan-yi/dsh-update-guard
```

The first run asks you to approve `allowBuilds` — follow the hint and retry. Then restart.

Marketplace page: https://awesome-dsh-plugin.com/p/jiuyuan-yi/dsh-update-guard/

## CLI

```bash
node bin/guard.mjs check            # check the pending update
node bin/guard.mjs check --json     # machine readable
node bin/guard.mjs lock             # lock the plugins that will break
node bin/guard.mjs unlock           # undo
node bin/guard.mjs diagnose         # when it declines to act, see which stage it stalled at
node bin/guard.mjs restore          # dry run of what a restore would do
node bin/guard.mjs restore --apply
node bin/guard.mjs config --set autoLock --value false
node bin/guard.mjs status
node bin/guard.mjs touchpoints      # what each installed plugin reaches into, no target version needed
node bin/guard.mjs touchpoints --json
node bin/guard.mjs touchpoints --only dsh-core-sauce
node bin/guard.mjs tools --asar <app.asar>                 # current tool surface
node bin/guard.mjs tools --asar <old> --diff <new>         # tool/parameter changes
node bin/guard.mjs ghost --asar <app.asar>                 # is the running process older than disk
```

Exit codes: `0` ok, `2` incompatible plugins found, `1` error.

### touchpoints: the cheapest tier

`check` needs a downloaded update before it can run. `touchpoints` does not — it reads only the plugins already on disk and reports which unstable host surfaces each one reaches into. Seconds, not minutes.

Seven classes, ordered by how badly the breakage tends to end:

| # | class | a hit means |
|---|---|---|
| 1 | `source-patch` | rewrites files inside the installed host. After an upgrade the patch target moves: it either no-ops or corrupts the tree |
| 2 | `internal-events` | subscribes to internal event names. Renames are silent — the handler simply stops firing |
| 3 | `internal-services` | reaches private service names and RPC shapes. A removed member throws at call time, not load time |
| 4 | `host-filesystem` | reads or writes `DSH_HOME`, `profiles/`. A moved directory reads as an empty result, not an error |
| 5 | `internal-ui` | registers into client slots, command registries, the module loader. Keys move between builds |
| 6 | `custom-channel` | starts its own server/WebSocket, injects CSS rules. Assumes a page structure the host never promised |
| 7 | `subprocess-output` | parses CLI stdout/stderr. Wording is free to change; the parser returns wrong values rather than failing |

Risk is two facts only: **does it write into the host**, and **how many unstable surfaces does it reach**. One hit in a class counts as "named", two or more as "reached" — an API name quoted in a comment must not raise the rating.

`--only <name>` scans a single plugin; `--max-files` caps files per plugin (default 4000).

**It is a heuristic scan, not proof of compatibility.** Zero hits means these patterns did not match, not that an upgrade is safe.

### tools: the surface the model sees

Tool names, parameter sets, and which parameters are optional are what callers actually depend on. Renaming a tool, or making an optional parameter required, kills every caller without touching a line of the tool's implementation.

```bash
node bin/guard.mjs tools --asar <app.asar>                 # list the current tool surface
node bin/guard.mjs tools --asar <old.asar> --diff <new.asar>
```

The comparison reports only the three things that genuinely break a caller:

- **a tool removed** — prompts and plugins that name it stop working
- **a parameter removed** — calls passing it fail
- **a parameter that stopped being optional** — calls omitting it fail

Description-only changes are listed separately: they do not break calls, but they can change model behaviour.

### ghost: are you comparing the same thing

An in-place upgrade replaces `app.asar` while the running host keeps executing what it already loaded. Afterwards the version on disk, the directory name, and every `package.json` report the NEW version — while the process that would actually mount a plugin is still the OLD code. Compatibility conclusions drawn in that window are attributed to the wrong side, usually inverted.

```bash
node bin/guard.mjs ghost --asar <app.asar>
```

The signal is timestamps, not versions: if the archive was written after the process started, that process loaded something older.

Windows only (it needs the process start time). Elsewhere it returns `unknown` rather than guessing — a wrong "no ghost" is worse than an honest "cannot tell", because that is exactly the case where a stale reading gets trusted.

## Config

`<profile>/.dsh-update-guard.json`

| Key | Default | Meaning |
|---|---|---|
| `preflightOnStartup` | `true` | check at startup |
| `autoLock` | `false` | lock hits without asking |
| `maxAutoLock` | `3` | how many to lock at once |
| `autoRestore` | `true` | restore config from backup when wiped |
| `installLauncher` | `false` | take over the desktop shortcut |

## What it will not do

- No network access, no telemetry
- Does not touch plugin code; only flips `disabled` in `cordis.patch.yml`, byte-for-byte reversible
- Does not rewrite `!!js` conditional values (loader expressions; rewriting breaks semantics)
- Does not judge itself
- No hardcoded absolute paths: the install root comes from the registry `InstallLocation`

## Known limits

- **Windows only, verified only there** (the launcher depends on `wscript.exe`)
- Interface comparison covers 4 shared UI modules plus host service names — host API **behaviour** changes (signatures, semantics) are out of scope
- Verified against exactly one real upgrade (`0.2.1-rc.5 → 0.2.2-rc.1`); earlier version pairs have no sample
- Restore validates plugins structurally only; it does not start them to check runtime behaviour
- runtime healing needs the installer still present in `pending`; delete it and there is nothing to restore from
- runtime completeness is judged by four subtrees + `versions.json` + a file count, not a per-file manifest

## License

MIT
