import AnimeResolver from './animeresolver.js'
import Bottleneck from 'bottleneck'
import { sleep } from './util.js'
import Fuse from 'fuse.js'
import path from 'path'
import fs from 'fs'

globalThis.__dirname = '' // anitomyscript depression
globalThis.require = (module) => {
    if (module === 'path') {
        // noinspection JSUnusedGlobalSymbols
        return {
            ...path,
            normalize: (p) => {
                const parts = p.split('file://')
                return parts.length > 1 ? parts[1].replace(/^\/[A-Z]:/, '') : p
            }
        }
    }
    if (module === 'fs') return fs
    throw new Error(`Module ${module} not found`)
}

/**
 * Retrieves a nested value from an object using a dot-separated path.
 * @param {Object} obj - The object to retrieve the value from.
 * @param {string} path - The dot-separated path (e.g., 'title.userPreferred').
 * @returns {*} - The value at the specified path or undefined.
 */
function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, key) => acc && acc[key], obj)
}

/**
 * Sets a nested value in an object using a dot-separated path.
 * @param {Object} obj - The object to modify.
 * @param {string} path - The dot-separated path (e.g., 'title.userPreferred').
 * @param {*} value - The value to set.
 */
function setNestedValue(obj, path, value) {
    const keys = path.split('.')
    let current = obj
    while (keys.length > 1) {
        const key = keys.shift()
        if (!current[key] || typeof current[key] !== 'object') current[key] = {}
        current = current[key]
    }
    current[keys[0]] = value
}

