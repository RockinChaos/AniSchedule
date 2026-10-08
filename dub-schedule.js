// noinspection JSUnresolvedReference,NpmUsedModulesInstalled

import { calculateWeeksToFetch, delay, daysAgo, fixTime, getWeeksInYear, loadJSON, past, saveJSON, weeksDifference, durationMap, mediaTypeMap, omitNullish, checkThreshold, toSeconds, cadence } from './utils/util.js'
import path from 'path'

const readableDubSchedulePath = './readable/v2/dub-schedule-readable.json'
const dubSchedulePath = './raw/v2/dub-schedule.json'

// query animeschedule for the proper timetables //
async function fetchAiringSchedule(opts) {
    try {
        const res = await fetch(`https://animeschedule.net/api/v3/${opts.type === 'anime' ? `anime/${opts.route}` : `timetables/dub?year=${opts.year}&week=${opts.week}`}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${opts.token}`
            }
        })
        if (!res.ok) {
            if (res.status === 404) return null // No data for this week
            console.error(`Fetch error for ${opts.type === 'anime' ? `anime route for: ${opts.route}` : `dub timetables: for Week ${opts.week}`} with ${res.status}`)
            process.exit(1)
        }
        return await res.json()
    } catch (error) {
        console.error(`Error fetching ${opts.type === 'anime' ? `anime route for: ${opts.route}` : `dub timetables: for Week ${opts.week}`}`, error)
        process.exit(1)
    }
}

function episodeRange(entry) {
    if (entry.episodeNumber === null || entry.episodeNumber === undefined) return []
    const end = Number(entry.episodeNumber)
    const start = Number(entry.subtractedEpisodeNumber) || end
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start > end) return []
    return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function delayKey(entry) {
    const from = toSeconds(entry.delayedFrom)
    const until = toSeconds(entry.delayedUntil)
    // The API currently uses year 0001 when no delay exists. A missing until date may mean suspension.
    if (!from || from < 60 * 60 * 24 * 365 || (!entry.delayedIndefinitely && (!until || until <= from))) return null
    return String(from)
}

/**
 * Builds a flat AniList-shaped dub schedule from all fetched AnimeSchedule weeks.
 *
 * @param {Array<{entries: Array<Object>}>} weeks Fetched AnimeSchedule weeks, each with its timetable entries.
 * @param {Array<Object>} resolvedEntries Entries matched to AniList media, each with a route and media object.
 * @param {string[]} [customRoutes=[]] Routes that use the resolved entry itself instead of timetable rows.
 * @param {string[]} [currentRoutes] Routes still airing, used to predict future episodes. Defaults to every resolved route.
 * @return {Object[]} Media objects sorted by id, each with an airingSchedule of episode nodes. Nullish values are omitted.
 */
