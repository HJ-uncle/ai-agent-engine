import {test} from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {freePort,browserExecutable} from './verify-project-uis.mjs'

test('random project ports can be bound without touching users engine port',async()=>{
  const port=await freePort();assert.ok(port>0);assert.notEqual(port,12323)
  const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});await new Promise(resolve=>server.close(resolve))
})
test('installed browser is selected without requiring nonexistent bundled Chromium download',()=>{
  const fake={executablePath:()=>path.resolve('browser-that-does-not-exist.exe')};const file=browserExecutable(fake);assert.equal(fs.existsSync(file),true)
})
test('existing client Playwright controls a real installed Chromium page and screenshot',async()=>{
  const require=createRequire('D:/dev/aether-code/package.json'),{chromium}=require('@playwright/test')
  const browser=await chromium.launch({executablePath:browserExecutable(chromium),headless:true})
  try{const page=await browser.newPage();await page.setContent('<main><h1>Real Chromium smoke</h1><button>Works</button></main>');await page.getByRole('button',{name:'Works'}).click();assert.equal(await page.getByRole('heading').textContent(),'Real Chromium smoke');const image=await page.screenshot();assert.ok(image.length>1000);assert.equal(image.readUInt32BE(0),0x89504e47)}finally{await browser.close()}
})
