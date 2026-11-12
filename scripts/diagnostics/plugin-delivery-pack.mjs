/**
 * Explicit-whitelist delivery packer. It never walks a test directory.
 * node scripts/diagnostics/plugin-delivery-pack.mjs --index <index.json>
 *   --output <new directory under .e2e-tmp> [--validate-only]
 * Source ZIPs contain their own complete source projects. Reports are reduced
 * through explicit JSON pointers; raw reports, logs, stores and secrets are never copied.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const scratch=path.join(repo,'.e2e-tmp');
const maxArchive=16*1024*1024,maxSource=8*1024*1024,maxScreenshot=12*1024*1024;
const utf8=new TextDecoder('utf-8',{fatal:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,target)=>{const rel=path.relative(root,target);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));};
const reject=(condition,message)=>{if(condition)throw new Error(message);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
const deniedPath=/(?:^|[\\/])(?:\.env(?:\..*)?|\.git|node_modules|\.versions|\.staging|credentials?|credential-profile|secrets?|engine-secrets\.json|local state|isolated-engine-key(?:\..*)?|agent\.db|memory\.db|state|plugin-store|upstream-store|verification-stores|final-stores)(?:[\\/]|$)|\.(?:db|sqlite|sqlite3|pem|key|pfx|p12|p7b|keystore)(?:[-.].*)?$|(?:^|[\\/])(?:id_rsa|id_ed25519|credentials?[^/\\]*|(?:[^/\\]*[-_.])?(?:secrets?|api[-_]?keys?|encryption[-_]?keys?|private[-_]?keys?)(?:[-_.][^/\\]*)?|[^/\\]*\.snapshot\.json|[^/\\]*\.sse\.txt)$/i;
function noLinks(target){
  const full=path.resolve(target),root=path.parse(full).root;let current=root;
  for(const part of path.relative(root,full).split(path.sep).filter(Boolean)){
    current=path.join(current,part);if(fs.existsSync(current))reject(fs.lstatSync(current).isSymbolicLink(),'拒绝链接或目录联接：'+path.basename(target));
  }
}
function safeFile(root,relative,max,label){
  reject(typeof relative!=='string'||!relative,'缺少 '+label+' 白名单路径');
  reject(deniedPath.test(relative),'拒绝疑似运行数据或凭据文件：'+label);
  const file=path.resolve(root,relative);reject(!inside(root,file),'白名单路径越界：'+label);noLinks(file);
  const stat=fs.statSync(file);reject(!stat.isFile()||stat.size>max,'文件类型或大小不允许：'+label);
  const bytes=fs.readFileSync(file);reject(bytes.length!==stat.size,'读取期间文件发生变化：'+label);return{file,bytes};
}
const secretPatterns=[
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{18,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{12,}\b/,
  /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|encryption[_-]?key)["']?\s*[:=]\s*["']([A-Za-z0-9+/_=-]{24,})["']/i,
];
function scanSecrets(text,label){for(const pattern of secretPatterns)reject(pattern.test(text),'拒绝疑似密钥内容：'+label+'（未输出匹配值）');}
function parseJson(text,label){try{return JSON.parse(text);}catch{throw new Error('JSON 文件无效（内容未输出）：'+label);}}
function plain(value,label,max=4000){reject(typeof value!=='string'||!value.trim()||value.length>max,'无效说明字段：'+label);scanSecrets(value,label);return value.trim();}
function sanitize(value,label){
  const one=value=>{
    reject(!['string','number','boolean'].includes(typeof value)&&value!==null,'报告摘要只允许标量或标量数组：'+label);
    if(typeof value!=='string')return value;
    reject(value.length>20000,'报告摘要过长：'+label);scanSecrets(value,label);
    return value.replace(/\b[A-Za-z]:[\\/][^\s"<>]+/g,'<LOCAL_PATH>').replace(/\/Users\/[^\s"<>]+|\/home\/[^\s"<>]+/g,'<LOCAL_PATH>');
  };
  if(Array.isArray(value)){reject(value.length>100,'报告摘要数组过长：'+label);return value.map(one);}return one(value);
}
function pointer(json,value){
  reject(typeof value!=='string'||!value.startsWith('/')||value.length>500,'无效 JSON Pointer');let current=json;
  for(const encoded of value.slice(1).split('/')){const key=encoded.replace(/~1/g,'/').replace(/~0/g,'~');reject(['__proto__','prototype','constructor'].includes(key)||!current||!Object.hasOwn(current,key),'报告字段不存在或不允许');current=current[key];}return current;
}
function archiveProject(bytes,expectedId){
  reject(bytes.length>maxArchive,'插件压缩包过大');
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  reject(end<0||end+22!==bytes.length,'拒绝缺少目录或携带额外注释的 ZIP');
  reject(bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0,'不支持多卷 ZIP');
  let central=bytes.readUInt32LE(end+16);const memberCount=bytes.readUInt16LE(end+10);reject(memberCount>150||central>=end,'ZIP 目录无效');
  for(let i=0;i<memberCount;i++){
    reject(central+46>end||bytes.readUInt32LE(central)!==0x02014b50,'ZIP 中央目录无效');
    const flags=bytes.readUInt16LE(central+8),mode=bytes.readUInt32LE(central+38)>>>16;
    reject(Boolean(flags&1)||((mode&0xf000)!==0&&(mode&0xf000)!==0x8000),'拒绝加密、链接或非普通 ZIP 成员');
    reject(bytes.readUInt16LE(central+32)!==0,'拒绝带隐藏成员注释的 ZIP');
    central+=46+bytes.readUInt16LE(central+28)+bytes.readUInt16LE(central+30)+bytes.readUInt16LE(central+32);
  }
  reject(central!==end,'ZIP 目录大小不一致');let original=0,count=0;const names=new Set();
  const files=unzipSync(bytes,{filter:entry=>{
    const name=entry.name;reject(++count>150,'插件压缩包成员过多');reject(typeof name!=='string'||name.length>300||name.includes('\\')||name.startsWith('/')||name.split('/').some(part=>part==='..'||part==='.'||part===''),'非法插件压缩包路径');
    reject(names.has(name.toLowerCase()),'重复插件压缩包路径');names.add(name.toLowerCase());
    reject(deniedPath.test(name)||name.startsWith('.')||name.includes('/.'),'插件包包含疑似凭据、运行数据或隐藏文件：'+name);
    reject(!/\.(?:mjs|js|cjs|json|md|txt|svg|html|css|yaml|yml|csv)$/i.test(name),'插件包含未允许的文件类型：'+name);
    reject(entry.originalSize>1024*1024||(original+=entry.originalSize)>maxSource,'插件展开大小超过限制');return true;
  }});
  reject(!files['aether-plugin.json'],'插件包缺少根清单');let actual=0;
  for(const [name,data]of Object.entries(files)){actual+=data.length;reject(data.length>1024*1024||actual>maxSource,'插件展开后超过限制');scanSecrets(utf8.decode(data),expectedId+'/'+name);}
  const manifest=parseJson(utf8.decode(files['aether-plugin.json']),'插件清单');assert.equal(manifest.id,expectedId,'压缩包 ID 与白名单不一致');assert.equal(manifest.apiVersion,1);assert.equal(manifest.runtime,'node');
  reject(!Array.isArray(manifest.tools)||!manifest.tools.length,'插件缺少工具');
  for(const tool of manifest.tools)reject(typeof tool.name!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(tool.name)||typeof tool.description!=='string'||!object(tool.inputSchema)||typeof tool.entry!=='string'||!tool.entry.endsWith('.mjs')||!Object.hasOwn(files,tool.entry),'插件工具声明或入口缺失');
  for(const required of ['README.md','package.json','scripts/test.mjs','examples/cases.json'])reject(!files[required],'插件不含可分发标准工程：'+required);
  const packageJson=parseJson(utf8.decode(files['package.json']),'工程清单');reject(Object.keys(packageJson.dependencies??{}).length||Object.keys(packageJson.optionalDependencies??{}).length,'插件 ZIP 仍依赖外部安装');
  const cases=parseJson(utf8.decode(files['examples/cases.json']),'回归案例');reject(!Array.isArray(cases.cases)||!cases.cases.length,'插件没有业务回归案例');
  return{manifest,sourceFiles:Object.keys(files).length,uncompressedBytes:actual,exampleCases:cases.cases.length};
}
function pngWithoutMetadata(bytes){
  reject(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'截图必须是 PNG');
  const parts=[bytes.subarray(0,8)];let offset=8,ihdr=false,idat=false,end=false;
  while(offset<bytes.length){reject(offset+12>bytes.length,'PNG 块被截断');const length=bytes.readUInt32BE(offset);reject(length>maxScreenshot||offset+length+12>bytes.length,'PNG 块长度无效');const type=bytes.toString('ascii',offset+4,offset+8);
    if(type==='IHDR'){reject(ihdr||offset!==8||length!==13,'PNG 头无效');const w=bytes.readUInt32BE(offset+8),h=bytes.readUInt32BE(offset+12);reject(w<1||h<1||w>16384||h>16384||w*h>100000000,'PNG 尺寸不允许');ihdr=true;}
    if(type==='IDAT')idat=true;
    // Strip textual metadata, EXIF and profiles; keep only image essentials.
    if(['IHDR','PLTE','IDAT','IEND','tRNS'].includes(type))parts.push(bytes.subarray(offset,offset+length+12));
    offset+=length+12;if(type==='IEND'){reject(length!==0||offset!==bytes.length,'PNG 结束块无效');end=true;break;}
  }
  reject(!ihdr||!idat||!end,'PNG 结构不完整');return Buffer.concat(parts);
}
function md(text){return String(text).replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');}

export function prepareDelivery(indexPath){
  const indexFile=path.resolve(indexPath);reject(!inside(scratch,indexFile),'index 必须位于仓库 .e2e-tmp 内');noLinks(indexFile);
  const raw=fs.readFileSync(indexFile,'utf8').replace(/^\uFEFF/,'');reject(raw.length>1024*1024,'index 过大');scanSecrets(raw,'交付索引');const index=parseJson(raw,'交付索引');
  assert.equal(index.schemaVersion,1);const sourceRoot=path.resolve(path.dirname(indexFile),index.sourceRoot??'..');reject(!inside(scratch,sourceRoot),'来源根目录必须在 .e2e-tmp 内');noLinks(sourceRoot);
  const evidenceRoots={engine:sourceRoot};
  for(const [name,value]of Object.entries(index.evidenceRoots??{})){
    reject(!id(name)||name==='engine'||typeof value!=='string','证据根目录白名单无效');const root=path.resolve(path.dirname(indexFile),value);
    const clientScratch=path.resolve(repo,'../aether-code/.e2e-tmp');reject(!inside(scratch,root)&&!inside(clientScratch,root),'证据根目录必须位于引擎或客户端 .e2e-tmp');noLinks(root);evidenceRoots[name]=root;
  }
  reject(!Array.isArray(index.plugins)||index.plugins.length!==10,'最终交付必须恰好包含 10 个插件');
  const title=plain(index.title??'Aether 真实场景插件交付','title',200),counts={'aether-ai':0,github:0,authored:0},seen=new Set(),entries=new Map(),plugins=[];
  const add=(name,bytes)=>{reject(entries.has(name.toLowerCase()),'交付文件名冲突');entries.set(name,Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes));};
  for(const item of index.plugins){
    reject(!id(item.id)||seen.has(item.id),'插件 ID 无效或重复');seen.add(item.id);
    reject(!object(item.origin)||!Object.hasOwn(counts,item.origin.category),'插件来源分类无效');counts[item.origin.category]++;
    reject(item.status!=='passed','不打包尚未验收通过的插件：'+item.id);
    const required=['runtime','standalone','cleanImport','ui'];if(item.origin.category==='aether-ai')required.push('authoring','selectedChat');
    for(const check of required)reject(item.acceptance?.[check]!=='passed','插件缺少通过的 '+check+' 验收：'+item.id);
    const acceptance=Object.fromEntries(required.map(check=>[check,'passed']));
    const origin={category:item.origin.category,description:plain(item.origin.description,'origin.description')};
    if(origin.category==='github'){reject(!/^[\w.-]+\/[\w.-]+$/.test(item.origin.repository??'')||!/^[a-f0-9]{40}$/.test(item.origin.commit??''),'GitHub 来源必须锁定仓库与完整提交');origin.repository=item.origin.repository;origin.commit=item.origin.commit;}
    if(origin.category==='aether-ai'){reject(!Number.isInteger(item.origin.featureIterations)||item.origin.featureIterations<0,'AI 插件需列明功能迭代数');origin.featureIterations=item.origin.featureIterations;}
    reject(!Array.isArray(item.capabilities)||!item.capabilities.length||!Array.isArray(item.limitations),'插件缺少能力或边界说明');
    const capabilities=item.capabilities.map((v,i)=>plain(v,item.id+'.capabilities.'+i)),limitations=item.limitations.map((v,i)=>plain(v,item.id+'.limitations.'+i));
    reject(typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256),'必须提供已验收 ZIP 的 SHA256');
    const archive=safeFile(sourceRoot,item.zip,maxArchive,item.id+' zip');assert.equal(hash(archive.bytes),item.sha256,'插件 ZIP 在验收后发生变化：'+item.id);
    const project=archiveProject(archive.bytes,item.id),packagePath='plugins/'+item.id+'.zip';add(packagePath,archive.bytes);
    reject(!Array.isArray(item.reports)||item.reports.length===0,'每个插件至少需要一份脱敏报告摘要');
    const reports=[];
    for(const report of item.reports){
      reject(!id(report.id)||!object(report.select)||Object.keys(report.select).length===0||Object.keys(report.select).length>30,'报告白名单不合法');
      const reportRoot=evidenceRoots[report.root??'engine'];reject(!reportRoot,'未声明报告来源根目录');
      const input=safeFile(reportRoot,report.path,32*1024*1024,item.id+' report');reject(path.extname(input.file).toLowerCase()!=='.json','报告只能读取显式 JSON');
      const data=parseJson(utf8.decode(input.bytes).replace(/^\uFEFF/,''),'报告摘要来源'),summary={};
      for(const [label,p]of Object.entries(report.select)){
        reject(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label)||/credential|password|api.?key|token|secret|sourceprofile|encryption/i.test(label+' '+p),'禁止输出敏感报告字段');summary[label]=sanitize(pointer(data,p),item.id+'/'+label);
      }
      reject(summary.status!=='passed','报告必须选出实际 passed 的 status 字段：'+item.id+'/'+report.id);
      const name='evidence/'+item.id+'/'+report.id+'.json';add(name,JSON.stringify({pluginId:item.id,reportId:report.id,sourceSha256:hash(input.bytes),summary},null,2)+'\n');reports.push(name);
    }
    reject(!Array.isArray(item.screenshots)||!item.screenshots.length,'每个插件至少一张已目视审核的真实客户端截图');
    const screenshots=[];
    for(const screenshot of item.screenshots){
      reject(screenshot.reviewed!==true,'截图必须明确标记已目视审核并脱敏');reject(!id(screenshot.id),'截图 ID 无效');
      const screenshotRoot=evidenceRoots[screenshot.root??'engine'];reject(!screenshotRoot,'未声明截图来源根目录');
      const caption=plain(screenshot.caption,'截图说明',500),image=safeFile(screenshotRoot,screenshot.path,maxScreenshot,item.id+' screenshot');reject(path.extname(image.file).toLowerCase()!=='.png','截图仅接受 PNG');
      const clean=pngWithoutMetadata(image.bytes),name='screenshots/'+item.id+'/'+screenshot.id+'.png';add(name,clean);screenshots.push({path:name,caption,metadataRemoved:true,sha256:hash(clean)});
    }
    plugins.push({id:item.id,name:plain(item.name??project.manifest.name,'name',200),version:project.manifest.version,origin,capabilities,limitations,acceptance,package:packagePath,sha256:item.sha256,bytes:archive.bytes.length,sourceFiles:project.sourceFiles,exampleCases:project.exampleCases,reports,screenshots});
  }
  assert.deepEqual(counts,{'aether-ai':5,github:3,authored:2},'交付来源数量必须是 5 AI / 3 GitHub / 2 authored');
  reject(plugins.filter(p=>p.origin.category==='aether-ai'&&p.origin.featureIterations>=3).length<2,'至少两个 Aether AI 插件完成三次功能迭代');
  const manifest={schemaVersion:1,title,counts,plugins,packaging:{method:'explicit-allowlist',rawReportsIncluded:false,runtimeDataIncluded:false,credentialsIncluded:false,screenshotReview:'operator-confirmed visual review; PNG metadata stripped',retrospectiveNote:'This packer verifies package contents and evidence selections; it does not rerun application acceptance.'}};
  const table=plugins.map(p=>`| ${md(p.name)} | ${p.origin.category} | ${p.version} | [${p.id}.zip](${p.package}) |`).join('\n');
  add('使用说明.md',`# ${title}\n\n本总包包含 10 个单插件 ZIP。请先解压总包，再在 Aether 的「插件」页面逐个导入 plugins/ 下的 ZIP，检查后发布并启用。不要把整个总包当作单插件导入。每个单插件 ZIP 同时就是完整源码工程，包含清单、实现、页面、使用说明与独立测试；涉及第三方实现的包另含来源与许可说明。\n\n## 导入和使用\n\n1. 使用包含插件自定义页面、工作区插槽及 aetherPlugin.download 下载桥的新版 Aether。\n2. 打开「插件」→ 导入本地 ZIP → 检查预览 → 创建草稿 → 发布并启用。\n3. 从左侧插件入口或当前会话工作区标签打开插件；也可在会话输入框通过 @ 选择插件供 AI 调用。\n4. 编辑真实业务输入并运行，查看结果，再使用导出按钮选择保存位置。不同页面支持的输入与导出类型以各自 README 为准。\n5. 如需查看源码，将单插件 ZIP 解压到独立目录；安装 Node.js 22 或更新版本，在该目录运行 npm test。无需 npm install。\n\n## 插件列表\n\n| 名称 | 来源 | 版本 | 导入文件 |\n| --- | --- | --- | --- |\n${table}\n\n## 完整性与测试证据\n\nSHA256SUMS.txt 列出总包内每个交付文件的哈希。manifest.json 提供能力、限制、来源、每个插件包的 SHA256 和证据索引；测试摘要.md 汇总验收信息。evidence/ 仅包含显式选择的脱敏标量摘要，screenshots/ 是逐张选入并已审核的客户端截图，不含测试数据库、密钥、模型配置或原始会话。\n\n本包只汇总已经完成的验收；不是运行过打包脚本就等于测试通过。原始测试记录留在测试工作区。\n`);
  add('测试摘要.md',`# 测试摘要\n\n按显式白名单汇总，来源数量：5 个 Aether 内模型创建、3 个 GitHub 上游适配、2 个 Codex 创建后导入。两个模型创建插件至少经历三次功能迭代。\n\n${plugins.map(p=>`## ${p.name}\n\n- ID / 版本：${p.id} / ${p.version}\n- 来源：${p.origin.description}${p.origin.repository?'（https://github.com/'+p.origin.repository+' @ '+p.origin.commit+'）':''}\n- 能力：${p.capabilities.join('；')}\n- 限制：${p.limitations.length?p.limitations.join('；'):'详见插件 README'}\n- 验收声明：${Object.entries(p.acceptance).map(([k,v])=>k+'='+v).join('，')}\n- 源码文件数：${p.sourceFiles}；随包业务用例数：${p.exampleCases}\n- 证据摘要：${p.reports.map(x=>'['+path.posix.basename(x)+']('+x+')').join('、')}\n- 客户端截图：${p.screenshots.map(s=>'['+s.caption+']('+s.path+')').join('、')}\n`).join('\n')}\n截图已经打包操作者目视审核；程序只能去除 PNG 元数据，不能自动证明像素中没有敏感信息。\n`);
  add('manifest.json',JSON.stringify(manifest,null,2)+'\n');
  add('SHA256SUMS.txt',[...entries.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>hash(bytes)+'  '+name).join('\n')+'\n');
  return{entries,manifest};
}

export function writeDelivery(prepared,output){
  const target=path.resolve(output);reject(!inside(scratch,target)||target===scratch,'交付输出目录必须位于仓库 .e2e-tmp 内');noLinks(target);reject(fs.existsSync(target),'输出目录已经存在，请选择新目录，避免覆盖交付');
  // Validate everything before creating output; only whitelisted entries are written.
  const zip=Buffer.from(zipSync(Object.fromEntries([...prepared.entries].map(([name,bytes])=>[name,[new Uint8Array(bytes),{mtime:new Date(1980,0,1),level:6}]]))));
  fs.mkdirSync(target,{recursive:true});
  const archiveName='aether-real-world-plugins.zip';fs.writeFileSync(path.join(target,archiveName),zip,{flag:'wx'});
  fs.writeFileSync(path.join(target,archiveName+'.sha256'),hash(zip)+'  '+archiveName+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(target,'使用说明.md'),prepared.entries.get('使用说明.md'),{flag:'wx'});
  fs.writeFileSync(path.join(target,'交付清单.json'),JSON.stringify(prepared.manifest,null,2)+'\n',{flag:'wx'});
  return{archiveName,sha256:hash(zip),bytes:zip.length,plugins:prepared.manifest.plugins.length,entries:prepared.entries.size};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const option=key=>{const at=process.argv.indexOf(key);return at<0?undefined:process.argv[at+1];};const index=option('--index');reject(!index,'用法：--index <白名单.json> --output <新的 .e2e-tmp 目录> [--validate-only]');const prepared=prepareDelivery(index);
    if(process.argv.includes('--validate-only'))console.log(JSON.stringify({status:'validated',plugins:prepared.manifest.plugins.length,files:prepared.entries.size,counts:prepared.manifest.counts},null,2));
    else{const output=option('--output');reject(!output,'缺少 --output');console.log(JSON.stringify({status:'packed',...writeDelivery(prepared,output)},null,2));}
  }catch(error){console.error('交付打包失败：'+error.message);process.exitCode=1;}
}
