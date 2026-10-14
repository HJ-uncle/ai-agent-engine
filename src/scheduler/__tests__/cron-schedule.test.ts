// Shared preview/tick scheduling, exact UTC occurrences, DST and legacy compatibility.
import { describe,it,expect } from 'vitest'
import {normalizeCronSchedule,normalizeCronConfiguration,nextOccurrence,previewCronSchedule,type CronSchedule} from '../cron-schedule.js'
const at=(value:string)=>Date.parse(value)
const iso=(value:number|null)=>value===null?null:new Date(value).toISOString()
describe('Cron schedule normalization and UTC occurrence calculation',()=>{
  it('keeps an anchored 90 minute interval instead of resetting on each tick',()=>{
    const schedule=normalizeCronSchedule({kind:'interval',everyMinutes:90,anchorAt:at('2026-10-13T09:00:35Z')})
    expect(schedule).toEqual({kind:'interval',everyMinutes:90,anchorAt:at('2026-10-13T09:00:00Z')})
    expect(previewCronSchedule(schedule,at('2026-10-13T09:20:00Z'),3).occurrences.map(iso)).toEqual(['2026-10-13T10:30:00.000Z','2026-10-13T12:00:00.000Z','2026-10-13T13:30:00.000Z'])
    expect(nextOccurrence(schedule,at('2026-10-13T10:30:00Z'))).toBe(at('2026-10-13T12:00:00Z'))
    expect(nextOccurrence(schedule,at('2026-10-13T08:00:00Z'))).toBe(at('2026-10-13T09:00:00Z'))
  })
  it.each([0,-1,1.5,'90',null,Infinity,Number.MAX_SAFE_INTEGER])('rejects invalid interval minutes %j',everyMinutes=>{
    expect(()=>normalizeCronSchedule({kind:'interval',everyMinutes,anchorAt:0})).toThrow('everyMinutes')
  })
  it('normalizes weekdays without mutating caller arrays and skips the weekend',()=>{
    const days=[5,1,1,3],schedule=normalizeCronSchedule({kind:'calendar',localTime:'09:00',timeZone:'Asia/Shanghai',daysOfWeek:days})
    expect(days).toEqual([5,1,1,3]);expect(schedule).toMatchObject({daysOfWeek:[1,3,5]})
    expect(iso(nextOccurrence(schedule,at('2026-10-16T02:00:00Z')))).toBe('2026-10-19T01:00:00.000Z')
  })
  it('skips a nonexistent spring-forward time and resumes on the next day',()=>{
    const schedule:CronSchedule={kind:'calendar',localTime:'02:30',timeZone:'America/New_York'}
    expect(previewCronSchedule(schedule,at('2026-03-08T05:00:00Z'),2).occurrences.map(iso)).toEqual(['2026-03-09T06:30:00.000Z','2026-03-10T06:30:00.000Z'])
  })
  it.each(['calendar','legacy'] as const)('runs the repeated autumn local time only at the earlier instance (%s)',kind=>{
    const schedule:CronSchedule=kind==='calendar'?{kind,localTime:'01:30',timeZone:'America/New_York'}:{kind,expression:'30 1 * * *',timeZone:'America/New_York'}
    expect(iso(nextOccurrence(schedule,at('2026-11-01T04:00:00Z')))).toBe('2026-11-01T05:30:00.000Z')
    expect(iso(nextOccurrence(schedule,at('2026-11-01T05:31:00Z')))).toBe('2026-11-02T06:30:00.000Z')
    expect(iso(nextOccurrence(schedule,at('2026-11-01T06:00:00Z')))).toBe('2026-11-02T06:30:00.000Z')
  })
  it('retains the old matcher slash and comma branch semantics',()=>{
    const base=at('2026-10-13T09:00:00Z')
    expect(previewCronSchedule({kind:'legacy',expression:'10/15 * * * *',timeZone:'UTC'},base,4).occurrences.map(iso)).toEqual(['2026-10-13T09:15:00.000Z','2026-10-13T09:30:00.000Z','2026-10-13T09:45:00.000Z','2026-10-13T10:00:00.000Z'])
    expect(iso(nextOccurrence({kind:'legacy',expression:'1-3,5 * * * *',timeZone:'UTC'},base))).toBe('2026-10-13T09:05:00.000Z')
    expect(previewCronSchedule({kind:'legacy',expression:'2-4 * * * *',timeZone:'UTC'},base,3).occurrences.map(iso)).toEqual(['2026-10-13T09:02:00.000Z','2026-10-13T09:03:00.000Z','2026-10-13T09:04:00.000Z'])
  })
  it('finds a leap-day weekday beyond an eight-year search horizon',()=>{
    expect(iso(nextOccurrence({kind:'legacy',expression:'0 0 29 2 0',timeZone:'UTC'},at('2004-02-29T00:00:00Z')))).toBe('2032-02-29T00:00:00.000Z')
    expect(nextOccurrence({kind:'legacy',expression:'0 0 31 2 *',timeZone:'UTC'},at('2026-10-13T00:00:00Z'))).toBeNull()
  })
  it('uses the same pure calculator for every-minute preview without modifying input',()=>{
    const schedule:CronSchedule={kind:'legacy',expression:'* * * * *',timeZone:'Asia/Shanghai'},before=JSON.stringify(schedule),after=at('2026-10-13T00:00:30Z')
    const preview=previewCronSchedule(schedule,after,3)
    expect(preview.nextRunAt).toBe(nextOccurrence(schedule,after));expect(preview.occurrences).toEqual([after+30000,after+90000,after+150000])
    expect(JSON.stringify(schedule)).toBe(before)
  })
  it('returns no future occurrence at the Date boundary',()=>{
    expect(nextOccurrence({kind:'calendar',localTime:'09:00',timeZone:'UTC'},8640000000000000)).toBeNull()
    expect(nextOccurrence({kind:'interval',everyMinutes:90,anchorAt:0},8640000000000000)).toBeNull()
  })
  it.each([{kind:'calendar',localTime:'9:00',timeZone:'UTC'},{kind:'calendar',localTime:'09:00',timeZone:'Invalid/Zone'},
    {kind:'calendar',localTime:'09:00',timeZone:'UTC',daysOfWeek:[]},{kind:'legacy',expression:'*/0 * * * *',timeZone:'UTC'},
    {kind:'legacy',expression:'60 * * * *',timeZone:'UTC'},{kind:'interval',everyMinutes:1,anchorAt:0,runOnce:true}])('rejects malformed or unsupported schedule %j',value=>{
    expect(()=>normalizeCronSchedule(value)).toThrow()
  })
  it('rejects unavailable policies instead of dropping them silently',()=>{
    const value={version:2,schedule:{kind:'interval',everyMinutes:1,anchorAt:0},target:{kind:'standalone'},notificationPolicy:'all_runs',toolProfile:'general'}
    expect(()=>normalizeCronConfiguration({...value,overlapPolicy:'queue_latest'})).toThrow('Unsupported')
    expect(()=>normalizeCronConfiguration({...value,notificationPolicy:'important_updates'})).toThrow('notificationPolicy')
    expect(()=>previewCronSchedule(value.schedule as CronSchedule,0,21)).toThrow('count')
  })
})
