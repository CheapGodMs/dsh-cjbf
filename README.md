# dsh-cjbf — DSH plugin backup & restore

Back up every plugin installed in your DeepSeek Harness (`dsh`) profile into one
ordinary folder, then restore that folder on a new machine. Plugin packages *and*
their configuration travel together, so the new machine comes back with the same
plugin set and the same settings.

中文说明见下方 [中文](#中文)。

## What it does

- **Backup** — writes `<folder>/DSH插件备份-<YYYYMMDD-HHMMSS>/` containing:
  - `profile/` — `package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `cordis.yml`
  - `packages/` — the profile's `node_modules` (plugin bodies and their dependencies, `.bin`/`.pnpm` caches excluded)
  - `tool/` — a copy of this plugin itself, so a fresh machine can install it without the network
  - `manifest.json` — timestamp, bundle list, every dependency's exact version, file count, byte count, platform
  - `README.txt` — restore instructions written in Chinese, next to the data
- **Restore** — writes the packages back into the profile's `node_modules` and the config files back into the
  profile, keeping the *running* copy of this plugin intact:

  - `cordis.yml` is **not** overwritten (it is each machine's own composition root);
  - the restored `package.json` always keeps this plugin installed and selected;
  - dependencies that were installed from a machine-local path (`link:` / `file:`) which does not exist on the
    new machine are removed and reported, instead of breaking the next boot;
  - declared packages that are missing from the backup are pruned and reported;
  - before overwriting anything, the current profile files are copied to
    `profile/.plugin-backup-restore-<stamp>/`, which is the rollback path.

## Use it

1. Install: `dsh plugin --profile <profile> add dsh-cjbf`
2. Open **Plugins → 备份 / Backup**, choose a folder, press **Back up now**.
3. On the new machine, install DSH, then this plugin (from npm, or from the backup's `tool/` folder), open the
   same tab, pick the backup folder, press **Find backups**, choose the snapshot, **Restore this backup**.
4. Restart DSH.

An agent tool named `plugin_backup` covers the read-only and backup side (`status`, `scan`, `backup`, `find`).
Restore is deliberately user-only: it overwrites this machine's plugin configuration, so it always takes an
explicit confirmation in the page.

## Notes

- A backup is roughly the size of the profile's `node_modules` (hundreds of MB is normal).
- Session logs (`~/.dsh/sessions`) are **not** included — plugin set and configuration only.
- The tool talks to the Host only through a fenced loopback route (`/dsh-cjbf/api`); no credentials, no network.

## License

MIT

---

## 中文

把本机 DSH profile 里装的所有插件备份到一个普通文件夹；换电脑后用这个文件夹恢复，插件和它们的配置一起回来。

**备份**：在「插件」页面 →「备份」标签 → 选择目录 → 开始备份，产出
`profile/`（配置文件）、`packages/`（插件本体与依赖）、`tool/`（本插件自身副本）、`manifest.json`（清单）、`README.txt`。

**恢复**：新电脑装好 DSH 与本插件后，同样在「备份」标签里选备份文件夹 → 查找备份 → 选中 → 恢复 → 重启 DSH。
恢复不会覆盖 `cordis.yml`；覆盖前会把新电脑原有配置另存到 `profile/.plugin-backup-restore-<时间>/` 作为回滚点；
原本从本机某个文件夹 `link:`/`file:` 装、而新电脑没有该路径的插件会被跳过并在结果里列出。

备份体积约等于 `node_modules`（几百 MB 属正常），不含会话记录。
