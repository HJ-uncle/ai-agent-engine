/** Local remote URLs may contain spaces, so only Git's tab and suffix delimit fields. */
export function parseGitRemotes(raw: string): Array<{ name: string; url: string }> {
  const remotes = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(\S+)\t(.*) \(fetch\)$/.exec(line)
    if (match && !remotes.has(match[1])) remotes.set(match[1], match[2])
  }
  return [...remotes].map(([name, url]) => ({ name, url }))
}
