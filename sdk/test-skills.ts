import { loadExternalSkills } from '../src/skills/external-loader.js'

process.env.SKILLS_ROOT = 'E:/XL/wuzu-client/lobster-core/SKILLs'
const skills = loadExternalSkills()
console.log(`✅ 加载技能数: ${skills.length}`)
skills.forEach((sk) => console.log(`  · [${sk.order}] ${sk.name}`))
