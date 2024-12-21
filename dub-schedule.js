// noinspection JSUnresolvedReference,NpmUsedModulesInstalled

import { calculateWeeksToFetch, dayTimeMatch, delay, fixTime, getCurrentYearAndWeek, getWeeksInYear, loadJSON, past, saveJSON, weeksDifference } from './utils/util.js'
import path from 'path'

// query animeschedule for the proper timetables //
async function fetchAiringSchedule(year, week, token) {
    try {
        const res = await fetch(`https://animeschedule.net/api/v3/timetables/dub?year=${year}&week=${week}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        })
        if (!res.ok) {
            if (res.status === 404) return null // No data for this week
            console.error(`Fetch error for dub schedule: ${res.status}`)
            process.exit(1)
        }
        return await res.json()
    } catch (error) {
        console.error(`Error fetching dub timetables for Week ${week}:`, error)
        process.exit(1)
    }
}

let previousWeekTimetables = null
let fetchInProgress = null
async function fetchPreviousWeek() {
    if (fetchInProgress) return await fetchInProgress
    if (previousWeekTimetables) return previousWeekTimetables

    const BEARER_TOKEN = process.env.ANIMESCHEDULE_TOKEN
    if (!BEARER_TOKEN) {
        console.error('Error: ANIMESCHEDULE_TOKEN environment variable is not defined.')
        process.exit(1)
    }

    const { year, week } = getCurrentYearAndWeek()
    console.log(`Fetching dub timetables for the previous week: Year ${year}, Week ${week - 1}...`)
    fetchInProgress = fetchAiringSchedule(year, week - 1, BEARER_TOKEN).then((data) => {
        previousWeekTimetables = data
        fetchInProgress = null
        return data
    }).catch(() => process.exit(1))

    return await fetchInProgress
}

// update dub schedule //
export async function fetchDubSchedule() {
    const changes = []

    const { writeFile } = await import('node:fs/promises')
    const { writable } =  await import('simple-store-svelte')
    const { default: AnimeResolver } = await import('./utils/animeresolver.js')

    const BEARER_TOKEN = process.env.ANIMESCHEDULE_TOKEN
    if (!BEARER_TOKEN) {
        console.error('Error: ANIMESCHEDULE_TOKEN environment variable is not defined.')
        process.exit(1)
    }

    // Fetch airing lists //

    let airingLists = writable([])
    const currentSchedule = loadJSON(path.join('./raw/dub-schedule.json'))

    console.log(`Getting dub airing schedule`)

    const { startYear, startWeek, endYear, endWeek } = calculateWeeksToFetch()
    let year = startYear
    let week = startWeek

    while (year < endYear || (year === endYear && week <= endWeek)) {
        console.log(`Fetching dub timetables for Year ${year}, Week ${week}...`)
        const fetchedData = await fetchAiringSchedule(year, week, BEARER_TOKEN)
        if (fetchedData) {
            const newEntries = fetchedData.filter((item) => !airingLists.value.some((existing) => existing.route === item.route))
            airingLists.update((lists) => [...lists, ...newEntries])
        }
        await delay(500)

        week++
        if (week > getWeeksInYear(year)) {
            week = 1
            year++
        }
    }

    const timetables = await airingLists.value
    if (timetables) {
        for (const entry of currentSchedule) { // need to re-add indefinitely delayed series to timetables, or correctly remove unverified episodes.
            const existingInAiring = timetables.find((airingItem) => airingItem.route === entry.route)
            let newEntry = entry
            if (!existingInAiring && entry.verified && entry.episodeNumber < (entry.episodes || 0)) { // highly likely this is an indefinitely delayed series.
                if (!entry.delayedIndefinitely) {
                    changes.push(`The verified series ${entry.media?.media?.title?.userPreferred} Episode ${entry.episodeNumber + 1} has been delayed indefinitely`)
                    console.log(`The verified series ${entry.media?.media?.title?.userPreferred} is missing from the timetables, assuming this is an indefinite delay!`)
                    newEntry = {
                        ...entry,
                        delayedUntil: new Date(new Date().getFullYear() + 6, 0, 1).toISOString(),
                        delayedIndefinitely: true
                    }
                }
                timetables.push(newEntry)
            } else if (!existingInAiring && !entry.verified && !(entry.episodeNumber < 2)) { // highly likely someone fucked up and realized their fuck-up.
                const previousWeek = (await fetchPreviousWeek()).find((airingItem) => airingItem.route === entry.route)
                if (!previousWeek || previousWeek.episodeNumber !== entry.episodes || !(previousWeek.subtractedEpisodeNumber <= 1)) {
                    changes.push(`(Dub) The un-verified series ${entry.media?.media?.title?.userPreferred} was removed from the timetables.`)
                    console.log(`The un-verified series ${entry.media?.media?.title?.userPreferred} is missing from the timetables, this was likely added by mistake...`)
                    const episodeFeed = loadJSON(path.join('./raw/dub-episode-feed.json'))?.filter(episode => {
                        if (episode.id === entry.media?.media?.id) {
                            changes.push(`(Dub) Removed Episode ${episode.episode.aired} for ${entry.media?.media?.title?.userPreferred} (Timetables Correction).`)
                            console.log(`Removed Episode ${episode.episode.aired} for ${entry.media?.media?.title?.userPreferred} as the unverified series has been removed from the timetables.`)
                            return false
                        }
                        return true
                    }).sort((a, b) => new Date(b.episode.airedAt).getTime() - new Date(a.episode.airedAt).getTime())
                    saveJSON(path.join('./raw/dub-episode-feed.json'), episodeFeed)
                    saveJSON(path.join('./readable/dub-episode-feed-readable.json'), episodeFeed, true)
                }
            } else if (existingInAiring && (!existingInAiring.delayedIndefinitely) && (weeksDifference(existingInAiring.delayedFrom, past(new Date(), 0, true)) <= 4) && (new Date(existingInAiring.delayedFrom) > new Date(existingInAiring.delayedUntil))) { // highly likely this is an indefinitely delayed series.
                const index = timetables.findIndex((airingItem) => airingItem.route === entry.route)
                if (!entry.delayedIndefinitely) {
                    changes.push(`(Dub) The series ${entry.media?.media?.title?.userPreferred} Episode ${entry.episodeNumber} has been delayed indefinitely`)
                    console.log(`The series ${entry.media?.media?.title?.userPreferred} is has a delayedFrom date specified but no delayedUntil date, this is likely an indefinite delay!`)
                    timetables[index] = {
                        ...existingInAiring,
                        verified: true,
                        delayedUntil: new Date(new Date().getFullYear() + 6, 0, 1).toISOString(),
                        delayedIndefinitely: true
                    }
                } else {
                    timetables[index] = {
                        ...entry
                    }
                }
            }
        }
        airingLists.value = timetables.filter(item => item.airType === 'dub').sort((a, b) => a.title.localeCompare(b.title)) // Need to filter to ensure only dubs are fetched, the api sometimes includes raw airType...
        console.log(`Successfully retrieved ${airingLists.value.length} airing series...`)
    } else {
        console.error('Error: Failed to fetch the dub airing schedule, it cannot be null!')
        process.exit(1)
    }

    // end of fetch airing lists //


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
            console.log(`Failed to resolve, trying alternative title(s) for ${parseObj?.anime_title}`)
            item = airing.find(i => i.route === parseObj.anime_title)
            const fallbackTitles = await AnimeResolver.findAndCacheTitle([item.romaji, item.english, item.title, item.native].filter(Boolean))
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

    // modify timetables entries for better functionality.
    airing.forEach((entry) => {
        entry.delayedFrom = fixTime(entry.delayedFrom, entry.episodeDate)
        entry.delayedUntil = fixTime(entry.delayedUntil, entry.episodeDate)
        entry.unaired = ((entry.episodeNumber <= 1 || (entry.subtractedEpisodeNumber <= 1 && entry.episodeNumber > 1)) && Math.floor(new Date(entry.episodeDate).getTime()) > Math.floor(Date.now()))
    })

    // Resolve found titles
    const results = await AnimeResolver.resolveFileAnime(titles)

    // Create combined results by mapping the resolved data to airingItems
    const combinedResults = airing.map((airingItem) => {
        // Find the resolved media match for the current airing item
        const entry = order.find(o => o.route === airingItem.route)
        const mediaMatch = results?.find(result => result.media?.title?.userPreferred === entry?.title)
        const predictedEpisode = airingItem.episodeNumber + ((new Date(airingItem.episodeDate) < new Date()) && (new Date(airingItem.delayedUntil) < new Date()) && (!airingItem.episodes || (airingItem.episodeNumber < airingItem.episodes)) ? 1 : 0)
        const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i)

        return {
            ...airingItem, // Include all original airing list data
            ...(mediaMatch && {
                media: {
                    ...mediaMatch,
                    media: {
                        ...mediaMatch.media,
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

    // Iterate over combinedResults to verify against the schedule
    combinedResults.forEach((entry, index) => {
        const scheduleMatch = currentSchedule?.find(scheduledItem => scheduledItem.route === combinedResults[index].route)
        const { verified, addedAt, ...details } = combinedResults[index]
        if (scheduleMatch) {
            combinedResults[index] = {
                ...details,
                verified: combinedResults[index].verified || scheduleMatch.verified || false,
                addedAt: scheduleMatch.addedAt || (combinedResults[index].unaired ? past(new Date(combinedResults[index].episodeDate), 0, false) : past(new Date(), 0, false))
            }
            if (!combinedResults[index].verified && (new Date(new Date(combinedResults[index].addedAt).getTime() + 14 * 24 * 60 * 60 * 1000) <= new Date())) {
                combinedResults[index] = {
                    ...details,
                    verified: true,
                    addedAt: scheduleMatch.addedAt
                }
                console.log(`Verified ${combinedResults[index].media.media.title.userPreferred} as it has been on the timetables for a full two weeks, if it is removed before the final episode then its a bug or an indefinite delay.`)
            }
        } else {
            combinedResults[index] = {
                ...details,
                verified: !!verified,
                addedAt: combinedResults[index].unaired ? past(new Date(combinedResults[index].episodeDate), 0, false) : past(new Date(), 0, false)
            }
        }
    })


    if (combinedResults) {
        if (combinedResults.length !== airingLists.value.length) console.error(`Something is wrong! There are ${combinedResults.length} dub titles resolved and there are ${airingLists.value.length} dub titles in the timetables, less than what is expected!`)
        console.log(`Successfully resolved ${combinedResults.length} airing, saving...`)
        await writeFile('./raw/dub-schedule.json', JSON.stringify(combinedResults))
        await writeFile('./readable/dub-schedule-readable.json', JSON.stringify(combinedResults, null, 2))
    } else {
        console.error('Error: Failed to resolve the dub airing schedule, it cannot be null!')
        process.exit(1)
    }

    // end of resolve airing lists //
    return changes
}

// update dub schedule episode feed //
export async function updateDubFeed() {
    const changes = []
    const schedule = loadJSON(path.join('./raw/dub-schedule.json'))
    let existingFeed = loadJSON(path.join('./raw/dub-episode-feed.json'))
    const removedEpisodes = []
    const modifiedEpisodes = []

    // Filter out any existing episode feed entries that matches any delayed episodes
    schedule.filter(entry => {
        return (new Date(entry.delayedUntil) >= new Date(entry.episodeDate)) && (new Date(entry.delayedUntil) > new Date())
    }).forEach(entry => {
        existingFeed = existingFeed.filter(episode => {
            const foundEpisode = (episode.id === entry.media.media.id && episode.episode.aired === entry.episodeNumber)
            if (foundEpisode) {
                changes.push(`(Dub) Removed Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} as it has been delayed`)
                console.log(`Removed Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed as it has been delayed!`)
                removedEpisodes.push(entry.media.media)
            }
            return !foundEpisode
        })
    })

    // Filter out any incorrect episodes (last released) based on corrected air dates in the schedule and update all related episodes airing date.
    schedule.forEach(entry => {
        existingFeed = existingFeed.filter(episode => {
            const foundEpisode = (episode.id === entry.media.media.id) && (episode.episode.aired === entry.episodeNumber) && (new Date(episode.episode.airedAt) < new Date(entry.episodeDate))
            if (foundEpisode) {
                changes.push(`(Dub) Removed Episode ${entry.episodeNumber} of ${entry.media.media.title.userPreferred} due to a correction in the airing date`)
                console.log(`Removed Episode ${entry.episodeNumber} of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed due to a correction in the airing date.`)
                removedEpisodes.push(episode)
            }
            return !foundEpisode
        })
    })

    // Filter out incorrect episodes and correct dates if necessary
    schedule.forEach(entry => {
        const latestEpisodeInFeed = existingFeed.filter(episode => episode.id === entry.media.media.id).sort((a, b) => b.episode.aired - a.episode.aired)[0]
        if (latestEpisodeInFeed && !dayTimeMatch(new Date(latestEpisodeInFeed.episode.airedAt), new Date(entry.episodeDate))) {
            let mediaEpisodes = existingFeed.filter(episode => episode.id === entry.media.media.id)
            mediaEpisodes.sort((a, b) => b.episode.aired - a.episode.aired)  // Sort by episode number in descending order
            console.log(`Modifying existing episodes of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed due to a correction in the airing date`)
            const originalAiredAt = mediaEpisodes.map(episode => episode.episode.airedAt)
            let correctedDate = -1
            let usePredict = false
            let zeroIndexDate
            mediaEpisodes.forEach((episode, index) => {
                const prevDate = episode.episode.airedAt
                const predictDate = new Date(prevDate).setHours(new Date(entry.episodeDate).getHours())
                if (index !== 0) correctedDate = correctedDate - weeksDifference(prevDate, originalAiredAt[index - 1]) + (usePredict && index === 1 ? 1 : 0)
                else {
                    zeroIndexDate = episode.episode.aired === entry.episodeNumber || (entry.subtractedEpisodeNumber && (episode.episode.aired >= entry.subtractedEpisodeNumber))  ? new Date(entry.episodeDate) : weeksDifference(entry.delayedFrom, past(new Date(), 0, true)) <= 1 ? new Date(entry.delayedFrom) : predictDate
                    usePredict = past(new Date(predictDate), 0, true) === past(new Date(zeroIndexDate), 0, true)
                }
                episode.episode.airedAt = past(new Date(zeroIndexDate), (!usePredict || index !== 0 ? correctedDate : 0), true)
                changes.push(`(Dub) Modified Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} from ${prevDate} to ${episode.episode.airedAt}`)
                console.log(`Modified Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed with aired date from ${prevDate} to ${episode.episode.airedAt}`)
                modifiedEpisodes.push(episode)
            })
        }
    })

    const newEpisodes = (await Promise.all(schedule.map(async (entry) => {
        let newEpisodes = []

        // handle double-header (multi-header) releases
        const latestEpisode = entry.episodeNumber
        const existingEpisodes = existingFeed.filter(media => media.id === entry.media.media.id)
        const lastFeedEpisode = existingEpisodes.reduce((max, ep) => Math.max(max, ep.episode.aired), 0)
        let episodeType = 0
        if (entry.unaired && new Date(entry.episodeDate) > new Date()) return newEpisodes
        for (let episodeNum = lastFeedEpisode + 1; episodeNum < latestEpisode; episodeNum++) {
            let baseEpisode = existingEpisodes.find(ep => ep.episode.aired <= episodeNum) || existingEpisodes.find(ep => ep.episode.aired === lastFeedEpisode)
            const previousWeek = (await fetchPreviousWeek()).find((airingItem) => airingItem.route === entry.route)
            const multiHeader =  !previousWeek && entry.subtractedEpisodeNumber || (previousWeek && ((previousWeek.episodeNumber !== lastFeedEpisode) || (previousWeek.episodeNumber !== (entry.episodeNumber - 2))))
            episodeType = multiHeader && baseEpisode ? 2 : multiHeader ? 1 : 0
            if (!baseEpisode && latestEpisode > episodeNum) { // fix for when no episodes in the feed but episode(s) have already aired
                let weeksAgo = -1
                let pastDate = past(new Date(entry.episodeDate), weeksAgo, true)
                while (new Date(pastDate) >= new Date()) {
                    weeksAgo--
                    pastDate = past(new Date(entry.episodeDate), weeksAgo, true)
                }
                baseEpisode = {
                    episode: {
                        aired: episodeNum,
                        airedAt: pastDate,
                        addedAt: past(new Date(), 0, true)
                    }
                }
            }

            // fix missing episodes (multi-header) releases
            const batchEpisode = {
                id: entry.media.media.id,
                ...(entry.media.media.idMal ? { idMal: entry.media.media.idMal } : {}),
                format: entry.media.media.format,
                episode: {
                    aired: episodeNum,
                    airedAt: (multiHeader && (episodeNum === entry.episodeNumber || (entry.subtractedEpisodeNumber && (episodeNum >= entry.subtractedEpisodeNumber))) ? entry.episodeDate : (multiHeader && baseEpisode) ? baseEpisode.episode.airedAt : multiHeader ? entry.episodeDate : past(new Date(entry.episodeDate), -(latestEpisode - episodeNum), true)),
                    addedAt: past(new Date(), 0, true)
                }
            }

            newEpisodes.push(batchEpisode)
            changes.push(`(Dub) Added${multiHeader && baseEpisode ? ' Missing' : ''}${multiHeader ? ' (multi-header) release' : ''} Episode ${batchEpisode.episode.aired} for ${entry.media.media.title.userPreferred}`)
            console.log(`Adding${multiHeader && baseEpisode ? ' Missing' : ''}${multiHeader ? ' (multi-header) release' : ''} Episode ${batchEpisode.episode.aired} for ${entry.media.media.title.userPreferred} to the Dubbed Episode Feed.`)
        }

        // handle single new episodes
        const newEpisode = {
            id: entry.media.media.id,
            ...(entry.media.media.idMal ? { idMal: entry.media.media.idMal } : {}),
            format: entry.media.media.format,
            episode: {
                aired: latestEpisode,
                airedAt: entry.episodeDate,
                addedAt: past(new Date(), 0, true)
            }
        }

        if (entry.episodeNumber !== lastFeedEpisode && new Date(newEpisode.episode.airedAt) <= new Date() && new Date(entry.delayedUntil) <= new Date(newEpisode.episode.airedAt)) {
            newEpisodes.push(newEpisode)
            changes.push(`(Dub) Added${episodeType === 2 ? ' Missing' : ''}${episodeType === 2 || episodeType === 1 ? ' (multi-header) release' : ''} Episode ${newEpisode.episode.aired} for ${entry.media.media.title.userPreferred}`)
            console.log(`Adding${episodeType === 2 ? ' Missing' : ''}${episodeType === 2 || episodeType === 1 ? ' (multi-header) release' : ''} Episode ${newEpisode.episode.aired} for ${entry.media.media.title.userPreferred} to the Dubbed Episode Feed.`)
        }

        return newEpisodes
    }))).flat().filter(({ id, episode }) => {
        return !existingFeed.some(media => media.id === id && media.episode.aired === episode.aired)
    }).sort((a, b) => b.episode.aired - a.episode.aired)

    const newFeed = [...newEpisodes, ...existingFeed].sort((a, b) => new Date(b.episode.airedAt).getTime() - new Date(a.episode.airedAt).getTime())
    saveJSON(path.join('./raw/dub-episode-feed.json'), newFeed)
    saveJSON(path.join('./readable/dub-episode-feed-readable.json'), newFeed, true)

    if (newEpisodes.length > 0 || modifiedEpisodes.length > 0 || removedEpisodes.length > 0) {
        console.log(`${newEpisodes.length > 0 ? `Added ${newEpisodes.length}` : ``}${modifiedEpisodes.length > 0 ? `${newEpisodes.length > 0 ? ` and ` : ``}Modified ${modifiedEpisodes.length}` : ``}${removedEpisodes.length > 0 ? `${(newEpisodes.length > 0) || (modifiedEpisodes.length > 0) ? ` and ` : ``}Removed ${removedEpisodes.length}` : ``} episode(s) ${(modifiedEpisodes.length > 0) || (removedEpisodes.length > 0) ? `from` : `to`} the Dubbed Episodes Feed.`)
        console.log(`Logged a total of ${newEpisodes.length + existingFeed.length} Dubbed Episodes to date.`)
    } else {
        console.log(`No changes detected for the Dubbed Episodes Feed.`)
    }
    return changes
}
