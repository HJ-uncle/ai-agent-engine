// Await an already-running driver after its model-work deadline. This helper
// cannot start work or extend the driver's own request budget.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
export async function awaitDriverFinalization({driver,workloadUntil,graceMs,onGrace=()=>{},guardedWait=sleep,pollMs=250}){
  if(!Number.isFinite(workloadUntil)||workloadUntil<=0)throw new Error('Invalid driver workload deadline')
  if(!Number.isFinite(graceMs)||graceMs<1||graceMs>60000)throw new Error('Driver finalization grace must be bounded by 60000 ms')
  if(!Number.isFinite(pollMs)||pollMs<1||pollMs>1000)throw new Error('Invalid finalization poll interval')
  const finalizationUntil=workloadUntil+graceMs
  let usedGrace=false
  for(;;){
    const at=Date.now()
    if(at>finalizationUntil)throw new Error('driver-finalization-deadline')
    if(driver.closedResult)return {exit:driver.closedResult,workloadUntil,finalizationUntil,usedGrace,endedAt:at}
    if(at>=workloadUntil&&!usedGrace){usedGrace=true;onGrace({workloadUntil,finalizationUntil,maximumMs:graceMs})}
    await guardedWait(Math.max(1,Math.min(pollMs,finalizationUntil-at)))
  }
}
