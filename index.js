// noinspection JSUnresolvedReference,NpmUsedModulesInstalled

import fs from 'fs'
import path from 'path'
import { past, dayTimeMatch, weeksDifference } from './utils/util.js'
await fs.mkdir('./readable', { recursive: true }, () => {})

if (!process.argv.includes('update-feeds')) {

    const { writeFile } = await import('node:fs/promises')
    const { writable } =  await import('simple-store-svelte')
    const { default: AnimeResolver } = await import('./utils/animeresolver.js')

    const BEARER_TOKEN = process.env.ANIMESCHEDULE_TOKEN
    if (!BEARER_TOKEN) {
        console.error('Error: ANIMESCHEDULE_TOKEN environment variable is not defined.')
        process.exit(1)
    }

    // Fetch airing lists //

    let airingLists = writable()

    console.log(`Getting dub airing schedule`)
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

    if (await airingLists.value) {
        console.log(`Successfully retrieved ${airingLists.value.length} airing series, saving...`)
        airingLists.value.sort((a, b) => a.title.localeCompare(b.title))
        await writeFile('dub-schedule.json', JSON.stringify(airingLists.value))
        await writeFile('./readable/dub-schedule-readable.json', JSON.stringify(airingLists.value, null, 2))
    } else {
        console.error('Error: Failed to fetch the dub airing schedule, it cannot be null!')
        process.exit(1)
    }

    // end of airing lists //

    // resolve airing lists //

    const airing = await airingLists.value
    const titles = []
    const order = []

    // Resolve routes as titles
    const parseObjs = await AnimeResolver.findAndCacheTitle(airing.map(item => item.route))

    for (const parseObj of parseObjs) {
        const media = AnimeResolver.animeNameCache[AnimeResolver.getCacheKeyForTitle(parseObj)]
        console.log(`Resolving route ${parseObj?.anime_title} ${media?.title?.userPreferred}`)
        let item

        if (!media) { // Resolve failed routes
            console.log(`Failed to resolve, trying alternative title ${parseObj?.anime_title}`)
            item = airing.find(i => i.route === parseObj.anime_title)
            const fallbackTitles = await AnimeResolver.findAndCacheTitle([item.romaji, item.native, item.english, item.title].filter(Boolean))
            for (const parseObjAlt of fallbackTitles) {
                const mediaAlt = AnimeResolver.animeNameCache[AnimeResolver.getCacheKeyForTitle(parseObjAlt)]
                if (mediaAlt) {
                    titles.push(parseObjAlt.anime_title)
                    order.push({route: item.route, title: mediaAlt.title.userPreferred})
                    console.log(`Resolved alternative title ${parseObjAlt?.anime_title} ${mediaAlt?.title?.userPreferred}`)
                    break
                }
            }
        } else {
            item = airing.find(i => i.route === parseObj.anime_title)
            if (item) {
                titles.push(parseObj.anime_title)
                order.push({route: item.route, title: media.title.userPreferred})
                console.log(`Resolved route ${parseObj?.anime_title} ${media?.title?.userPreferred}`)
            }
        }
    }

    // Only adjust delayedUntil time if the date is the same or later than the episode date
    function fixDelayed(delayedDate, episodeDate) {
        const delayedUntil = new Date(delayedDate)
        const episodeAt = new Date(episodeDate)
        delayedUntil.setUTCHours(0, 0, 0, 0)
        episodeAt.setUTCHours(0, 0, 0, 0)

        if (delayedUntil >= episodeAt) {
            const episodeAtDate = new Date(episodeDate)
            delayedUntil.setUTCHours(episodeAtDate.getUTCHours())
            delayedUntil.setUTCMinutes(episodeAtDate.getUTCMinutes())
            delayedUntil.setUTCSeconds(episodeAtDate.getUTCSeconds())
        }
        return past(new Date(delayedUntil), 0, false)
    }

    // Resolve found titles
    const results = await AnimeResolver.resolveFileAnime(titles)
    for (const entry of order) { // remap dub airingSchedule to results airingSchedule
        const mediaMatch = results.find(result => result.media?.title?.userPreferred === entry.title)
        if (mediaMatch) {
            const airingItem = airing.find(i => i.route === entry.route)
            if (airingItem) {
                console.log(`Mapping dubbed airing schedule for ${airingItem.route} ${mediaMatch.media?.title?.userPreferred}`)
                mediaMatch.media.airingSchedule = {
                    nodes: [
                        {
                            episode: airingItem.episodeNumber + ((new Date(airingItem.episodeDate) < new Date()) && (new Date(fixDelayed(airingItem.delayedUntil, airingItem.episodeDate)) < new Date()) ? 1 : 0),
                            airingAt: past(new Date(airingItem.episodeDate), 1, false),
                            episodeNumber: airingItem.episodeNumber,
                            episodeDate: airingItem.episodeDate,
                            delayedUntil: fixDelayed(airingItem.delayedUntil, airingItem.episodeDate),
                            unaired: (airingItem.episodeNumber <= 1 && Math.floor(new Date(airingItem.episodeDate).getTime()) > Math.floor(Date.now()))
                        },
                    ],
                }
            }
        }
    }

    if (results) {
        console.log(`Successfully resolved ${results.length} airing, saving...`)
        await writeFile('dub-schedule-resolved.json', JSON.stringify(results))
        await writeFile('./readable/dub-schedule-resolved-readable.json', JSON.stringify(results, null, 2))
    } else {
        console.error('Error: Failed to resolve the dub airing schedule, it cannot be null!')
        process.exit(1)
    }

    // end of resolve airing lists //
}

