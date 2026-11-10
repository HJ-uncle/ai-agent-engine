import type { GitWorkspace } from './git-workspace.js'

interface BranchInfo {
  name: string
  hash: string
  subject: string
  author: string
  date: string
}

type GitRunner = (cwd: GitWorkspace, args: string[]) => Promise<string>

// Subjects can contain tabs, and :short can abbreviate origin/HEAD to origin.
// Preserve full refs until parsing and identify symbolic refs independently.
const REF_FORMAT = '%(refname)%00%(objectname:short)%00%(subject)%00%(authorname)%00%(committerdate:iso-strict)%00%(symref)'

export async function listBranchInfos(run: GitRunner, cwd: GitWorkspace, remote = false): Promise<BranchInfo[]> {
  const prefix = remote ? 'refs/remotes/' : 'refs/heads/'
  const raw = await run(cwd, ['for-each-ref', '--sort=-committerdate', `--format=${REF_FORMAT}`, prefix])
  const infos: BranchInfo[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    const [ref, hash, subject, author, date, symref] = line.split('\0')
    if (!ref.startsWith(prefix) || (remote && symref)) continue
    infos.push({ name: ref.slice(prefix.length), hash, subject, author, date })
  }
  return infos
}