export function buildDubSchedule(weeks, resolvedEntries, customRoutes = [], currentRoutes = resolvedEntries.map(entry => entry.route)) {
    const rowsByRoute = new Map()
    const customRouteSet = new Set(customRoutes)
    for (const week of weeks) {
        for (const entry of week.entries || []) {
            if (!entry.route || (entry.airType && entry.airType !== 'dub')) continue
            if (!rowsByRoute.has(entry.route)) rowsByRoute.set(entry.route, [])
            rowsByRoute.get(entry.route).push(entry)
        }
    }

    const mediaById = new Map()
    for (const entry of resolvedEntries) {
        const media = entry.media
        if (!media?.id) continue
        if (!mediaById.has(media.id)) {
            const format = media.format || mediaTypeMap(entry.mediaTypes?.[0]?.route)
            const duration = media.duration ?? entry.lengthMin ?? durationMap[format]
            mediaById.set(media.id, { media: { ...media, format, duration }, explicit: new Map(), total: 0, zeroOffset: media.zeroEpisode ? 1 : 0, predict: false })
        }
        const group = mediaById.get(media.id)
        if (currentRoutes.includes(entry.route)) group.predict = true
        const rows = customRouteSet.has(entry.route) ? [] : [...(rowsByRoute.get(entry.route) || [])]
        const zeroOffset = media.zeroEpisode ? 1 : 0
        if (!rows.length || customRouteSet.has(entry.route)) rows.push(entry)
        const rowEpisodes = row => episodeRange(row).map(episode => episode - zeroOffset)
        // The API repeats current delay notices on historical rows. Those earlier episodes already aired.
        const isBeforeDelay = row => !customRouteSet.has(entry.route) && toSeconds(row.episodeDate) !== null && toSeconds(row.episodeDate) < toSeconds(row.delayedFrom)
        const indefiniteFirst = Math.min(...rows.filter(row => row.delayedIndefinitely && !isBeforeDelay(row)).flatMap(rowEpisodes))
        const delayedGroups = new Map()
        for (const row of rows) {
            const key = delayKey(row)
            if (!key || isBeforeDelay(row)) continue
            const first = rowEpisodes(row)[0]
            if (first !== undefined) delayedGroups.set(key, Math.min(delayedGroups.get(key) ?? Infinity, first))
        }

        for (const row of rows) {
            const episodes = rowEpisodes(row)
            const delayedIndefinitely = !!row.delayedIndefinitely && episodes[0] === indefiniteFirst
            const key = delayKey(row)
            const delayed = !row.delayedIndefinitely && key !== null && episodes[0] === delayedGroups.get(key) && toSeconds(row.delayedUntil) >= toSeconds(row.episodeDate)
            const date = delayed && toSeconds(row.delayedUntil) > toSeconds(row.episodeDate) ? row.delayedUntil : row.episodeDate
            const airingAt = toSeconds(date)
            if (airingAt === null && !delayedIndefinitely) continue
            for (const episode of episodes) {
                if (episode < 0) continue
                group.explicit.set(episode, delayedIndefinitely
                  ? { episode, delayedIndefinitely: true }
                  : { episode, airingAt, ...(delayed ? { delayed: true } : {}) })
            }
        }
        group.total = Math.max(group.total, Number(rows.findLast(row => Number(row.episodes) > 0)?.episodes) || Number(entry.episodes) || 0)
    }

    const result = []
    for (const { media, explicit, total, zeroOffset, predict } of mediaById.values()) {
        const nodes = [...explicit.values()].sort((a, b) => a.episode - b.episode)
        if (!nodes.length) continue
        // Locked historical timetables can miss a single episode. Recover only interior gaps
        // whose date is supported by a repeating weekly slot in the fetched entries.
        const singles = nodes.filter(node => Number.isFinite(node.airingAt) && !node.delayed && !node.delayedIndefinitely
          && nodes.filter(other => other.airingAt === node.airingAt).length === 1)
        const missing = []
        const week = 7 * 24 * 60 * 60
        for (let index = 1; index < nodes.length; index++) {
            const before = nodes[index - 1], after = nodes[index]
            if (after.episode - before.episode !== 2 || !singles.includes(before) || !singles.includes(after)) continue
            const episode = before.episode + 1
            const dates = new Set()
            for (const anchor of singles) {
                const nextWeek = singles.find(node => node.episode > anchor.episode && node.airingAt === anchor.airingAt + week)
                if (!nextWeek) continue
                const episodesPerWeek = nextWeek.episode - anchor.episode
                if ((episode - anchor.episode) % episodesPerWeek !== 0) continue
                dates.add(anchor.airingAt + (episode - anchor.episode) / episodesPerWeek * week)
            }
            const [airingAt] = dates
            if (dates.size === 1 && airingAt > before.airingAt && airingAt < after.airingAt) missing.push({ episode, airingAt })
        }
        nodes.push(...missing)
        nodes.sort((a, b) => a.episode - b.episode)
        const latest = nodes[nodes.length - 1]
        if (predict && total > latest.episode && !nodes.some(node => node.delayedIndefinitely)) {
            const step = cadence(nodes)
            // Repeat the latest verified weekly cycle, preserving multi-day slots and batches.
            const weekAgo = nodes.findLast(node => node.airingAt === latest.airingAt - week && !node.delayed)
            const cycleSize = weekAgo ? latest.episode - weekAgo.episode : 0
            const cycle = nodes.filter(node => node.episode > latest.episode - cycleSize)
            const repeatsWeekly = cycleSize > 0 && cycle.length === cycleSize && cycle.every(node =>
                !node.delayed && nodes.some(previous => previous.episode === node.episode - cycleSize
                  && !previous.delayed && previous.airingAt === node.airingAt - week))
            for (let episode = latest.episode + 1; episode <= total - zeroOffset; episode++) {
                const prior = repeatsWeekly ? nodes.find(node => node.episode === episode - cycleSize) : null
                nodes.push({ episode, airingAt: prior ? prior.airingAt + week : latest.airingAt + step * (episode - latest.episode) })
            }
        }
        nodes.sort((a, b) => (a.airingAt ?? Infinity) - (b.airingAt ?? Infinity) || a.episode - b.episode)

        const { airingSchedule, ...cleanMedia } = media
        const entry = { ...cleanMedia }
        if (nodes[0].episode <= 1 && nodes[0].airingAt > Date.now() / 1_000) entry.unaired = true
        entry.airingSchedule = { nodes }
        result.push(entry)
    }
    return omitNullish(result.sort((a, b) => a.id - b.id))
}


