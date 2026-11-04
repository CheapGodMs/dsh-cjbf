/**
 * Browser half of `dsh-cjbf`.
 *
 * Registers one tab on the Plugins page: choose a folder, back up every
 * installed plugin into it, and later restore that folder on a new machine.
 * All file-system work happens in the Host half behind `/dsh-cjbf/api`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cjbf',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-cjbf/api'
    const NS = 'plugin-backup'

    /** English copy. */
    const en = {
      tab: 'Backup',
      title: 'Plugin backup',
      intro: 'Back up every plugin installed on this machine into one folder, then restore that folder on a new machine.',
      bundles: 'Plugin bundles',
      packages: 'Dependencies',
      size: 'Size to copy',
      profile: 'Profile',
      pickBackupDir: 'Choose folder',
      backup: 'Back up now',
      noDir: 'No folder chosen',
      scanning: 'Measuring plugin files…',
      copying: 'Copying',
      backingUp: 'Back up to a folder',
      restoring: 'Restoring',
      backupDone: 'Backup written to',
      openFolder: 'Open folder',
      restoreTitle: 'Restore from a backup',
      restoreHint: 'Pick the folder that holds a backup (manifest.json inside, or one level up), choose the snapshot, then restore. Restart DSH afterwards.',
      pickRestoreDir: 'Choose folder',
      findBackups: 'Find backups',
      noBackups: 'No backup in that folder. Pick the folder with manifest.json, or its parent.',
      snapshot: 'Backup',
      units: 'plugins',
      restore: 'Restore this backup',
      confirmRestore: 'Restoring overwrites the plugin configuration of this machine. The current profile files are copied aside first. Continue?',
      confirmYes: 'Restore',
      confirmNo: 'Cancel',
      restoreDone: 'Restored. Restart DSH to load the plugins.',
      snapshotKept: 'Previous profile files kept in',
      present: 'OK',
      missing: 'missing',
      dropped: 'Skipped (local path not on this machine)',
      up: 'Up',
      empty: 'This folder is empty',
      isBackupHint: 'This folder contains a backup.',
      warnings: 'Warnings',
      copied: 'copied',
      restartNeeded: 'Restart DSH to finish restoring.',
    }
    /** Simplified Chinese copy. */
    const zh = {
      tab: '备份',
      title: '插件备份',
      intro: '把本机安装的所有插件备份到一个文件夹；换电脑后用这个文件夹恢复，插件就都回来了。',
      bundles: '插件包',
      packages: '依赖包',
      size: '待复制大小',
      profile: '配置',
      pickBackupDir: '选择目录',
      backup: '开始备份',
      noDir: '还没有选择目录',
      scanning: '正在统计插件文件…',
      copying: '正在复制',
      backingUp: '备份到文件夹',
      restoring: '恢复中',
      backupDone: '备份已写入',
      openFolder: '打开文件夹',
      restoreTitle: '从备份恢复',
      restoreHint: '选择存放备份的文件夹（里面有 manifest.json，或它的上一级），挑一份备份后点恢复。恢复完请重启 DSH。',
      pickRestoreDir: '选择目录',
      findBackups: '查找备份',
      noBackups: '这个文件夹里没有备份。请选含 manifest.json 的那一层，或它的上一级。',
      snapshot: '备份',
      units: '个插件',
      restore: '恢复这份备份',
      confirmRestore: '恢复会覆盖本机的插件配置；覆盖前会先把现有配置文件另存一份。要继续吗？',
      confirmYes: '确认恢复',
      confirmNo: '取消',
      restoreDone: '恢复完成。重启 DSH 后插件才会加载。',
      snapshotKept: '原有配置文件已另存到',
      present: '正常',
      missing: '缺失',
      dropped: '已跳过（本机没有这个本地路径）',
      up: '上一级',
      empty: '这个文件夹是空的',
      isBackupHint: '这个文件夹里有一份备份。',
      warnings: '提示',
      copied: '已复制',
      restartNeeded: '请重启 DSH 完成恢复。',
    }

    /** POST one API method; every failure becomes an `ok: false` record. */
    const call = (method, body) =>
      fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
        .then((res) => res.json())
        .then((data) => (data && data.ok === true ? data : { ok: false, error: (data && data.error) || 'request failed' }))
        .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))

    /** Human-readable byte count. */
    function humanBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB']
      let n = value / 1024
      let i = 0
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1 }
      return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`
    }

    /** One card frame. */
    function Card(props) {
      return h('section', { className: 'pb-card' },
        h('h3', { className: 'pb-card-title' }, props.title),
        props.hint ? h('p', { className: 'pb-hint' }, props.hint) : null,
        props.children)
    }

    /** Progress line shared by backup and restore. */
    function Progress(props) {
      const job = props.job
      if (!job || !job.running) return null
      const pct = job.totalBytes > 0 ? Math.min(100, Math.round((job.copiedBytes / job.totalBytes) * 100)) : 0
      const label = job.kind === 'restore' ? props.t('restoring') : job.phase === 'scanning' ? props.t('scanning') : props.t('copying')
      const amount = job.totalBytes > 0 ? `${humanBytes(job.copiedBytes)} / ${humanBytes(job.totalBytes)}` : humanBytes(job.copiedBytes)
      return h('div', { className: 'pb-progress' },
        h('div', { className: 'pb-progress-bar' }, h('div', { className: 'pb-progress-fill', style: { width: `${pct}%` } })),
        h('div', { className: 'pb-progress-text' }, `${label} · ${amount} · ${pct}%`))
    }

    /** Folder browser: in-app navigation, no native dialog needed. */
    function DirPicker(props) {
      const t = props.t
      const [listing, setListing] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => {
        let live = true
        call('browse', {}).then((result) => { if (live && result.ok) setListing(result.listing) })
        return () => { live = false }
      }, [])
      const open = (target) => {
        setBusy(true)
        call('browse', { path: target }).then((result) => {
          setBusy(false)
          if (result.ok) setListing(result.listing)
          else props.onError(result.error)
        })
      }
      return h('div', { className: 'pb-picker' },
        h('div', { className: 'pb-picker-head' },
          h('span', { className: 'pb-mono pb-grow' }, listing ? listing.path : '…'),
          listing && listing.parent ? h('button', { className: 'pb-link', onClick: () => open(listing.parent) }, `↑ ${t('up')}`) : null),
        listing !== null && listing.isBackup
          ? h('div', { className: 'pb-alert pb-alert-ok pb-small' }, t('isBackupHint'))
          : null,
        h('div', { className: 'pb-picker-list' },
          listing === null ? null : listing.entries.length === 0
            ? h('div', { className: 'pb-hint' }, t('empty'))
            : listing.entries.map((entry) => h('button', {
              key: entry.path,
              className: 'pb-picker-entry',
              style: entry.kind === 'file' ? { opacity: 0.6 } : null,
              onClick: () => (entry.kind === 'dir' ? open(entry.path) : props.onChoose(entry.path)),
            }, entry.kind === 'dir' ? `📁 ${entry.name}` : `📄 ${entry.name}`))),
        h('div', { className: 'pb-picker-foot' },
          h('button', {
            className: 'pb-btn pb-btn-primary',
            disabled: busy || listing === null,
            onClick: () => props.onChoose(listing.path),
          }, props.chooseLabel),
          h('button', { className: 'pb-btn', onClick: props.onClose }, t('confirmNo')))
      )
    }

    /** The Plugins-page tab. */
    function BackupTab(props) {
      const t = props.t
      const [status, setStatus] = React.useState(null)
      const [scan, setScan] = React.useState(null)
      const [job, setJob] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [backupDir, setBackupDir] = React.useState('')
      const [restoreDir, setRestoreDir] = React.useState('')
      const [candidates, setCandidates] = React.useState([])
      const [picker, setPicker] = React.useState(null)
      const [pendingRestore, setPendingRestore] = React.useState('')

      const refresh = React.useCallback(() => {
        call('status').then((result) => { if (result.ok) setStatus(result.status) })
        call('scan').then((result) => { if (result.ok) setScan(result.scan) })
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      React.useEffect(() => {
        if (job === null || !job.running) return
        const timer = window.setInterval(() => {
          call('job').then((result) => {
            if (!result.ok) return
            setJob(result.job)
            if (result.job.running) return
            window.clearInterval(timer)
            refresh()
            if (result.job.error) setError(result.job.error)
            else if (result.job.result) setNotice(result.job.result)
          })
        }, 700)
        return () => window.clearInterval(timer)
      }, [job, refresh])

      const startBackup = () => {
        setError('')
        setNotice(null)
        call('backup', { dest: backupDir }).then((result) => {
          if (!result.ok) { setError(result.error); return }
          setJob(result.job)
        })
      }

      const findBackups = () => {
        setError('')
        setNotice(null)
        setCandidates([])
        call('find-backups', { dir: restoreDir }).then((result) => {
          if (!result.ok) { setError(result.error); return }
          setCandidates(result.candidates)
          if (result.candidates.length === 0) setError(t('noBackups'))
        })
      }

      const startRestore = (target) => {
        setPendingRestore('')
        setError('')
        setNotice(null)
        call('restore', { dir: target }).then((result) => {
          if (!result.ok) { setError(result.error); return }
          setJob(result.job)
        })
      }

      const busy = job !== null && job.running

      const facts = status === null ? null : h('div', { className: 'pb-grid' },
        h('div', { className: 'pb-fact' },
          h('span', { className: 'pb-fact-label' }, t('bundles')),
          h('span', { className: 'pb-fact-value' }, String(status.bundles.length))),
        h('div', { className: 'pb-fact' },
          h('span', { className: 'pb-fact-label' }, t('packages')),
          h('span', { className: 'pb-fact-value' }, String(status.packages.length))),
        h('div', { className: 'pb-fact' },
          h('span', { className: 'pb-fact-label' }, t('size')),
          h('span', { className: 'pb-fact-value' }, scan === null ? '…' : scan.human)),
        h('div', { className: 'pb-fact' },
          h('span', { className: 'pb-fact-label' }, t('profile')),
          h('span', { className: 'pb-fact-value pb-mono' }, status.profile || '—')))

      const backupResult = notice !== null && notice.action === 'backup' ? h('div', { className: 'pb-alert pb-alert-ok' },
        h('div', null, `${t('backupDone')} ${notice.name}`),
        h('div', { className: 'pb-mono pb-small' }, notice.path),
        h('div', { className: 'pb-small' }, `${notice.bundles.length} ${t('units')} · ${notice.files} ${t('copied')} · ${humanBytes(notice.bytes)}`),
        h('div', { className: 'pb-actions' },
          h('button', { className: 'pb-btn', onClick: () => call('open-folder', { dir: notice.path }) }, t('openFolder')))) : null

      const restoreResult = notice !== null && notice.action === 'restore' ? h('div', { className: 'pb-alert pb-alert-ok' },
        h('div', null, t('restoreDone')),
        h('div', { className: 'pb-small' }, t('snapshotKept')),
        h('div', { className: 'pb-mono pb-small' }, notice.snapshotDir),
        h('div', { className: 'pb-small pb-mono' },
          notice.verify.map((row) => `${row.status === 'present' ? '✔' : row.status === 'self' ? '↺' : row.status === 'dropped' ? '−' : '✖'} ${row.bundle}`).join('  ')),
        notice.droppedDependencies.length === 0 ? null : h('div', { className: 'pb-small' },
          `${t('dropped')}: ${notice.droppedDependencies.join(', ')}`)) : null

      return h('div', { className: 'pb-root' },
        h('div', { className: 'pb-head' },
          h('h2', { className: 'pb-title' }, t('title')),
          h('p', { className: 'pb-hint' }, t('intro'))),
        facts,
        error ? h('div', { className: 'pb-alert pb-alert-error' }, error) : null,
        backupResult,
        restoreResult,

        h(Card, { title: t('backingUp') },
          h('div', { className: 'pb-line' },
            h('span', { className: 'pb-mono pb-grow' }, backupDir === '' ? t('noDir') : backupDir),
            h('button', { className: 'pb-btn', onClick: () => setPicker('backup') }, t('pickBackupDir'))),
          h('div', { className: 'pb-actions' },
            h('button', { className: 'pb-btn pb-btn-primary', disabled: busy || backupDir === '', onClick: startBackup }, t('backup'))),
          h(Progress, { job, t })),

        h(Card, { title: t('restoreTitle'), hint: t('restoreHint') },
          h('div', { className: 'pb-line' },
            h('span', { className: 'pb-mono pb-grow' }, restoreDir === '' ? t('noDir') : restoreDir),
            h('button', { className: 'pb-btn', onClick: () => setPicker('restore') }, t('pickRestoreDir')),
            h('button', { className: 'pb-btn', disabled: busy || restoreDir === '', onClick: findBackups }, t('findBackups'))),
          candidates.length === 0 ? null : h('div', { className: 'pb-candidates' },
            candidates.map((item) => h('div', { key: item.path, className: 'pb-candidate' },
              h('div', { className: 'pb-grow' },
                h('div', { className: 'pb-candidate-title' }, `${t('snapshot')} · ${item.createdAtLocal || item.name}`),
                h('div', { className: 'pb-small pb-mono' }, item.path),
                h('div', { className: 'pb-small' },
                  `${item.bundles.length} ${t('units')} · ${item.packageCount} ${t('packages')} · ${humanBytes(item.bytes)}${item.dshVersion === '' ? '' : ` · DSH ${item.dshVersion}`}`)),
              h('button', { className: 'pb-btn pb-btn-primary', disabled: busy, onClick: () => setPendingRestore(item.path) }, t('restore'))))),
          pendingRestore === '' ? null : h('div', { className: 'pb-alert pb-alert-warn' },
            h('div', null, t('confirmRestore')),
            h('div', { className: 'pb-mono pb-small' }, pendingRestore),
            h('div', { className: 'pb-actions' },
              h('button', { className: 'pb-btn pb-btn-primary', disabled: busy, onClick: () => startRestore(pendingRestore) }, t('confirmYes')),
              h('button', { className: 'pb-btn', onClick: () => setPendingRestore('') }, t('confirmNo')))),
          h(Progress, { job, t }),
          job !== null && !job.running && job.warnings.length > 0
            ? h('div', { className: 'pb-small' }, `${t('warnings')}: ${job.warnings.join('; ')}`)
            : null),

        picker === null ? null : h(DirPicker, {
          t,
          chooseLabel: picker === 'backup' ? t('pickBackupDir') : t('pickRestoreDir'),
          onError: setError,
          onClose: () => setPicker(null),
          onChoose: (target) => {
            if (picker === 'backup') setBackupDir(target)
            else {
              setRestoreDir(target)
              setCandidates([])
              call('find-backups', { dir: target }).then((result) => {
                if (!result.ok) return
                setCandidates(result.candidates)
              })
            }
            setPicker(null)
          },
        }),
        status === null ? null : h('div', { className: 'pb-small pb-mono' },
          `v${status.pluginVersion} · ${status.codeRevision ?? ''}`)
      )
    }

    /** Package-owned stylesheet; theme tokens only, so light and dark both work. */
    const CSS = `
