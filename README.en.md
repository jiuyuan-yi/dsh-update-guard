# dsh-update-guard

**A guard for DSH desktop updates: check whether an update will break your plugins before you install it, and recover when it does.**

[![ci](https://github.com/jiuyuan-yi/dsh-update-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/jiuyuan-yi/dsh-update-guard/actions/workflows/ci.yml)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/jiuyuan-yi/dsh-update-guard)

English · [中文](README.md)

---

## See what it does

```bash
dsh plugin --profile web add dsh-update-guard
```

Then `dsh-update-guard status` prints (the CLI follows the DSH locale; the Chinese default is shown):

```text
=== 状态 ===

profile     : C:\Users\ASUS\.dsh\profiles\desktop
安装目录    : D:\deep
待安装更新  : 无
已装插件    : 13
已锁定      : 无
自动锁定    : 关
启动自检    : 关
```

It shows up only when you are about to install an update, or when DSH will not start. No tray icon, no popups.

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
| After it breaks | Reinstall DSH | Launcher restores runtime from the installer — **measured 8s / 6136 files** (0.2.2-rc.5) |
| Config reset | Plugins gone | Surgical restore, skipping only the broken one |
| Icon reverted | The healing is gone too | Re-pointed on next launch |

## Two halves

### 1. Pre-update compatibility check

Once the app has downloaded an update but not installed it: extract two interface surfaces from the installer, scan what the installed plugins actually use, and **report only the ones that reference something the new version no longer exposes**.

| Evidence | If missing | Auto-lock |
|---|---|---|
| Client members (`UiPrimitives.xxx`) | Render throws, UI dies | ✅ locked |
| Host services (`inject: [...]`) | Plugin cannot activate; a required one takes the whole app down | ❌ reported only |
| Host service methods (`ctx.webServer.register(...)`) | Nothing at load; throws on the first call | ❌ reported only |

Host services are never auto-locked: a service may be provided dynamically in ways the scanner does not model, and a false positive would disable a healthy plugin. It is reported; you decide.

Service methods are reported only, and only by **name**: a method may live on a base class or a mixin this scanner does not follow, and arity/optionality is not compared.

**"Cannot parse" is never reported as "everything is missing":** when a module table fails to parse, the entry is marked `unverified` and listed under `surfaceUnverifiedModules`, and it **does not trigger auto-lock**.

No extractor is not a failure: it degrades to comparing version declarations only (`engines.dsh` / `peerDependencies`), which is what the loader checks anyway. A partial check is never displayed as "nothing incompatible found".

### 2. Recovery

A launcher shim on the desktop (`wscript` + hidden window, no console flash):

- **runtime emptied** → extracted back from a local installer (measured: 10.2s, 6144 files); if that fails, startup is refused with a clear message instead of looping
- **installer cleaned out of the updater cache** → a hard link is kept in `keep\` on the same volume after a successful restore, zero copy
- **runtime entry files corrupted** → the key-file manifest checks size and SHA256, so a correct file count no longer passes
- Start fails → retry → still failing, asks you (default button is "no")
- Plugin config wiped → restored from backup, skipping only the broken entry
- Shortcut reverted to the exe → re-pointed on next launch
- Only one launcher at a time

## Measured, not assumed

```
runtime restore     10.2s, 6144 files, SKILL.md back
extraction + read   5.2s, 951,974 characters of shell bundle
cache reuse         second run on the same package does not re-extract (asar mtime unchanged)
tests               41 suites, all pass with a real install; 3 skip on a machine without one (a skip is not a pass)
real crash          4 crashes on 2026-11-05; boots normally after this plugin restores runtime
```

The 3 skipped suites are not passes and are not reported as such: `test/all.mjs` lists them separately and exits 3. CI raises a warning for the same reason.

## Install

Node.js 18+, Windows, DSH desktop.

```bash
dsh plugin --profile web add dsh-update-guard
```

From npm — no git clone, and no `allowBuilds` approval step. Restart after.

To track source instead (e.g. you want to change the code):

```bash
dsh plugin --profile web add github:jiuyuan-yi/dsh-update-guard
```

Marketplace page: https://awesome-dsh-plugin.com/p/jiuyuan-yi/dsh-update-guard/
npm: https://www.npmjs.com/package/dsh-update-guard

## Settings panel

Settings → General → Update Guard. Next to the four switches there is an "update health" block:

- **Pre-update confirmation**: when an update is pending and plugins will really break, it lists them with the missing members and offers "lock these first". Two clicks (arm, then write), and it calls the same function as `guard.mjs lock` — only client-member breakage is locked; `service-absent` advisories never are.
- **Ghost banner**: shown only when the `app.asar` on disk is newer than the running process — the UI is still executing the old code, so restart.
- **Plugin coupling risk**: level (high/medium/low), version and class count per mounted plugin; expand to see which classes and files tripped.
- **Rescan**: the only way to force a full scan; otherwise the cached copy is served.

Backed by a host-side cache (5-minute TTL, warmed in the background after startup). Measured on this machine: 1.8s for the first build with 13 plugins, instant after that. Same source and grading as `touchpoints` — a ranking, not a compatibility verdict.

The only write the panel performs is "lock these first": it edits `cordis.patch.yml` in the profile with an undo journal, reversed by `guard.mjs unlock`.

## CLI

```bash
node bin/guard.mjs check            # check the pending update
node bin/guard.mjs check --json     # machine readable
node bin/guard.mjs check --remote   # ask the feed for the published version, no download
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
node bin/guard.mjs support-bundle                          # redacted diagnosis, paste into an issue
node bin/guard.mjs support-bundle --out report.md --ghost
node bin/guard.mjs surfaces export --asar <app.asar>        # one snapshot, ~234 KB
node bin/guard.mjs surfaces diff <old.json> <new.json>      # compare versions without the old archive
node bin/guard.mjs snapshot                                 # state snapshot before upgrading
node bin/guard.mjs snapshot --list
node bin/guard.mjs snapshot --diff <old> <new>
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

### support-bundle: the whole picture in one block

```bash
node bin/guard.mjs support-bundle                 # markdown, ready to paste
node bin/guard.mjs support-bundle --out report.md
node bin/guard.mjs support-bundle --json          # machine readable
node bin/guard.mjs support-bundle --ghost         # also decide "disk is newer than process"
```

It contains: DSH and guard versions, the runtime baseline (file count, `versions.json` hash, manifest size), what the last pre-update check saw, per-plugin touchpoint bands, `surfaceUnverifiedModules`, and the last 40 launcher log lines.

**Redaction is a hard rule, not a best effort**: home directory → `<HOME>`, profile → `<PROFILE>`, install root → `<DSH_ROOT>`, guard directory → `<GUARD>`. Plugins contribute file names and hit counts, never source. A test asserts the output does not contain the real home directory.

### surfaces: keep the interface, not the 200 MB archive

A regression run does not need the runtime; it needs the part that got compared. A snapshot keeps module members, service names and methods, tool signatures, and the SHA256 of the archive and shell bundle — 234 KB per version, small enough to commit.

```bash
node bin/guard.mjs surfaces export --asar <app.asar>     # baselines/dsh-<version>.json
node bin/guard.mjs surfaces list
node bin/guard.mjs surfaces diff <old> <new>             # --json available
```

`breaking` is deliberately narrow: a member, service, method, tool or parameter that disappeared. Additions and description edits never set it — otherwise every release is red and nobody reads the signal.

A snapshot is not used for an offline `check`, so it does not store the 34k literal inventory; storing it would only triple the file size.

### snapshot: what the machine looked like before the update

Not a restore source — a record for comparison: DSH version, `bundles` list, plugin versions, guard config, runtime baseline, last check verdict. Written to `.cache/snapshots/`, never committed.

```bash
node bin/guard.mjs snapshot --note "before 0.3.1"
node bin/guard.mjs snapshot --list
node bin/guard.mjs snapshot --diff <old> <new>
```

`--diff` reports only real changes: plugins added/removed/re-versioned, `bundles` edits, changed config keys, runtime file count, pending update. There is deliberately no "restore from snapshot": config restoration already has a surgical path, and two code paths that rewrite `bundles` is how a working profile gets broken.

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

- No network access by default, no telemetry. The single exception is `check --remote`: it reads the published version from the update feed once — no download, no disk write, nothing about this machine sent anywhere
- Does not touch plugin code; only flips `disabled` in `cordis.patch.yml`, byte-for-byte reversible
- Does not rewrite `!!js` conditional values (loader expressions; rewriting breaks semantics)
- Does not judge itself
- No hardcoded absolute paths: the install root comes from the registry `InstallLocation`

## Known limits

- **Windows only, verified only there** (the launcher depends on `wscript.exe`)
- Interface comparison covers the **exported member names** of 4 shared UI modules, host service **names**, and host service **method names**. Method signatures (arity, optionality) are still not compared, and a method inherited from a base class can be missed
- Verified against exactly one real upgrade (`0.2.1-rc.5 → 0.2.2-rc.1`); earlier version pairs have no sample
- Restore validates plugins structurally only; it does not start them to check runtime behaviour
- runtime healing sources an installer from `keep\` (same volume, only after a successful restore), `pending`, the updater cache, or `installers/`; with none of those, a reinstall is required
- runtime completeness checks a **key-file manifest** (a dozen entries with size and hash), not all 6136 files

## License

MIT