// Write the original format for legacy clients. Nothing here drives the schedule or feed.
async function writeLegacyDubSchedule(airing, order, schedule) {
    const { writeFile } = await import('node:fs/promises')
    const existingLegacySchedule = loadJSON(path.join('./raw/dub-schedule.json'))

    // Each route in airing already comes from its first fetched current/future week.
    // Only collapse repeated routes for legacy output; the primary schedule keeps every slot.
    function filterWeeklyDubTimetables(timetables, now = new Date()) {
        const selected = new Map()
        for (const entries of Map.groupBy(timetables, entry => entry.route).values()) {
            if (entries.length === 1) {
                selected.set(entries[0], entries[0])
                continue
            }
            const ordered = [...entries].sort((a, b) => a.episodeNumber - b.episodeNumber)
            const nextEpisode = ordered.find(entry => new Date(Math.max(new Date(entry.episodeDate), new Date(entry.delayedUntil || entry.episodeDate))) > now)
            // Keep the last aired slot when the week has finished, preserving normal predictions.
            const entry = nextEpisode || ordered[ordered.length - 1]
            selected.set(entry, { ...entry, airsMultipleDaysPerWeek: true })
        }
        return timetables.filter(entry => selected.has(entry)).map(entry => selected.get(entry))
    }

    // Create combined results by mapping the resolved media to airingItems
    let legacySchedule = filterWeeklyDubTimetables(airing).map(({ donghua, status, airType, imageVersionRoute, streams, airingStatus, ...airingItem }) => {
        // Find the resolved media match for the current airing item
        const resolved = order.find(o => o.route === airingItem.route)
        // Legacy clients require a future date even when the release is suspended indefinitely.
        if (airingItem.delayedIndefinitely) {
            const previous = existingLegacySchedule.find(entry => entry.route === airingItem.route)
            airingItem.delayedUntil = previous?.delayedIndefinitely && new Date(previous.delayedUntil) > new Date()
              ? previous.delayedUntil : new Date(new Date().getFullYear() + 6, 0, 1).toISOString()
        }
        const numberOfEpisodes = airingItem.subtractedEpisodeNumber ? (airingItem.episodeNumber - airingItem.subtractedEpisodeNumber) : 1
        const predictedEpisode = airingItem.episodeNumber + ((numberOfEpisodes > 4) && (airingStatus === 'aired') && !airingItem.unaired ? 0
          : ((new Date(airingItem.episodeDate) < new Date()) && (new Date(airingItem.delayedUntil) < new Date()) && (!airingItem.episodes || (airingItem.episodeNumber < airingItem.episodes))
            ? ((airingItem.subtractedEpisodeNumber >= 1 && (airingItem.episodeNumber - airingItem.subtractedEpisodeNumber) > 1 ? (airingItem.episodeNumber - airingItem.subtractedEpisodeNumber) : 0) + 1) : 0))
        const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i)

        return {
            ...airingItem, // Include all original airing list data
            ...(resolved?.media && {
                media: {
                    media: {
                        ...resolved.media,
                        airingSchedule: {
                            nodes: range(airingItem.subtractedEpisodeNumber || predictedEpisode, predictedEpisode).map((ep) => ({
                                episode: ep,
                                airingAt: past(new Date((new Date(airingItem.delayedUntil) < new Date()) ? airingItem.episodeDate : airingItem.delayedUntil), (airingItem.episodeNumber < ep ? 1 : 0), false)
                            }))
                        }
                    }
                }
            })
        }
    })

    // Iterate over legacySchedule to verify against the previous legacy output.
    legacySchedule.forEach((entry, index) => {
        const scheduleMatch = existingLegacySchedule?.find(scheduledItem => scheduledItem.route === legacySchedule[index].route)
        const { verified, addedAt, ...details } = legacySchedule[index]
        if (scheduleMatch) {
            legacySchedule[index] = {
                ...details,
                verified: legacySchedule[index].verified || scheduleMatch.verified || false,
                addedAt: scheduleMatch.addedAt || (legacySchedule[index].unaired ? past(new Date(legacySchedule[index].episodeDate), 0, false) : past(new Date(), 0, false))
            }
            if (!legacySchedule[index].verified && (new Date(new Date(legacySchedule[index].addedAt).getTime() + 14 * 24 * 60 * 60 * 1_000) <= new Date())) {
                legacySchedule[index] = {
                    ...details,
                    verified: true,
                    addedAt: scheduleMatch.addedAt
                }
                console.log(`Verified ${legacySchedule[index].media.media.title.english ?? legacySchedule[index].media.media.title.romaji ?? legacySchedule[index].media.media.title.native} as it has been on the timetables for a full two weeks.`)
            }
        } else {
            legacySchedule[index] = {
                ...details,
                verified: !!verified,
                addedAt: legacySchedule[index].unaired ? past(new Date(legacySchedule[index].episodeDate), 0, false) : past(new Date(), 0, false)
            }
        }
    })

    // Keep legacy entries for suspended titles retained by the primary schedule.
    for (const entry of existingLegacySchedule) {
        if (!legacySchedule.some(item => item.route === entry.route
          || (entry.media?.media?.id && item.media?.media?.id === entry.media.media.id)
          || (entry.media?.media?.idMal && item.media?.media?.idMal === entry.media.media.idMal))
          && schedule.some(media => media.id === entry.media?.media?.id && media.airingSchedule?.nodes.some(node => node.delayedIndefinitely))) {
            legacySchedule.push({ ...entry, delayedIndefinitely: true })
        }
    }
    legacySchedule.sort((a, b) => a.title.localeCompare(b.title))
    await writeFile('./raw/dub-schedule.json', JSON.stringify(omitNullish(legacySchedule)))
    await writeFile('./readable/dub-schedule-readable.json', JSON.stringify(omitNullish(legacySchedule), null, 2))
}

