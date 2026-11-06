import path from 'node:path'
import { parseArgs } from 'node:util'
import { listSealedHistoryBackups, archiveSealedHistoryBackup, readColdHistoryManifest,
  restoreColdHistoryArchive, verifyColdHistoryArchive } from '../src/storage/conversation/history-cold.js'

const { values } = parseArgs({ options: {
  'sessions-dir': { type: 'string' }, 'cold-dir': { type: 'string' }, apply: { type: 'boolean' },
  'remove-source': { type: 'boolean' }, 'max-files': { type: 'string' }, restore: { type: 'string' },
  destination: { type: 'string' }, verify: { type: 'string' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('Usage: npx tsx scripts/history-cold.ts --sessions-dir PATH [--cold-dir PATH] [--max-files 128] [--apply [--remove-source]]\nDefault only inventories sealed backups. --apply streams gzip and verifies both hashes; source stays unless --remove-source is explicit.\nVerify: --cold-dir PATH --verify MANIFEST\nRestore: --cold-dir PATH --restore MANIFEST --destination BACKUP_OR_EXPORT_PATH [--apply]\nRestore never overwrites an existing path or writes an active .jsonl. Keep manifests with their archives.')
} else {
  const sessions = values['sessions-dir'] ? path.resolve(values['sessions-dir']) : undefined
  const cold = values['cold-dir'] ? path.resolve(values['cold-dir']) : sessions ? path.join(path.dirname(sessions), 'history-cold') : undefined
  if (!cold) throw new Error('--sessions-dir or --cold-dir is required')
  if (values['remove-source'] && !values.apply) throw new Error('--remove-source requires --apply')
  if (values.restore && values.verify) throw new Error('Choose restore or verify')
  if (values.verify) {
    console.log(JSON.stringify({ mode: 'verified', manifest: await verifyColdHistoryArchive(cold, path.resolve(values.verify)) }, null, 2))
  } else if (values.restore) {
    if (!values.destination) throw new Error('--destination is required for restore')
    const manifest = values.apply ? await restoreColdHistoryArchive(cold, path.resolve(values.restore), values.destination)
      : await readColdHistoryManifest(cold, path.resolve(values.restore))
    console.log(JSON.stringify({ mode: values.apply ? 'restored' : 'restore-dry-run', destination: path.resolve(values.destination), manifest }, null, 2))
  } else {
    if (!sessions) throw new Error('--sessions-dir is required for archive inventory')
    const inventory = await listSealedHistoryBackups(sessions, values['max-files'] ? Number(values['max-files']) : undefined)
    if (!values.apply) console.log(JSON.stringify({ mode: 'dry-run', sessions, cold, ...inventory }, null, 2))
    else {
      for (const file of inventory.files) {
        const receipt = await archiveSealedHistoryBackup(sessions, file.relativePath, cold, { removeSource: values['remove-source'] })
        console.log(JSON.stringify({ mode: 'archived', ...receipt }))
      }
      console.log(JSON.stringify({ archivedFiles: inventory.files.length, hasMore: inventory.hasMore }))
    }
  }
}
