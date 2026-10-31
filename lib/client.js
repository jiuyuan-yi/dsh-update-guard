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

          var summary = null
          if (report && report.stage === 'analysed') {
            var findings = Array.isArray(report.findings) ? report.findings : []
            var total = report.checkedPlugins
            var clientN = report.clientChecked
            var head = (clientN === undefined || clientN === null)
              ? total + ' 个第三方插件'
              : total + ' 个第三方插件（其中 ' + clientN + ' 个含界面组件，可比对接口）'
            if (findings.length === 0) {
              summary = '最近一次：' + head + '，没有发现不兼容。'
            } else {
              var names = []
              for (var i = 0; i < findings.length; i++) names.push(findings[i].plugin)
              summary = '最近一次：' + head + '，' + findings.length + ' 个可能失效 → ' + names.join('、')
            }
          } else if (report && report.stage === 'no-pending') {
            summary = '最近一次：没有待安装的更新。'
          }

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
            guard.failed ? el('div', { className: 'dug-error' }, '保存失败，已恢复成原来的值') : null,
            summary ? el('div', { className: 'dug-report' }, summary) : null)
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