// update dub schedule //
export async function fetchDubSchedule() {
    const changes = []

    const { writeFile } = await import('node:fs/promises')
    const { anilistClient } = await import('./utils/anilist.js')
    const { malDubs } = await import('./utils/animedubs.js')

    const BEARER_TOKEN = process.env.ANIMESCHEDULE_TOKEN
    if (!BEARER_TOKEN) {
        console.error('Error: ANIMESCHEDULE_TOKEN environment variable is not defined.')
        process.exit(1)
    }

    // Fetch airing lists //

    let airingLists = []
    const fetchedWeeks = []
    const existingSchedule = loadJSON(dubSchedulePath)

    console.log(`Getting dub airing schedule`)

    const { startYear, startWeek, endYear, endWeek } = calculateWeeksToFetch()
    let year = startYear
    let week = startWeek
    // Fixed comparison window: past weeks are frozen snapshots, not live schedule updates.
    for (let previous = 0; previous < 3; previous++) {
        if (--week < 1) week = getWeeksInYear(--year)
    }

    while (year < endYear || (year === endYear && week <= endWeek)) {
        console.log(`Fetching dub timetables for Year ${year}, Week ${week}...`)
        const fetchedData = await fetchAiringSchedule({type: 'timetables', year, week, token: BEARER_TOKEN})
        if (fetchedData) {
            // Keep every fetched week for episode nodes.
            fetchedWeeks.push({ year, week, entries: structuredClone(fetchedData) })
            // Prior weeks supply historical nodes; current/future weeks select the current row.
            if (year > startYear || (year === startYear && week >= startWeek)) {
                const newEntries = fetchedData.filter((item) => !airingLists.some((existing) => existing.route === item.route))
                airingLists = [...airingLists, ...newEntries]
            }
        }
        await delay(500)

        week++
        if (week > getWeeksInYear(year)) {
            week = 1
            year++
        }
    }

    // Handle custom dubs
    let customDubs = loadJSON(path.join('./custom/custom-dubs.json'))
    const exactCustomDubs = structuredClone(customDubs)
    const customHistory = []
    if (customDubs?.length) {
        console.log(`Detected ${customDubs?.length} custom dubs, handling...`)
        for (const dub of customDubs) {
            const episodeDate = new Date(dub.episodeDate)
            const delayedUntil = new Date(dub.delayedUntil)
            const releaseDate = delayedUntil >= episodeDate ? delayedUntil : episodeDate
            if (!dub.delayedIndefinitely && releaseDate < new Date()) {
                customHistory.push(structuredClone(dub))
                console.log(`Custom dub ${dub.route} has passed its release date ${releaseDate.toISOString()}, updating to reflect the next episode's air date.`)
                dub.episodeDate = past(releaseDate, 1, true)
                dub.episodeNumber = dub.episodeNumber + 1
                delete dub.subtractedEpisodeNumber // The completed batch is retained in customHistory.
                dub.airingStatus = 'aired'
                if (delayedUntil >= episodeDate) {
                    dub.delayedFrom = '0001-01-01T00:00:00Z'
                    dub.delayedUntil = '0001-01-01T00:00:00Z'
                    delete dub.delayedIndefinitely
                    delete dub.delayedText
                }
            }
        }
    }
    // Filter out completed custom dubs.
    customDubs = customDubs.filter(dub => {
        if (dub.episodes && dub.episodeNumber > dub.episodes) {
            console.log(`Removing ${dub.route} as it has exceeded the episode count (${dub.episodeNumber}/${dub.episodes}), this means it has likely finished airing.`)
            return false
        }
        return true
    })
    const customSources = [...customDubs, ...customHistory]
    airingLists = [...airingLists.filter(entry => !customSources.some(dub => dub.route === entry.route)), ...customDubs]

    // Need to filter to ensure only dubs are fetched, the api sometimes includes raw airType...
    airingLists = airingLists.filter(item => !item.airType || item.airType === 'dub').sort((a, b) => a.title.localeCompare(b.title))
    console.log(`Retrieved ${airingLists.length} current/future entries (including custom dubs), covering ${new Set(airingLists.map(entry => entry.route)).size} routes.`)

    // end of fetch airing lists //


    // resolve airing lists //

    // Resolve historical-only titles too, using their latest snapshot for route metadata.
    const previousEntries = [...new Map(fetchedWeeks.filter(week => week.year < startYear || (week.year === startYear && week.week < startWeek))
      .flatMap(week => week.entries).map(entry => [entry.route, entry])).values()]
    let airing = [...airingLists, ...previousEntries.filter(entry => (!entry.airType || entry.airType === 'dub')
      && !airingLists.some(current => current.route === entry.route) && !customSources.some(dub => dub.route === entry.route)),
      ...customHistory.filter(entry => !airingLists.some(current => current.route === entry.route))]
    const mediaID = /(?:https?:\/\/)?(?:www\.)?(?:myanimelist\.net\/anime\/|anilist\.co\/anime\/)(\d+)/
    const order = [] // { route, media }

    // airing.forEach((entry) => { // HACK: Stupid fixes for AniList breaking up series into multiple entries.
    //     if (entry.route === 'kimetsu-no-yaiba-movie-mugen-jou-hen') { // Demon Slayer: Infinity Castle, this is broken up into three parts instead of nesting.
    //         if (entry.episodeNumber === 1) entry.romaji = 'Kimetsu no Yaiba: Mugenjou-hen Movie 1 - Akaza Sairai'
    //         else if (entry.episodeNumber === 2) entry.romaji = 'Kimetsu no Yaiba: Mugenjou-hen Movie 2'
    //         else if (entry.episodeNumber === 3) entry.romaji = 'Kimetsu no Yaiba: Mugenjou-hen Movie 3'
    //     }
    // })

    // Fetch schedule details (which include website links) for every route.
    // Custom entries may already provide their website links.
    const scheduleDetails = await Promise.all(airing.map(entry => entry.websites
      ? { route: entry.route, websites: entry.websites, dubEpisodeOverride: { overrideDate: entry.overrideDate } }
      : fetchAiringSchedule({ type: 'anime', route: entry.route, token: BEARER_TOKEN })))

    const aniListIds = []
    const malIds = []
    const idLookup = [] // { route, id, isAniList }

    airing.forEach((entry, index) => {
        const detail = scheduleDetails[index]
        const url = detail?.websites?.aniList || detail?.websites?.mal
        const match = url?.match(mediaID)
        if (!match) {
            changes.push(`No AniList/MAL URL found for ${entry.route}, cannot resolve, this is a BIG deal!!`)
            console.log(`Failed to find an AniList/MAL URL for route ${entry.route}`)
            return
        }
        idLookup.push({ route: entry.route, id: match[1], isAniList: !!detail?.websites?.aniList })
        if (!!detail?.websites?.aniList) aniListIds.push(Number(match[1]))
        else malIds.push(Number(match[1]))
    })

    // Batch resolve every ID in as few requests as possible.
    const [aniListResults, malResults] = await Promise.all([
        aniListIds.length ? anilistClient.searchAllIDS({ id: aniListIds, perPage: aniListIds.length }) : null,
        malIds.length ? anilistClient.searchAllIDS({ idMal: malIds, perPage: malIds.length }) : null
    ])

    const resolvedMedia = omitNullish([ ...(aniListResults?.data?.Page?.media || []), ...(malResults?.data?.Page?.media || []) ])
    for (const { route, id, isAniList } of idLookup) {
        const media = resolvedMedia.find(media => isAniList ? String(media.id) === String(id) : String(media.idMal) === String(id))
        if (media) {
            order.push({ route, media })
            console.log(`Resolved route ${route} via ${isAniList ? 'AniList' : 'MAL'} ID ${id} as ${media.title.english ?? media.title.romaji ?? media.title.native}`)
        } else {
            changes.push(`Failed to resolve route ${route} via ID ${id}, things will not work as expected, this is a BIG deal!!`)
            console.log(`Failed to resolve route ${route} via ID ${id}`)
        }
    }

    // Custom dubs take priority, completely replacing matching API routes including every historical/future row.
    const customMedia = order.filter(entry => customSources.some(dub => dub.route === entry.route)).map(entry => entry.media)
    const overriddenRoutes = new Set(order.filter(entry => customMedia.some(media =>
        (media.id && media.id === entry.media.id) || (media.idMal && media.idMal === entry.media.idMal)
    )).map(entry => entry.route))
    airing = airing.filter(entry => customSources.includes(entry) || !overriddenRoutes.has(entry.route))
    for (const week of fetchedWeeks) week.entries = week.entries.filter(entry => !overriddenRoutes.has(entry.route))

    const scheduleDetailsMap = new Map(scheduleDetails.filter(Boolean).map(detail => [detail.route, detail]))

    // modify timetables entries for better functionality and fix any offset minutes.
    for (const entry of [...fetchedWeeks.flatMap(week => week.entries), ...airing]) {
        const detail = scheduleDetailsMap.get(entry.route)
        if (detail?.dubEpisodeOverride?.overrideDate) entry.overrideDate = detail.dubEpisodeOverride.overrideDate

        // Custom timestamps are explicit, including delays and the cadence anchored to them.
        if (!customSources.includes(entry)) {
            const episodeDate = new Date(entry.episodeDate)
            episodeDate.setMinutes(Math.floor((episodeDate.getMinutes() + 1) / 5) * 5, 0)
            if (Number.isFinite(episodeDate.getTime())) entry.episodeDate = past(episodeDate, 0, true)
            if (entry.delayedFrom && toSeconds(entry.episodeDate) !== null) entry.delayedFrom = fixTime(entry.delayedFrom, entry.episodeDate)
            if (entry.delayedUntil && toSeconds(entry.episodeDate) !== null) entry.delayedUntil = fixTime(entry.delayedUntil, entry.episodeDate)
        }
        entry.unaired = ((entry.episodeNumber <= 1 || (entry.subtractedEpisodeNumber <= 1 && entry.episodeNumber > 1)) && Math.floor(new Date(entry.episodeDate).getTime()) > Math.floor(Date.now()))
        // highly likely this is an indefinitely delayed series.
        // An elapsed delay with no end date remains indefinite, even after four weeks.
        const openEndedDelay = new Date(entry.delayedFrom).getUTCFullYear() > 1
          && new Date(entry.delayedFrom) < new Date()
          && (entry.delayedUntil == null || new Date(entry.delayedUntil).getUTCFullYear() <= 1)
        if (openEndedDelay || (weeksDifference(entry.delayedFrom, past(new Date(), 0, true)) <= 4
          && new Date(entry.delayedFrom) > new Date(entry.delayedUntil)
          && daysAgo(new Date(entry.delayedFrom)) >= -4)) entry.delayedIndefinitely = true
    }

    // Ensure all media on the schedule HAS a planned dub
    const resolvedEntries = airing.map(entry => ({ ...entry, media: order.find(item => item.route === entry.route)?.media })).filter(entry => {
        if (malDubs.isDubMedia(entry)) return true
        console.error(`Found unexpected media ${entry.media?.title?.english ?? entry.media?.title?.romaji ?? entry.media?.title?.native} on the dub schedule, this does not have a planned dub!`)
        return false
    })
    if (resolvedEntries.length !== airing.length) {
        changes.push(`Something is wrong! There are ${resolvedEntries.length} dub titles resolved and there are ${airing.length} dub titles in the timetables, less than what is expected!`)
        console.error(changes[changes.length - 1])
    }

    const customRoutes = customSources.map(dub => dub.route)
    const references = customHistory.filter(entry => customDubs.some(dub => dub.route === entry.route)).map(entry => ({
        ...entry, media: resolvedEntries.find(resolved => resolved.route === entry.route)?.media
    }))
    const correctionSchedule = buildDubSchedule(fetchedWeeks, [...resolvedEntries, ...references], customRoutes, airingLists.map(entry => entry.route))
    // Re-add indefinitely delayed series omitted from the timetables, using primary nodes.
    for (const media of existingSchedule) {
        if (!correctionSchedule.some(entry => entry.id === media.id || (media.idMal && entry.idMal === media.idMal)) && media.airingSchedule?.nodes.some(node => node.delayedIndefinitely)
          && malDubs.isDubMedia({ media })) correctionSchedule.push(omitNullish(media))
    }
    const now = Date.now() / 1_000
    const currentIds = new Set(resolvedEntries.filter(entry => airingLists.some(current => current.route === entry.route)).map(entry => entry.media.id))
    const schedule = correctionSchedule.map(media => ({ ...media, airingSchedule: {
        nodes: media.airingSchedule.nodes.filter(node => node.delayedIndefinitely || (currentIds.has(media.id) && node.airingAt > now))
    } })).filter(media => media.airingSchedule.nodes.length).sort((a, b) => a.id - b.id)
    const scheduleWarning = checkThreshold(schedule, existingSchedule)
    if (scheduleWarning) changes.push(scheduleWarning)
    // Validate the proposed schedule before writing any feed, custom entry or manifest changes.
    changes.push(...await updateDubFeed(false, correctionSchedule))
    if (JSON.stringify(customDubs) !== JSON.stringify(exactCustomDubs)) {
        console.log(`Changes detected in the custom dubs lists.... saved!`)
        saveJSON(path.join('./custom/custom-dubs.json'), customDubs, true)
    }
    const scheduleChanged = JSON.stringify(schedule) !== JSON.stringify(existingSchedule)
    // skip zero episode checks, this causes issues. TODO: Improve accuracy.
    //combinedResults = await correctZeroEpisodes('Dub', combinedResults, exactSchedule, existingDubbedFeed, changes)
    console.log(`Resolved ${resolvedEntries.length} entries across ${new Set(resolvedEntries.map(entry => entry.media.id)).size} series.`)
    console.log(`Saving ${schedule.length} series with upcoming or indefinitely delayed episodes to the dub schedule...`)
    await writeFile(dubSchedulePath, JSON.stringify(schedule))
    await writeFile(readableDubSchedulePath, JSON.stringify(schedule, null, 2))
    await writeLegacyDubSchedule(resolvedEntries.filter(entry => airingLists.some(current => current.route === entry.route)), order, schedule)
    if (scheduleChanged) {
        const lastUpdated = loadJSON(path.join('./raw/last-updated.json'))
        lastUpdated.dubbed.schedule = past(new Date(), 0, true)
        saveJSON(path.join('./raw/last-updated.json'), lastUpdated)
        saveJSON(path.join('./readable/last-updated-readable.json'), lastUpdated, true)
    }

    // end of resolve airing lists //
    return changes
}

