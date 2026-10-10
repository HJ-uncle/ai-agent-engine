import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBuildManifest } from '../../src/runtime/build-identity.js'

// Compile without replacing any artifact used by a live pressure run.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const isolatedParent=path.join(root,'.tmp')
const output=path.resolve(process.argv[2]??'')
const relative=path.relative(isolatedParent,output)
if(!process.argv[2]||!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('New isolated output within engine .tmp required')
if(fs.existsSync(output))throw new Error('Refusing to overwrite an existing candidate runtime')
const before=createBuildManifest(root)
fs.mkdirSync(output,{recursive:true})
fs.writeFileSync(path.join(output,'candidate-build.json'),JSON.stringify({startedAt:new Date().toISOString(),sourceRoot:root,output,buildId:before.buildId,passed:false},null,2)+'\n')
const result=spawnSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--noEmitOnError','--outDir',path.join(output,'dist')],{cwd:root,stdio:'inherit',windowsHide:true})
if(result.error)throw result.error
if(result.status!==0)process.exit(result.status??1)
const after=createBuildManifest(root)
if(after.buildId!==before.buildId)throw new Error('Source changed during isolated compilation; preserve failed candidate and rebuild')
fs.mkdirSync(path.join(output,'dist/runtime'),{recursive:true})
fs.copyFileSync(path.join(root,'src/terminal/workspace-shell.mjs'),path.join(output,'dist/terminal/workspace-shell.mjs'))
fs.copyFileSync(path.join(root,'node_modules/node-pty/.aether-node-pty-patch.json'),path.join(output,'dist/runtime/dependency-patches.json'))
fs.writeFileSync(path.join(output,'dist/runtime/build-manifest.json'),JSON.stringify(after,null,2)+'\n')
fs.copyFileSync(path.join(root,'package.json'),path.join(output,'package.json'))
fs.copyFileSync(path.join(root,'package-lock.json'),path.join(output,'package-lock.json'))
// Shared dependencies are read by the candidate. No install or rebuild runs
// against this junction, and compilation above uses the original toolchain.
fs.symlinkSync(path.join(root,'node_modules'),path.join(output,'node_modules'),'junction')
const receipt={startedAt:new Date().toISOString(),sourceRoot:root,output,buildId:after.buildId,passed:true,liveDistUnchanged:true}
fs.writeFileSync(path.join(output,'candidate-build.json'),JSON.stringify(receipt,null,2)+'\n')
console.log(JSON.stringify(receipt))
