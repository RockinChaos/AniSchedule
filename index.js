import { writeFile } from 'node:fs/promises'
import { writable } from 'simple-store-svelte'
const BEARER_TOKEN = process.env.ANIMESCHEDULE_TOKEN;
if (!BEARER_TOKEN) {
  console.error('Error: ANIMESCHEDULE_TOKEN environment variable is not defined.');
  process.exit(1);
}
let airingLists = writable()
console.log(`Getting dub airing schedule` )
let res = {}
try {
    res = await fetch('https://animeschedule.net/api/v3/timetables/dub', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${BEARER_TOKEN}`
        }
    })
} catch (e) {
    if (!res || res.status !== 404) throw e
}
if (!res.ok && (res.status === 429 || res.status === 500)) {
    throw res
}
let json = null
try {
    json = await res.json()
} catch (error) {
    if (res.ok) console.log(`Error: ${error.status || 429} - ${error.message}`)
}
if (!res.ok) {
    if (json) {
        for (const error of json?.errors || []) {
            console.log(`Error: ${error.status || 429} - ${error.message}`)
        }
    } else {
        console.log(`Error: ${res.status || 429} - ${res.message}`)
    }
}
airingLists.value = await json

await writeFile('dub-schedule.json', JSON.stringify(airingLists.value))
await writeFile('dub-schedule-readable.json', JSON.stringify(airingLists.value, null, 2))