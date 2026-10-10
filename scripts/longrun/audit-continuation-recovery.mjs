import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { continuationDatabaseAudit } from './continuation-database-audit.mjs'

const root=path.resolve(process.argv[2]),stage=path.resolve(process.argv[3])
const status=JSON.parse(fs.readFileSync(path.join(root,'supervisor-status.json'),'utf8'))
if(status.phase!=='stopped')throw new Error('Recovery audit requires stopped supervisor')
const owner=JSON.parse(fs.readFileSync(path.join(root,'continuation-owned-processes.json'),'utf8'))
if(!Array.isArray(owner.observed)||!owner.observed.length)throw new Error('Recorded ownership inventory required')
const script="$rows=@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString()}});ConvertTo-Json -InputObject $rows -Compress"
const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024})
const table=JSON.parse(stdout.replace(/^\uFEFF/,'').trim())
if(!Array.isArray(table)||!table.length)throw new Error('Process enumeration did not complete')
const identity=row=>`${row.pid}:${row.startTicks}`,known=new Set(owner.observed.map(identity))
const remaining=table.filter(row=>known.has(identity(row)))
const processes={at:new Date().toISOString(),inventoryComplete:true,observedIdentities:known.size,remaining,errors:[],scope:'Exact recorded process creation identities after stopped supervisor; PID reuse is not an owned process'}
fs.writeFileSync(path.join(root,'recovery-process-audit.json'),JSON.stringify(processes,null,2)+'\n',{flag:'wx'})
const database=continuationDatabaseAudit(root,stage)
fs.writeFileSync(path.join(root,'recovery-database-audit.json'),JSON.stringify(database,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({processesPassed:remaining.length===0,databasePassed:database.passed,databases:database.databases.map(({file,passed,error})=>({file,passed,error}))}))
process.exitCode=remaining.length||!database.passed?2:0