// update dub schedule episode feed //
export async function updateDubFeed(scheduleUpdate = false, newSchedule) {
    const schedule = newSchedule ?? loadJSON(dubSchedulePath)
    const exactFeed = loadJSON(path.join('./raw/dub-episode-feed.json'))
    const now = Date.now()
    const releaseCutoff = now + (scheduleUpdate ? 2 * 60 * 1_000 : 0)
    const changes = []
    const feed = new Map()
    const key = (id, episode) => `${id}:${episode}`
    for (const entry of exactFeed) {
        const id = key(entry.id, entry.episode.aired)
        if (!feed.has(id)) feed.set(id, structuredClone(entry))
        else changes.push(`(Dub) Removed duplicate Episode ${entry.episode.aired} for media ${entry.id}`)
    }

    for (const media of schedule) {
        if (!media?.id) continue
        const title = media.title?.english ?? media.title?.romaji ?? String(media.id)
        const nodes = new Map((media.airingSchedule?.nodes || [])
          .filter(node => Number.isInteger(node.episode) && node.episode >= 0)
          .map(node => [node.episode, node]))
        const metadata = entry => omitNullish({
            ...entry,
            // Episode zero can refer to a separate MAL special.
            idMal: entry.episode.aired === 0 ? entry.idMal : (media.idMal ?? entry.idMal),
            format: media.format ?? entry.format,
            duration: media.duration ?? entry.duration ?? durationMap[media.format]
        })

        // handle single new episodes and double-header (multi-header) releases
        for (const node of nodes.values()) {
            const id = key(media.id, node.episode)
            const existing = feed.get(id)
            const dated = typeof node.airingAt === 'number' && Number.isFinite(node.airingAt)
              && Number.isFinite(new Date(node.airingAt * 1_000).getTime())
            // Filter out delayed episodes and incorrect episodes that have not actually released.
            // Keep an unchanged buffered release within the two-minute retention allowance.
            const buffered = existing && Date.parse(existing.episode.airedAt) === node.airingAt * 1_000
              && node.airingAt * 1_000 <= now + 2 * 60 * 1_000
            if (node.delayedIndefinitely || (dated && node.airingAt * 1_000 > releaseCutoff && !buffered)) {
                if (feed.delete(id)) changes.push(`(Dub) Removed Episode ${node.episode} of ${title} as ${node.delayedIndefinitely ? 'it is delayed indefinitely' : 'its air date is in the future'}`)
                continue
            }
            // Missing dates are not evidence of release or cancellation.
            if (!dated || node.airingAt * 1_000 > releaseCutoff) continue
            const airedAt = past(new Date(node.airingAt * 1_000), 0, false)
            // Correct dates, including same-day time adjustments, only for explicit nodes.
            // Prevents cascading time corrections into older episodes, including across DST.
            if (existing) {
                if (Date.parse(existing.episode.airedAt) !== node.airingAt * 1_000) {
                    changes.push(`(Dub) Modified Episode ${node.episode} of ${title} from ${existing.episode.airedAt} to ${airedAt}`)
                    existing.episode.airedAt = airedAt
                }
            } else {
                feed.set(id, metadata({
                    id: media.id,
                    ...(media.idMal ? { idMal: media.idMal } : {}),
                    episode: { aired: node.episode, airedAt, addedAt: past(new Date(now), 0, true) }
                }))
                changes.push(`(Dub) Added Episode ${node.episode} for ${title}`)
            }
        }

        // Correct metadata even for historical episodes outside the current node window.
        for (const [id, entry] of feed) {
            if (entry.id !== media.id) continue
            const corrected = metadata(entry)
            if (JSON.stringify(corrected) !== JSON.stringify(entry)) {
                feed.set(id, corrected)
                changes.push(`(Dub) Updated Episode ${entry.episode.aired} for ${title} to correct its idMal, format, and duration.`)
            }
        }

        // fix missing episodes (multi-header) releases
        // Historical inference runs only with freshly fetched timetables during a schedule refresh.
        if (!newSchedule) continue
        // Infer missing episode dates when no explicit node exists.
        const released = [...feed.values()].filter(entry => entry.id === media.id)
        const anchors = new Map(released.map(entry => [entry.episode.aired, { episode: entry.episode.aired, airingAt: toSeconds(entry.episode.airedAt) }]))
        for (const node of nodes.values()) {
            if (Number.isFinite(node.airingAt) && !node.delayedIndefinitely) anchors.set(node.episode, node)
        }
        const dated = [...anchors.values()].filter(node => Number.isFinite(node.airingAt)).sort((a, b) => a.episode - b.episode)
        const week = 7 * 24 * 60 * 60
        // Match the same release slot one week apart, including multi-day schedules.
        const singles = dated.filter(node => dated.filter(other => other.airingAt === node.airingAt).length === 1 && !node.delayed)
        let episodesPerWeek = 1
        for (const node of singles) {
            const nextWeek = singles.find(other => other.episode > node.episode && other.airingAt === node.airingAt + week)
            if (nextWeek) { episodesPerWeek = nextWeek.episode - node.episode; break }
        }
        const firstLogged = exactFeed.filter(entry => entry.id === media.id).sort((a, b) => a.episode.aired - b.episode.aired)[0]
        // fix for when no episodes in the feed but episode(s) have already aired
        // Repair missing premieres only near the start of a series. A high-numbered
        // first appearance must not cause its entire earlier history to be invented.
        const firstKnown = Math.min(firstLogged?.episode.aired ?? Infinity, ...nodes.keys())
        const firstEpisode = firstKnown < 4 ? (media.zeroEpisode ? 0 : 1) : firstKnown
        const latest = Math.max(-1, ...released.map(entry => entry.episode.aired), nodes.size ? Math.min(...nodes.keys()) - 1 : -1)
        for (let episode = firstEpisode; episode <= latest; episode++) {
            if (feed.has(key(media.id, episode)) || nodes.has(episode)) continue
            const before = dated.findLast(node => node.episode < episode)
            const after = dated.find(node => node.episode > episode)
            const anchor = dated.filter(node => !node.delayed && (node.episode - episode) % episodesPerWeek === 0)
              .sort((a, b) => Math.abs(a.episode - episode) - Math.abs(b.episode - episode) || b.episode - a.episode)[0]
            let airingAt = before && after && before.airingAt === after.airingAt ? before.airingAt
              : anchor ? anchor.airingAt + (episode - anchor.episode) / episodesPerWeek * week : null
            // A compressed release gap is a batch, not a date before its preceding episode.
            if (airingAt !== null && before && airingAt < before.airingAt) airingAt = before.airingAt
            if (airingAt === null || airingAt * 1_000 > now || (after && airingAt > after.airingAt)) continue
            feed.set(key(media.id, episode), metadata({
                id: media.id,
                ...(media.idMal ? { idMal: media.idMal } : {}),
                episode: { aired: episode, airedAt: past(new Date(airingAt * 1_000), 0, true), addedAt: past(new Date(now), 0, true) }
            }))
            changes.push(`(Dub) Added Missing Episode ${episode} for ${title}`)
        }
    }

    // Keep batches together, with their highest episode first, then newest release first.
    const groups = new Map()
    for (const entry of feed.values()) {
        const id = `${entry.id}:${entry.episode.airedAt}`
        if (!groups.has(id)) groups.set(id, [])
        groups.get(id).push(entry)
    }
    const result = [...groups.values()].flatMap(group => group.sort((a, b) => b.episode.aired - a.episode.aired))
        .sort((a, b) => Date.parse(b.episode.airedAt) - Date.parse(a.episode.airedAt))
        // Preserve the original property order for new, repaired and existing feed entries.
        .map(({ id, idMal, format, duration, episode, ...rest }) => omitNullish({ id, idMal, format, duration, ...rest, episode }))
    const feedChanged = JSON.stringify(result) !== JSON.stringify(exactFeed)
    if (!changes.length && feedChanged) changes.push('(Dub) Modified episode feed ordering')
    for (const change of changes) console.log(change)

    if (feedChanged) { // helps prevent rebase conflicts
        const lastUpdated = loadJSON(path.join('./raw/last-updated.json'))
        saveJSON(path.join('./raw/dub-episode-feed.json'), result)
        saveJSON(path.join('./readable/dub-episode-feed-readable.json'), result, true)
        lastUpdated.dubbed.episodes = past(new Date(), 0, true)
        saveJSON(path.join('./raw/last-updated.json'), lastUpdated)
        saveJSON(path.join('./readable/last-updated-readable.json'), lastUpdated, true)
        console.log(`Logged a total of ${result.length} Dubbed Episodes to date.`)
    } else {
        console.log('No changes detected for the Dubbed Episodes Feed.')
    }
    return changes
}
