// Private IPC shutdown for the isolated experiment; no additional HTTP endpoint.
process.on('message', message => {
  if (message?.command === 'shutdown') process.emit('SIGTERM')
})
await import('../dist/main.js')