.pb-root { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 24px; color: var(--dsw-alias-label-primary); }
.pb-head { display: flex; flex-direction: column; gap: 4px; }
.pb-title { margin: 0; font-size: 15px; font-weight: 600; }
.pb-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.pb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.pb-fact { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.pb-fact-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.pb-fact-value { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pb-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.pb-card-title { margin: 0; font-size: 13px; font-weight: 600; }
.pb-line { display: flex; align-items: center; gap: 8px; }
.pb-grow { flex: 1 1 auto; min-width: 0; }
.pb-actions { display: flex; gap: 8px; }
.pb-btn { height: 28px; padding: 0 12px; font-size: 12px; border-radius: 6px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.pb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.pb-btn:disabled { opacity: .5; cursor: default; }
.pb-btn-primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: #fff; }
.pb-link { border: 0; background: none; color: var(--dsw-alias-brand-primary); cursor: pointer; font-size: 12px; }
.pb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
.pb-small { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.pb-progress { display: flex; flex-direction: column; gap: 6px; }
.pb-progress-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.pb-progress-fill { height: 100%; background: var(--dsw-alias-brand-primary); transition: width .2s; }
.pb-progress-text { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.pb-alert { padding: 10px 12px; border-radius: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
.pb-alert-error { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.pb-alert-ok { border: 1px solid var(--dsw-alias-state-success-primary); }
.pb-alert-warn { border: 1px solid var(--dsw-alias-state-warn-primary); }
.pb-picker { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-overlay); }
.pb-picker-head { display: flex; align-items: center; gap: 8px; }
.pb-picker-list { display: flex; flex-direction: column; max-height: 220px; overflow: auto; border-radius: 8px; }
.pb-picker-entry { text-align: left; padding: 6px 8px; font-size: 12px; border: 0; background: none; color: var(--dsw-alias-label-primary); cursor: pointer; border-radius: 6px; }
.pb-picker-entry:hover { background: var(--dsw-alias-bg-layer-2); }
.pb-picker-foot { display: flex; justify-content: flex-end; gap: 8px; }
.pb-candidates { display: flex; flex-direction: column; gap: 8px; }
.pb-candidate { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.pb-candidate-title { font-size: 12px; font-weight: 600; }
`

    /** Register the dictionaries, the stylesheet, and the Plugins-page tab. */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'plugin-backup: dictionaries')
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-cjbf'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'plugin-backup: styles')
      ctx.slots.inject('plugins.tab', () => ctx.slots.register({
        name: 'plugins.tab',
        id: 'plugin-backup',
        order: 90,
        label: () => t('tab'),
        locale: NS,
        inject: () => ({ t }),
      }, BackupTab))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
