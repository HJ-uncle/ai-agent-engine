/**
 * SkillsRegistry — 技能全局注册表
 *
 * 功能：
 *  - 启动时扫描 SKILLS_ROOT，加载所有技能元数据
 *  - 使用 fs.watch 监听目录变动，自动热重载
 *  - 提供单例 `skillsRegistry` 供全局使用
 *  - 变动防抖（500ms），避免批量写入时频繁重载
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadExternalSkills, type ExternalSkill } from './external-loader.js'
import { logger } from '../observability/index.js'

class SkillsRegistry {
  private skills: ExternalSkill[] = []
  private watcher: fs.FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private skillsRoot: string | null = null
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
        logger.warn('SkillsRegistry: SKILLS_ROOT not set and no .aether/skills or SKILLs directory found, skills disabled')
        return
      }
    }

    this.skillsRoot = path.resolve(process.cwd(), rawRoot)

    if (!fs.existsSync(this.skillsRoot)) {
      logger.warn({ root: this.skillsRoot }, 'SkillsRegistry: SKILLS_ROOT does not exist')
      return
    }

    // 首次加载
    this.reload()

    // 启动文件监听
    try {
      this.watcher = fs.watch(
        this.skillsRoot,
        { recursive: true },
        (eventType, filename) => {
          // 只响应 SKILL.md 的变动
          if (!filename || !filename.endsWith('SKILL.md')) return

          logger.debug({ eventType, filename }, 'SkillsRegistry: change detected')
          this.scheduleReload()
        },
      )

      this.watcher.on('error', (err) => {
        logger.error({ err }, 'SkillsRegistry: watcher error')
      })

      logger.info({ root: this.skillsRoot }, 'SkillsRegistry: watching for skill changes')
    } catch (err) {
      logger.warn({ err }, 'SkillsRegistry: failed to start watcher, hot-reload disabled')
    }
  }

  /** 停止监听（服务关闭时调用） */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
      logger.info('SkillsRegistry: watcher stopped')
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

  /** 重新扫描并更新内存中的技能列表 */
  reload(): void {
    const before = this.skills.length
    this.skills = loadExternalSkills(this.skillsRoot ?? undefined)
    const after = this.skills.length

    if (before !== after) {
      logger.info(
        { before, after, root: this.skillsRoot },
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

  get isWatching(): boolean {
    return this.watcher !== null
  }
}

/** 全局单例 */
export const skillsRegistry = new SkillsRegistry()
