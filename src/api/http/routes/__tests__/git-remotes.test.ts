/** Pure remote-list regression coverage for the empty Work Git picker failure. */
import { describe, expect, it } from 'vitest'
import { parseGitRemotes } from '../git-remotes.js'

describe('parseGitRemotes', () => {
  it('keeps local URLs with spaces, Unicode and parentheses and deduplicates fetch/push rows', () => {
    const backup = 'D:\\项目\\测试 (fetch) backup 远程\\backup.git'
    const origin = 'D:\\项目\\测试 origin 远程\\origin.git'
    const output = [
      `backup\t${backup} (fetch)`, `backup\t${backup} (push)`,
      `origin\t${origin} (fetch)`, `origin\t${origin} (push)`, ''
    ].join('\r\n')
    expect(parseGitRemotes(output)).toEqual([
      { name: 'backup', url: backup }, { name: 'origin', url: origin }
    ])
  })

  it('keeps the first fetch URL when a remote has multiple URLs and a separate push URL', () => {
    expect(parseGitRemotes([
      'origin\tgit@example.invalid:write/repo.git (push)',
      'origin\thttps://example.invalid/read/repo.git (fetch)',
      'origin\thttps://mirror.invalid/read/repo.git (fetch)',
      'backup\tssh://git@example.invalid/backup.git (fetch)'
    ].join('\n'))).toEqual([
      { name: 'origin', url: 'https://example.invalid/read/repo.git' },
      { name: 'backup', url: 'ssh://git@example.invalid/backup.git' }
    ])
  })

  it('does not trim URL whitespace or split on a fetch-like substring inside the URL', () => {
    const url = ' ../仓库 (fetch)/repo.git '
    expect(parseGitRemotes(`origin\t${url} (fetch)\n`)).toEqual([{ name: 'origin', url }])
  })

  it('ignores empty output, unrelated lines and push-only rows', () => {
    expect(parseGitRemotes('')).toEqual([])
    expect(parseGitRemotes('warning: ignored\norigin\turl (push)\norigin url (fetch)\n')).toEqual([])
  })
})
