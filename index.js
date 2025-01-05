// noinspection JSUnresolvedReference,NpmUsedModulesInstalled

import fs from 'fs'
import { fetchDubSchedule, updateDubFeed } from './dub-schedule.js'
import { fetchSubSchedule, updateSubFeed } from './sub-schedule.js'

await fs.mkdir('./readable', { recursive: true }, () => {})
await fs.mkdir('./raw', { recursive: true }, () => {})

// changes to show in the commit description
const changes = []

if (process.argv.includes('update-sub-feed') || process.argv.includes('update-all-feeds') || process.argv.includes('update-subs')) {
    const subChanges = await updateSubFeed(process.argv.includes('update-subs'))
    changes.push(...subChanges)
}

if (process.argv.includes('update-dub-feed') || process.argv.includes('update-all-feeds') || process.argv.includes('update-dubs')) {
    const dubChanges = await updateDubFeed()
    changes.push(...dubChanges)
}

if (process.argv.includes('update-subs')) {
    const subChanges = await fetchSubSchedule()
    changes.push(...subChanges)
}

if (process.argv.includes('update-dubs')) {
    const dubChanges = await fetchDubSchedule()
    changes.push(...dubChanges)
}

fs.writeFileSync('changes.txt', changes.join('\n'))
