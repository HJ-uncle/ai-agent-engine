/**
 * SkillsRegistry — 技能全局注册表
 *
 * 功能：
 *  - 双层扫描：全局层（~/.aether/skills）+ 项目层（.aether/skills 或 SKILLs）
 *    同名技能项目层覆盖全局层（与 aether.json 配置优先级一致）
 *  - SKILLS_ROOT 显式指定时为单 root 模式（禁用多层，保持确定性）
 *  - 使用 fs.watch 监听目录变动，自动热重载（两层分别监听）
 *  - 提供单例 `skillsRegistry` 供全局使用
 *  - 变动防抖（500ms），避免批量写入时频繁重载
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadExternalSkills, type ExternalSkill } from './external-loader.js'
import { logger } from '../observability/index.js'

/** 全局层根目录（集群部署时可设 AETHER_GLOBAL_DIR 指向共享卷） */
function globalLayerRoot(): string {
  if (process.env.AETHER_GLOBAL_DIR) return path.resolve(process.env.AETHER_GLOBAL_DIR, 'skills')
  return path.join(os.homedir(), '.aether', 'skills')
}

class SkillsRegistry {
  private skills: ExternalSkill[] = []
  private watchers: fs.FSWatcher[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private skillsRoot: string | null = null   // 项目层（或显式 SKILLS_ROOT 单 root）
  private globalRoot: string | null = null   // 全局层
  private singleRootMode = false             // SKILLS_ROOT 显式指定：禁用多层
  private readonly DEBOUNCE_MS = 500

  /** 初始化并启动文件监听 */
  start(skillsRoot?: string): void {
    // 优先级：参数 > 环境变量 > cwd/.aether/skills（新约定）> cwd/SKILLs（旧位置回退）
    let rawRoot = skillsRoot ?? process.env.SKILLS_ROOT ?? ''
    if (!rawRoot) {
      const aetherSkills = path.join(process.cwd(), '.aether', 'skills')
      const legacySkills = path.join(process.cwd(), 'SKILLs')
      if (fs.existsSync(aetherSkills)) {
        rawRoot = aetherSkills
        logger.info({ root: rawRoot }, 'SkillsRegistry: auto-detected cwd/.aether/skills')
      } else if (fs.existsSync(legacySkills)) {
        rawRoot = legacySkills
        logger.info({ root: rawRoot }, 'SkillsRegistry: SKILLS_ROOT not set, auto-detected cwd/SKILLs (legacy path)')
      } else {
        logger.warn('SkillsRegistry: SKILLS_ROOT not set and no .aether/skills or SKILLs directory found')
      }
    }

    // 单 root 模式：显式指定时禁用全局层（保持部署确定性）
    this.singleRootMode = Boolean(skillsRoot || process.env.SKILLS_ROOT)

    if (rawRoot) {
      this.skillsRoot = path.resolve(process.cwd(), rawRoot)
      if (!fs.existsSync(this.skillsRoot)) {
        logger.warn({ root: this.skillsRoot }, 'SkillsRegistry: skills root does not exist')
        this.skillsRoot = null
      }
    }

    // 全局层：SKILLS_ROOT 未显式指定时启用（单 root 部署保持确定性）
    if (!this.singleRootMode) {
      const g = globalLayerRoot()
      if (fs.existsSync(g)) {
        this.globalRoot = g
        logger.info({ root: g }, 'SkillsRegistry: global layer enabled (~/.aether/skills)')
      }
    }

    if (!this.skillsRoot && !this.globalRoot) {
      logger.warn('SkillsRegistry: no skills layer available, skills disabled')
      return
    }

    // 首次加载
    this.reload()

    // 启动文件监听（所有存在的层）
    for (const root of [this.globalRoot, this.skillsRoot]) {
      if (!root) continue
      this.watchLayer(root)
    }
  }

  /** 为单个层挂载递归监听（只响应 SKILL.md 变动） */
  private watchLayer(root: string): void {
    try {
      const watcher = fs.watch(
        root,
        { recursive: true },
        (eventType, filename) => {
          // 只响应 SKILL.md 的变动
          if (!filename || !filename.endsWith('SKILL.md')) return
          logger.debug({ eventType, filename, root }, 'SkillsRegistry: change detected')
          this.scheduleReload()
        },
      )
      watcher.on('error', (err) => {
        logger.error({ err, root }, 'SkillsRegistry: watcher error')
      })
      this.watchers.push(watcher)
      logger.info({ root }, 'SkillsRegistry: watching for skill changes')
    } catch (err) {
      logger.warn({ err, root }, 'SkillsRegistry: failed to start watcher for layer')
    }
  }

  /**
   * 全局层目录可能在服务启动后才创建（首次全局导入时 mkdir）。
   * 动态探测：出现即采纳、补挂监听并重扫，无需重启服务。
   */
  ensureGlobalLayer(): void {
    if (this.globalRoot || this.singleRootMode) return
    const g = globalLayerRoot()
    if (!fs.existsSync(g)) return
    this.globalRoot = g
    logger.info({ root: g }, 'SkillsRegistry: global layer adopted after startup')
    this.watchLayer(g)
    this.reload()
  }

  /** 停止监听（服务关闭时调用） */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    for (const w of this.watchers) w.close()
    if (this.watchers.length > 0) {
      this.watchers = []
      logger.info('SkillsRegistry: watchers stopped')
    }
  }

  /** 防抖调度重载 */
  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.reload()
      this.debounceTimer = null
    }, this.DEBOUNCE_MS)
  }

  /** 重新扫描并更新内存中的技能列表（双层合并，项目层同名覆盖全局层） */
  reload(): void {
    const before = this.skills.length
    const merged = new Map<string, ExternalSkill>()
    // 先加载全局层，后加载项目层 → 项目层覆盖同名
    for (const [root, scope] of [
      [this.globalRoot, 'global'],
      [this.skillsRoot, 'project'],
    ] as const) {
      if (!root) continue
      try {
        for (const s of loadExternalSkills(root)) {
          merged.set(s.name.toLowerCase(), { ...s, scope })
        }
      } catch (err) {
        logger.warn({ err, root }, 'SkillsRegistry: failed to load layer')
      }
    }
    this.skills = [...merged.values()]
    const after = this.skills.length

    if (before !== after) {
      logger.info(
        { before, after, projectRoot: this.skillsRoot, globalRoot: this.globalRoot },
        'SkillsRegistry: skills reloaded (count changed)',
      )
    } else {
      logger.debug({ count: after }, 'SkillsRegistry: skills reloaded')
    }
  }

  /** 获取当前技能列表（始终最新） */
  getSkills(): ExternalSkill[] {
    return this.skills
  }

  /** 按名称获取技能文件路径（供 get_skill 工具用） */
  getSkillPath(name: string): string | null {
    const skill = this.skills.find(
      (s) =>
        s.name.toLowerCase() === name.toLowerCase() ||
        path.basename(path.dirname(s.skillMdPath)).toLowerCase() === name.toLowerCase(),
    )
    return skill?.skillMdPath ?? null
  }

  get count(): number {
    return this.skills.length
  }

  /** 全局层实际生效路径（未启用时为 null，供 API 如实上报） */
  get globalRootPath(): string | null {
    return this.globalRoot
  }

  get isWatching(): boolean {
    return this.watchers.length > 0
  }
}

/** 全局单例 */
export const skillsRegistry = new SkillsRegistry()
