import fs from 'node:fs'
import path from 'node:path'
import type { PluginSnapshot } from './types.js'

/** Run only the exact validated source bytes, never the mutable authoring directory. */
export async function withTemporaryPluginSnapshot<T>(snapshot: PluginSnapshot, run: (snapshot: PluginSnapshot) => Promise<T>): Promise<T> {
  const root = path.resolve(path.dirname(path.resolve(process.env.DATA_DIR ?? './data/agent.db')), 'plugin-runtime')
  const parsed = path.parse(root).root
  let ancestor = parsed
  for (const component of path.relative(parsed, root).split(path.sep)) {
    ancestor = path.join(ancestor, component)
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Refusing linked plugin runtime directory')
  }
  fs.mkdirSync(root, { recursive: true })
  const directory = fs.mkdtempSync(path.join(root, 'source-'))
  try {
    for (const [relative, content] of Object.entries(snapshot.files)) {
      const filename = path.resolve(directory, relative)
      if (!filename.startsWith(directory + path.sep)) throw new Error('Plugin snapshot escaped runtime directory')
      fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content, { flag: 'wx' })
    }
    return await run({ ...snapshot, directory })
  } finally {
    const remove = (folder: string): void => {
      if (fs.lstatSync(folder).isSymbolicLink()) throw new Error('Refusing linked plugin snapshot cleanup')
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const target = path.join(folder, entry.name)
        if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing linked plugin snapshot cleanup')
        if (entry.isDirectory()) remove(target); else fs.unlinkSync(target)
      }
      if (fs.readdirSync(folder).length) throw new Error('Plugin snapshot cleanup directory is not empty')
      fs.rmdirSync(folder)
    }
    if (path.dirname(directory) !== root) throw new Error('Plugin snapshot cleanup escaped runtime root')
    remove(directory)
    if (!fs.readdirSync(root).length) fs.rmdirSync(root)
  }
}
