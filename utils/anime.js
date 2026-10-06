import Bottleneck from 'bottleneck'
import { sleep } from './util.js'

export function getMediaMaxEp (media, playable) {
    if (!media) return 0
    else if (playable) return media.nextAiringEpisode?.episode - 1 || lastAired(media.airingSchedule?.nodes)?.episode || (media.status === 'NOT_YET_RELEASED' ? 0 : media.episodes) || (media.status === 'RELEASING' ? (media.mediaListEntry?.progress ?? 1) : 0)
    else return Math.max(media.airingSchedule?.nodes?.[media.airingSchedule?.nodes?.length - 1]?.episode || 0, media.airingSchedule?.nodes?.length || 0, (!media.streamingEpisodes || (media.status === 'FINISHED' && media.episodes) ? 0 : media.streamingEpisodes?.filter((ep) => { const match = (/Episode (\d+(\.\d+)?) - /).exec(ep.title); return match ? Number.isInteger(parseFloat(match[1])) : false}).length), media.episodes || 0, media.nextAiringEpisode?.episode || 0) || (media.status === 'RELEASING' ? (media.mediaListEntry?.progress ?? 1) : 0)
}

export function lastAired(nodes) {
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
    maxConcurrent: 20,
    minTime: 10
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