function cleanText(text) {
    if (typeof text !== 'string') return ''
    return AnimeResolver.cleanFileName(text).replace(/['’]/gu, '').replace(/[^\p{L}\p{N}\p{Zs}\p{Pd}]/gu, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * @param {Object} nest The nested Object to use for looking up the keys.
 * @param {String} phrase The key phrase to look for.
 * @param {Array} keys Add the specified number of weeks regardless of the episodeDate having past.
 * @param {number} threshold The allowed tolerance, typically for misspellings.
 * @returns {boolean} If the target phrase has been found.
 */
export function matchKeys(nest, phrase, keys, threshold = 0.4) {
    if (!phrase) return true
    if (!nest) return false
    const match = new Fuse([nest], { includeScore: true, threshold, keys: keys }).search(phrase).length > 0
    if (match) return match
    else {
        let anyCleaned = false
        const cleanedNest = {}
        for (const key of keys) {
            const value = getNestedValue(nest, key)
            if (typeof value === 'string') {
                const cleaned = cleanText(value)
                setNestedValue(cleanedNest, key, cleaned)
                if (cleaned !== value) anyCleaned = true
            } else if (Array.isArray(value)) {
                const cleanedArray = value.filter(v => typeof v === 'string').map(cleanText)
                if (cleanedArray.length) {
                    setNestedValue(cleanedNest, key, cleanedArray)
                    if (JSON.stringify(cleanedArray) !== JSON.stringify(value)) anyCleaned = true
                }
            }
        }
        return (new Fuse([cleanedNest], { includeScore: true, threshold: anyCleaned ? threshold + .05 : threshold, keys: keys }).search(phrase).length > 0)
    }
    /*if (new Fuse([nest], { includeScore: true, threshold, keys: keys }).search(phrase).length > 0) return true
    const fuse = new Fuse([phrase], { includeScore: true, threshold, })
    return keys.some((key) => { // this was causing way too many problems as some title routes are just stupidly similar causing them to resolve as the incorrect series... probably don't ever use this again.
        const valueToMatch = nest[key]
        if (valueToMatch) return fuse.search(valueToMatch).length > 0
        return false
    })*/
}

function getByPath(obj, path) {
    return path.split('.').reduce((acc, part) => acc?.[part], obj)
}

export function exactMatch(nest, title, keys) {
    return keys.some(k => {
        const val = getByPath(nest, k)
        return val && AnimeResolver.cleanFileName(val.toLowerCase()) === AnimeResolver.cleanFileName(title?.toLowerCase())
    })
}

// utility method for correcting anitomyscript woes for what's needed
export async function anitomyscript (...args) {
    // @ts-ignore
    const { default: _anitomyscript } = await import('anitomyscript')
    const res = await _anitomyscript(...args)

    const parseObjs = Array.isArray(res) ? res : [res]

    for (const obj of parseObjs) {
        obj.anime_title ??= ''
        const seasonMatch = obj.anime_title.match(/S(\d{2})E(\d{2})|season-(\d+)/i)
        if (seasonMatch) {
            if (seasonMatch[1] && seasonMatch[2]) {
                obj.anime_season = seasonMatch[1]
                obj.episode_number = seasonMatch[2]
                obj.anime_title = obj.anime_title.replace(/S(\d{2})E(\d{2})/, '')
            } else if (seasonMatch[3]) {
                obj.anime_season = seasonMatch[3]
                obj.anime_title = obj.anime_title.replace(/season-\d+/i, '')
            }
        } else if (Array.isArray(obj.anime_season)) {
            obj.anime_season = obj.anime_season[0]
        }
        const yearMatch = obj.anime_title.match(/ (19[5-9]\d|20\d{2})/)
        if (yearMatch && Number(yearMatch[1]) <= (new Date().getUTCFullYear() + 1)) {
            obj.anime_year = yearMatch[1]
            obj.anime_title = obj.anime_title.replace(/ (19[5-9]\d|20\d{2})/, '')
        }
        if (obj.episode_number?.includes('.')) { // stupid fix for 2.5 Dimensional Seduction. We resolve anime titles not video so there should be ZERO reason to use an "episode" that is a double.
            obj.anime_title = obj.file_name.replace(Number(obj.anime_season) > 1 ? /\b(?:\d+(?:st|nd|rd|th)?\s*Season|Season\s*\d+)\b/gi : '', '')
            delete obj.episode_number
        }
        if (Number(obj.anime_season || obj.episode_number) > 1) obj.anime_title += ' S' + (obj.anime_season || obj.episode_number) // use episode number as we are resolving anime titles not video. Anitomyscript is stupid sometimes...
    }

    return parseObjs
}

export function getMediaMaxEp (media, playable) {
    if (!media) return 0
    else if (playable) return media.nextAiringEpisode?.episode - 1 || lastAired(media.airingSchedule?.nodes)?.episode || (media.status === 'NOT_YET_RELEASED' ? 0 : media.episodes) || (media.status === 'RELEASING' ? (media.mediaListEntry?.progress ?? 1) : 0)
    else return Math.max(media.airingSchedule?.nodes?.[media.airingSchedule?.nodes?.length - 1]?.episode || 0, media.airingSchedule?.nodes?.length || 0, (!media.streamingEpisodes || (media.status === 'FINISHED' && media.episodes) ? 0 : media.streamingEpisodes?.filter((ep) => { const match = (/Episode (\d+(\.\d+)?) - /).exec(ep.title); return match ? Number.isInteger(parseFloat(match[1])) : false}).length), media.episodes || 0, media.nextAiringEpisode?.episode || 0) || (media.status === 'RELEASING' ? (media.mediaListEntry?.progress ?? 1) : 0)
}

export function lastAired(nodes, variables) {
    const currentTime = new Date()
    return nodes?.filter(node => new Date(node.airingAt * 1000) < currentTime)?.sort((a, b) => {
        const timeDiff = b.airingAt - a.airingAt
        if (timeDiff !== 0) return timeDiff
        return (b.episode || 0) - (a.episode || 0)
    })?.shift()
}

/**
 * Checks if a series has a zero episode.
 *
 * @param media
 * @param existingMappings
 * @returns {Promise<[unknown]|[{title: (string|string|*), thumbnail, length, summary, airingAt: *}]|null>}
 */
export async function hasZeroEpisode(media, existingMappings) { // really wish they could make fetching zero episodes less painful.
    if (!media) return null
    const mappings = existingMappings || (await getAniMappings(media.id)) || {}
    const hasZeroEpisode = media.streamingEpisodes?.filter((ep) => { const match = (/Episode (\d+(\.\d+)?) - /).exec(ep.title); return match ? Number.isInteger(parseFloat(match[1])) && Number(parseFloat(match[1])) === 0 : false})
    const zeroAsFirstEpisode = /episode\s*0/i.test(mappings?.episodes?.[1]?.title?.en || mappings?.episodes?.[1]?.title?.jp) // The first episode is titled as Episode 0 so this is likely a Prologue, fixes issues with series like `Fate/stay night: Unlimited Blade Works`
    // no clue what fixed Mushoku but this initial part seems to allow 'Episode 0 : Guardian Fits' to properly be mapped to season 2 part 1, ensure when making changes this doesn't appear on season 1 part 1.
    if (hasZeroEpisode?.length > 0 && ((media.episodes >= media.streamingEpisodes?.length) || zeroAsFirstEpisode)) {
        return [{...hasZeroEpisode[0], title: hasZeroEpisode[0]?.title?.replace('Episode 0 - ', '')}]
    } else if (!(media.episodes && media.episodes === mappings?.episodeCount && media.status === 'FINISHED')) {
        const special = (mappings?.episodes?.S0 || mappings?.episodes?.s0 || mappings?.episodes?.S1 || mappings?.episodes?.s1)
        if (mappings?.specialCount > 0 && special?.airedBeforeEpisodeNumber > 0) { // very likely it's a zero episode, streamingEpisodes were likely just empty...
            return [{title: special.title?.en, thumbnail: special.image, length: special.length, summary: special.summary, airingAt: special.airDateUtc}]
        }
    }
    return null
}

const concurrentRequests = new Map()
let aniRateLimitPromise = null
const aniLimiter = new Bottleneck({
    reservoir: 200,
    reservoirRefreshAmount: 200,
    reservoirRefreshInterval: 30_000,
    maxConcurrent: 15,
    minTime: 80
})
aniLimiter.on('failed', async (error) => {
    if (error.status === 500) return 1
    if (!error.statusText) {
        if (!aniRateLimitPromise) aniRateLimitPromise = sleep(10 * 1000).then(() => { aniRateLimitPromise = null })
        return 10 * 1000
    }
    const time = (Number((error.headers.get('retry-after') || 10)) + 1) * 1000
    if (!aniRateLimitPromise) aniRateLimitPromise = sleep(time).then(() => { aniRateLimitPromise = null })
    return time
})
export async function getAniMappings(anilistID) {
    if (!anilistID) return
    if (concurrentRequests.has(`ani-${anilistID}`)) return concurrentRequests.get(`ani-${anilistID}`)
    const requestPromise = aniLimiter.wrap(async () => {
        await aniRateLimitPromise
        let res = {}
        try {
            res = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistID}`)
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
            if (res.ok) console.log(`(api.ani.zip) Failed getting json from query: ${error.status || 429} - ${error?.message}`)
        }
        if (!res.ok) {
            if (json) {
                for (const error of json?.errors || []) {
                    console.log(`(api.ani.zip) Error occurred with json: ${error.status || 429} - ${error?.message}`)
                }
            } else {
                console.log(`(api.ani.zip) Unknown error occurred query: ${res.status || 429} - ${res?.message}`)
            }
        }
        return json
    })().finally(() => {
        concurrentRequests.delete(`ani-${anilistID}`)
    })
    concurrentRequests.set(`ani-${anilistID}`, requestPromise)
    return requestPromise
}