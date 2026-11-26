(() => {
  try {
    /* 更新守卫 · 设置面板
       在「设置 → 通用」里加三行开关，读写都由宿主侧的 /dsh-update-guard/config.json 完成。
       浏览器这一半不碰文件系统，也不碰插件配置本身。 */
    window.__ModuleLoader__.load({
      id: 'dsh-update-guard',
      factory: (require) => {
        var module = { exports: {} }
        var exports = module.exports
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

        var React = require('react')
        var primitives = require('@deepseek-ai/dsh-client-ui-primitives')

        var API = '/dsh-update-guard'
        var NS = 'dsh-update-guard'
        var TAG_ID = 'dsh-update-guard/panel.css'

        var CSS = [
          '.dug-panel{display:flex;flex-direction:column;gap:14px}',
          '.dug-row{display:flex;align-items:center;justify-content:space-between;gap:16px}',
          '.dug-text{min-width:0}',
          '.dug-title{font-size:13px;line-height:20px}',
          '.dug-desc{font-size:12px;line-height:18px;opacity:.6}',
          '.dug-report{font-size:12px;line-height:18px;opacity:.75;border-top:1px solid rgba(128,128,128,.2);padding-top:10px}',
          '.dug-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d33)}',
          '.dug-health{display:flex;flex-direction:column;gap:10px;border-top:1px solid rgba(128,128,128,.2);padding-top:12px}',
          '.dug-health-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
          '.dug-ghost{border:1px solid rgba(230,160,0,.5);background:rgba(230,160,0,.08);border-radius:8px;padding:8px 10px}',
          '.dug-ghost-title{font-size:12px;line-height:18px;font-weight:600}',
          '.dug-ghost-desc{font-size:12px;line-height:18px;opacity:.75;margin-top:2px}',
          '.dug-tally{font-size:12px;line-height:18px;opacity:.7}',
          '.dug-plugins{display:flex;flex-direction:column;gap:6px}',
          '.dug-plugin{border:1px solid rgba(128,128,128,.18);border-radius:8px}',
          '.dug-plugin-head{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer}',
          '.dug-plugin-name{font-size:12px;line-height:18px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dug-plugin-body{padding:0 8px 8px;display:flex;flex-direction:column;gap:4px}',
          '.dug-cls{display:flex;gap:8px;font-size:11px;line-height:16px}',
          '.dug-band{font-size:10px;line-height:16px;padding:0 6px;border-radius:9px;border:1px solid}',
          '.dug-band-high{color:#d33;border-color:rgba(221,51,51,.5)}',
          '.dug-band-medium{color:#c80;border-color:rgba(204,136,0,.5)}',
          '.dug-band-low{opacity:.6}',
          '.dug-band-none{opacity:.4}',
          '.dug-refresh{font-size:11px;line-height:16px;background:none;border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:2px 8px;cursor:pointer;color:inherit;font:inherit}',
          '.dug-preflight{display:flex;flex-direction:column;gap:8px;border:1px solid rgba(221,51,51,.45);background:rgba(221,51,51,.06);border-radius:8px;padding:10px}',
          '.dug-preflight-title{font-size:12px;line-height:18px;font-weight:600}',
        ].join('')

        function ensureCss() {
          if (typeof document === 'undefined') return
          if (document.querySelector('style[data-plugin-css="' + TAG_ID + '"]') !== null) return
          var tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-update-guard'
          tag.dataset.pluginCss = TAG_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
        }

        function el(tag, props) {
          var children = Array.prototype.slice.call(arguments, 2)
          if (children.length === 0) return React.createElement(tag, props)
          return React.createElement.apply(null, [tag, props].concat(children))
        }

        function Switch(props) {
          return React.createElement(primitives.Switch, {
            checked: props.checked === true,
            disabled: props.disabled === true,
            label: props.label,
            onChange: props.onChange,
          })
        }

        function Row(props) {
          return el('div', { className: 'dug-row' },
            el('div', { className: 'dug-text' },
              el('div', { className: 'dug-title' }, props.title),
              props.description ? el('div', { className: 'dug-desc' }, props.description) : null),
            el(Switch, { checked: props.checked, label: props.title, onChange: props.onChange }))
        }

        var BAND_LABEL = { high: '高', medium: '中', low: '低', none: '无' }

        function riskLabel(band) {
          return BAND_LABEL[band] || '?'
        }

        /* 升级前确认卡片：只列出「这次更新会真的让插件失效」的那几个，并能一键
           锁定它们。锁定写的是 profile 的 cordis.patch.yml（可撤销），调用的是与
           CLI 完全相同的 lockFromAnalysis，面板不会和 `guard.mjs lock` 分叉。 */
        function hardFindings(report) {
          if (!report || report.stage !== 'analysed') return []
          var list = Array.isArray(report.findings) ? report.findings : []
          return list.filter(function (f) {
            return Array.isArray(f.broken) && f.broken.some(function (b) {
              return b.note !== 'service-absent'
            })
          })
        }

        function PreflightCard(props) {
          var hard = hardFindings(props.report)
          var confirmState = React.useState(false)
          var confirming = confirmState[0]
          var setConfirming = confirmState[1]
          var busyState = React.useState(false)
          var busy = busyState[0]
          var setBusy = busyState[1]
          var msgState = React.useState(null)
          var msg = msgState[0]
          var setMsg = msgState[1]

          if (hard.length === 0) return null

          // Two clicks, no modal: the first arms it, the second writes. A browser
          // confirm() would block the whole renderer.
          function lock() {
            if (!confirming) { setConfirming(true); return }
            setBusy(true)
            setMsg(null)
            fetch(API + '/lock.json', { method: 'POST' })
              .then(function (r) { return r.json() })
              .then(function (d) {
                setBusy(false)
                setConfirming(false)
                if (!d || d.ok !== true) throw new Error('rejected')
                setMsg('已锁定 ' + (d.locked || []).length + ' 个配置项；撤销用 guard.mjs unlock')
              })
              .catch(function () {
                setBusy(false)
                setConfirming(false)
                setMsg('锁定失败，配置未改动')
              })
          }

          return el('div', { className: 'dug-preflight' },
            el('div', { className: 'dug-preflight-title' }, '这次更新会让 ' + hard.length + ' 个插件失效'),
            el('div', { className: 'dug-desc' }, '只锁定下面这些，其余插件保持原样。锁定改的是插件配置，可随时撤销。'),
            el('div', { className: 'dug-plugins' }, hard.slice(0, 12).map(function (f) {
              var why = (f.broken || [])
                .filter(function (b) { return b.note !== 'service-absent' })
                .map(function (b) { return b.moduleName + ': ' + (b.missing || []).join(', ') })
                .join('；')
              return el('div', { className: 'dug-plugin', key: f.plugin },
                el('div', { className: 'dug-plugin-head' },
                  el('span', { className: 'dug-band dug-band-high' }, '断'),
                  el('span', { className: 'dug-plugin-name' }, f.plugin),
                  el('span', { className: 'dug-desc' }, ((f.ids || []).length) + ' 项')),
                el('div', { className: 'dug-plugin-body' },
                  el('div', { className: 'dug-cls' }, el('span', null, why))))
            })),
            el('div', { className: 'dug-health-head' },
              el('button', {
                type: 'button',
                className: 'dug-refresh',
                disabled: busy,
                onClick: lock,
              }, busy ? '锁定中…' : (confirming ? '再点一次确认锁定' : '先锁定这些插件')),
              msg ? el('span', { className: 'dug-desc' }, msg) : null))
        }

        /* 一个插件一行：风险徽标 + 名称 + 版本 + 命中类数；点开看具体踩了哪些类、
           命中了哪些文件。故意不做搜索、不做筛选——这是"体检报告"，不是控制台。 */
        function PluginRow(props) {
          var openState = React.useState(false)
          var open = openState[0]
          var setOpen = openState[1]
          var p = props.item
          var classes = Array.isArray(p.classes) ? p.classes : []

          return el('div', { className: 'dug-plugin' },
            el('div', {
              className: 'dug-plugin-head',
              onClick: function () { setOpen(!open) },
            },
              el('span', { className: 'dug-band dug-band-' + (p.band || 'none') }, riskLabel(p.band)),
              el('span', { className: 'dug-plugin-name' }, p.name),
              el('span', { className: 'dug-desc' }, p.version + ' · ' + classes.length + ' 类')),
            open ? el('div', { className: 'dug-plugin-body' },
              classes.map(function (c) {
                return el('div', { className: 'dug-cls', key: c.slug },
                  el('code', null, c.slug + ' ×' + c.hits),
                  el('span', { className: 'dug-desc' }, (c.files || []).join(', ')))
              }),
              el('div', { className: 'dug-desc' }, p.reason || '')) : null)
        }

        /* 体检区：ghost 提示条 + 插件耦合风险。数据来自 /panel.json（宿主侧缓存）。
           请求失败就整块不显示——设置页的开关必须照常可用。 */
        function UpdateHealth() {
          var panelState = React.useState(null)
          var panel = panelState[0]
          var setPanel = panelState[1]
          var busyState = React.useState(false)
          var busy = busyState[0]
          var setBusy = busyState[1]
          var failState = React.useState(false)
          var failed = failState[0]
          var setFailed = failState[1]

          function load(refresh) {
            setBusy(true)
            setFailed(false)
            fetch(API + '/panel.json' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(function (d) {
                if (!d || d.ok !== true || !d.panel) throw new Error('unavailable')
                setPanel(d.panel)
                setBusy(false)
              })
              .catch(function () { setBusy(false); setFailed(true) })
          }

          React.useEffect(function () {
            var alive = true
            fetch(API + '/panel.json', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(function (d) { if (alive && d && d.ok === true && d.panel) setPanel(d.panel) })
              .catch(function () { /* 体检是可选的，面板开关不受影响 */ })
            return function () { alive = false }
          }, [])

          if (panel === null) return null

          var ghost = panel.ghost || {}
          var counts = panel.counts || {}
          var plugins = Array.isArray(panel.plugins) ? panel.plugins : []
          var shown = plugins.slice(0, 40)

          return el('div', { className: 'dug-health' },
            ghost.status === 'ghost' ? el('div', { className: 'dug-ghost' },
              el('div', { className: 'dug-ghost-title' }, '磁盘上的版本比正在运行的进程新'),
              el('div', { className: 'dug-ghost-desc' }, '当前界面仍在跑旧版代码，此时的兼容性判断会算错。建议重启 DSH。')) : null,
            el('div', { className: 'dug-health-head' },
              el('div', { className: 'dug-desc' }, '插件耦合风险（启发式，不是结论）'),
              el('button', {
                type: 'button',
                className: 'dug-refresh',
                disabled: busy,
                onClick: function () { load(true) },
              }, busy ? '扫描中…' : '重新扫描')),
            el('div', { className: 'dug-tally' },
              '高 ' + (counts.high || 0) + ' · 中 ' + (counts.medium || 0) + ' · 低 ' + (counts.low || 0) +
              (plugins.length > shown.length ? ' · 只显示前 ' + shown.length + ' 个' : '')),
            plugins.length === 0
              ? el('div', { className: 'dug-desc' }, '没有已挂载的第三方插件。')
              : el('div', { className: 'dug-plugins' }, shown.map(function (p) {
                return el(PluginRow, { key: p.name, item: p })
              })),
            failed ? el('div', { className: 'dug-desc' }, '体检数据读取失败，可以点「重新扫描」再试。') : null)
        }

        function useGuard() {
          var cfgState = React.useState(null)
          var config = cfgState[0]
          var setConfig = cfgState[1]
          var failState = React.useState(false)
          var failed = failState[0]
          var setFailed = failState[1]

          React.useEffect(function () {
            var alive = true
            fetch(API + '/config.json', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(function (d) { if (alive && d && d.ok) setConfig(d.config) })
              .catch(function () { if (alive) setFailed(true) })
            return function () { alive = false }
          }, [])

          function update(key, value) {
            var previous = config
            var optimistic = {}
            for (var k in config) optimistic[k] = config[k]
            optimistic[key] = value
            setConfig(optimistic)
            setFailed(false)
            var body = {}
            body[key] = value
            return fetch(API + '/config.json', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
              .then(function (r) { return r.json() })
              .then(function (d) {
                if (!d || d.ok !== true) throw new Error('rejected')
                setConfig(d.config)
              })
              .catch(function () {
                setFailed(true)
                setConfig(previous)
              })
          }

          return { config: config, failed: failed, update: update }
        }

        function summarize(report) {
          if (!report) return null
          if (report.stage === 'no-pending') return '没有待安装的更新。'
          // A failed run must not read like an empty one: the reason is the only
          // thing that tells the user whether to retry or fix the environment.
          if (report.stage === 'error') {
            return '检查未完成：' + (report.reason || '未知原因') + '。'
          }
          if (report.stage !== 'analysed') return '检查未完成。'

          var findings = Array.isArray(report.findings) ? report.findings : []
          var total = report.checkedPlugins
          var clientN = report.clientChecked
          var head = (clientN === undefined || clientN === null)
            ? total + ' 个第三方插件'
            : total + ' 个第三方插件（其中 ' + clientN + ' 个含界面组件）'

          if (report.tier === 'declared-only') {
            var why = report.note === 'extract-failed'
              ? '解包失败'
              : '没有可用的解压器'
            var tail = findings.length === 0
              ? '，未发现版本声明冲突'
              : '，' + findings.length + ' 个插件的版本声明不匹配'
            return '部分检查：' + why + '，只比对了版本声明（' + head + '）' + tail + '。'
          }

          if (findings.length === 0) {
            return '完整检查：' + head + '，没有发现不兼容。'
          }
          var names = []
          for (var i = 0; i < findings.length; i++) names.push(findings[i].plugin)
          return '发现风险：' + head + '，' + findings.length + ' 个可能失效 → ' + names.join('、')
        }

        function GuardPanel() {
          ensureCss()
          var guard = useGuard()
          var config = guard.config
          var repState = React.useState(null)
          var report = repState[0]
          var setReport = repState[1]

          React.useEffect(function () {
            var alive = true
            fetch(API + '/report.json', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(function (d) { if (alive && d && d.ok) setReport(d.report) })
              .catch(function () { /* 报告是可选的 */ })
            return function () { alive = false }
          }, [])

          if (config === null) {
            return el('div', { className: 'dug-panel' },
              el('div', { className: guard.failed ? 'dug-error' : 'dug-desc' },
                guard.failed ? '设置读取失败，请刷新页面重试' : '读取中…'))
          }

          var summary = summarize(report)

          return el('div', { className: 'dug-panel' },
            el(Row, {
              title: '更新前检查并提示不兼容插件',
              description: '有更新待安装时，比对已装插件用到的接口，只报告会失效的那几个。',
              checked: config.preflightOnStartup !== false,
              onChange: function (v) { guard.update('preflightOnStartup', v) },
            }),
            el(Row, {
              title: '命中时自动锁定',
              description: '不询问，直接停用会崩的插件；锁的是配置项，随时可还原。',
              checked: config.autoLock === true,
              onChange: function (v) { guard.update('autoLock', v) },
            }),
            el(Row, {
              title: '配置被重置后自动还原',
              description: '发现插件配置被清空时，从备份恢复，只跳过有问题的那个。',
              checked: config.autoRestore === true,
              onChange: function (v) { guard.update('autoRestore', v) },
            }),
            el(Row, {
              title: '接管桌面快捷方式（启动失败自愈）',
              description: '桌面图标改为经启动器启动：失败重试，重试仍失败再询问。关闭会把图标还原。',
              checked: config.installLauncher === true,
              onChange: function (v) { guard.update('installLauncher', v) },
            }),
            guard.failed ? el('div', { className: 'dug-error' }, '保存失败，已恢复成原来的值') : null,
            summary ? el('div', { className: 'dug-report' }, summary) : null,
            el(PreflightCard, { report: report }),
            el(UpdateHealth))
        }

        function apply(ctx) {
          try {
            ctx.slots.inject('settings.general.item', function () {
              return ctx.slots.register({
                name: 'settings.general.item',
                id: 'dsh-update-guard',
                order: 90,
                locale: NS,
              }, GuardPanel)
            })

            if (ctx.locale && typeof ctx.locale.register === 'function') {
              ctx.effect(function () {
                return ctx.locale.register(NS, {
                  zh: { 'dsh-update-guard': '更新守卫' },
                  en: { 'dsh-update-guard': 'Update Guard' },
                })
              }, 'update-guard-ui: dictionaries')
            }
          } catch (err) {
            // 面板挂不上不能连累整个设置页
            try { console.warn('[dsh-update-guard] panel not registered:', err) } catch (e) { }
          }
        }

        exports.__test = { summarize: summarize, riskLabel: riskLabel, hardFindings: hardFindings }
        exports.name = 'dsh-update-guard'
        exports.inject = ['slots']
        exports.apply = apply
        return module.exports
      },
    })
  } catch (err) {
    try { console.warn('[dsh-update-guard] client bundle error:', err) } catch (e) { }
  }
})()