// update dub schedule feed //

function updateFeeds() {

    const scheduleFilePath = path.join('dub-schedule-resolved.json')
    const feedFilePath = path.join('dub-episode-feed.json')

    function loadJSON(filePath) {
        if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify([]))
        return JSON.parse(fs.readFileSync(filePath))
    }

    function ensureDirectoryExists(filePath) {
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }
    }

    function saveJSON(filePath, data, prettyPrint = false) {
        ensureDirectoryExists(filePath)
        fs.writeFileSync(filePath, JSON.stringify(data, null, prettyPrint ? 2 : 0))
    }

    const schedule = loadJSON(scheduleFilePath)
    let existingFeed = loadJSON(feedFilePath)
    const removedEpisodes = []
    const modifiedEpisodes = []

    // Filter out any existing episode feed entries that matches any delayed episodes
    schedule.filter(entry => {
        const airing = entry.media.airingSchedule.nodes[0]
        return new Date(airing.delayedUntil) >= new Date(airing.episodeDate)
    }).forEach(entry => {
        existingFeed = existingFeed.filter(episode => {
            const foundEpisode = (episode.id === entry.media.id && episode.episode.aired === entry.media.airingSchedule.nodes[0].episodeNumber)
            if (foundEpisode) {
                console.log(`Removing ${entry.media.title.userPreferred} from the Dubbed Episode Feed as it has been delayed!`)
                removedEpisodes.push(entry.media)
            }
            return !foundEpisode
        })
    })

    // Filter out any incorrect episodes (last released) based on corrected air dates in the schedule and update all related episodes airing date.
    schedule.forEach(entry => {
        const airing = entry.media.airingSchedule.nodes[0]
        existingFeed = existingFeed.filter(episode => {
            const foundEpisode = (episode.id === entry.media.id) && (episode.episode.aired === airing.episodeNumber) && (new Date(episode.episode.airedAt) < new Date(airing.episodeDate))
            if (foundEpisode) {
                console.log(`Removing episode ${airing.episodeNumber} of ${entry.media.title.userPreferred} from the Dubbed Episode Feed due to a correction in the airing date`)
                removedEpisodes.push(episode)
            }
            return !foundEpisode
        })
    })

    // Filter out incorrect episodes and correct dates if necessary
    schedule.forEach(entry => {
        const airing = entry.media.airingSchedule.nodes[0]
        const latestEpisodeInFeed = existingFeed.filter(episode => episode.id === entry.media.id).sort((a, b) => b.episode.aired - a.episode.aired)[0]
        if (latestEpisodeInFeed && !dayTimeMatch(new Date(latestEpisodeInFeed.episode.airedAt), new Date(airing.episodeDate))) {
            let mediaEpisodes = existingFeed.filter(episode => episode.id === entry.media.id)
            mediaEpisodes.sort((a, b) => b.episode.aired - a.episode.aired)  // Sort by episode number in descending order
            console.log(`Modifying existing episodes of ${entry.media.title.userPreferred} from the Dubbed Episode Feed due to a correction in the airing date`)
            const originalAiredAt = mediaEpisodes.map(episode => episode.episode.airedAt)
            let correctedDate = -1
            mediaEpisodes.forEach((episode, index) => {
                const prevDate = episode.episode.airedAt
                if (index !== 0) correctedDate = correctedDate - weeksDifference(episode.episode.airedAt, originalAiredAt[index - 1])
                episode.episode.airedAt = past(new Date(airing.episodeDate), correctedDate, true)
                console.log(`Modified episode ${episode.episode.aired} of ${entry.media.title.userPreferred} from the Dubbed Episode Feed with aired date from ${prevDate} to ${episode.episode.airedAt}`)
                modifiedEpisodes.push(episode)
            })
        }
    })

    const newEpisodes = schedule.flatMap(entry => {
        let newEpisodes = []
        const airing = entry.media.airingSchedule.nodes[0]

        // handle double-header (multi-header) releases
        const latestEpisode = airing.episodeNumber
        const existingEpisodes = existingFeed.filter(media => media.id === entry.media.id)
        const lastFeedEpisode = existingEpisodes.reduce((max, ep) => Math.max(max, ep.episode.aired), 0)

        for (let episodeNum = lastFeedEpisode + 1; episodeNum < latestEpisode; episodeNum++) {
            let baseEpisode = existingEpisodes.find(ep => ep.episode.aired <= episodeNum) || existingEpisodes.find(ep => ep.episode.aired === lastFeedEpisode)
            if (!baseEpisode && latestEpisode > episodeNum) { // fix for when no episodes in the feed but episode(s) have already aired
                let weeksAgo = -1
                let pastDate = past(new Date(airing.episodeDate), weeksAgo, true)
                while (new Date(pastDate) >= new Date()) {
                    weeksAgo--
                    pastDate = past(new Date(airing.episodeDate), weeksAgo, true)
                }
                baseEpisode = {
                    episode: {
                        aired: episodeNum,
                        airedAt: pastDate
                    }
                }
            }

            // fix missing episodes (multi-header) releases
            const batchEpisode = {
                id: entry.media.id,
                idMal: entry.media.idMal,
                episode: {
                    aired: episodeNum,
                    airedAt: baseEpisode.episode.airedAt
                }
            }

            newEpisodes.push(batchEpisode)
            console.log(`Adding missing (multi-header) release Episode ${batchEpisode.episode.aired} for ${entry.media.title.userPreferred} to the Dubbed Episode Feed.`)
        }

        // handle single new episodes
        const newEpisode = {
            id: entry.media.id,
            idMal: entry.media.idMal,
            episode: {
                aired: latestEpisode,
                airedAt: airing.episodeDate
            }
        }

        if (!airing.unaired && airing.episodeNumber !== lastFeedEpisode && new Date(newEpisode.episode.airedAt) <= new Date() && new Date(airing.delayedUntil) <= new Date(newEpisode.episode.airedAt)) {
            newEpisodes.push(newEpisode)
            console.log(`Adding Episode ${newEpisode.episode.aired} for ${entry.media.title.userPreferred} to the Dubbed Episode Feed.`)
        }

        return newEpisodes
    }).filter(({ id, episode }) => {
        return !existingFeed.some(media => media.id === id && media.episode.aired === episode.aired)
    }).sort((a, b) => b.episode.aired - a.episode.aired)

    const newFeed = [...newEpisodes, ...existingFeed].sort((a, b) => new Date(b.episode.airedAt).getTime() - new Date(a.episode.airedAt).getTime())
    saveJSON(feedFilePath, newFeed)
    saveJSON(path.join('./readable/dub-episode-feed-readable.json'), newFeed, true)

    if (newEpisodes.length > 0 || modifiedEpisodes.length > 0 || removedEpisodes.length > 0) {
        console.log(`${newEpisodes.length > 0 ? `Added ${newEpisodes.length}` : ``}${modifiedEpisodes.length > 0 ? `${newEpisodes.length > 0 ? ` and ` : ``}Modified ${modifiedEpisodes.length}` : ``}${removedEpisodes.length > 0 ? `${(newEpisodes.length > 0) || (modifiedEpisodes.length > 0) ? ` and ` : ``}Removed ${removedEpisodes.length}` : ``} episode(s) ${(modifiedEpisodes.length > 0) || (removedEpisodes.length > 0) ? `from` : `to`} the Dubbed Episodes Feed.`)
        console.log(`Logged a total of ${newEpisodes.length + existingFeed.length} Dubbed Episodes to date.`)
    } else {
        console.log(`No changes detected for the Dubbed Episodes Feed.`)
    }
}

updateFeeds()

// end update dub schedule feed //
