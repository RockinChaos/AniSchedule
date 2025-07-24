// noinspection JSUnresolvedReference,NpmUsedModulesInstalled

import { calculateWeeksToFetch, dayTimeMatch, isDSTTransitionMonth, getDSTStartEndDates, delay, daysAgo, getCurrentDay, fixTime, getCurrentYearAndWeek, getWeeksInYear, loadJSON, past, saveJSON, weeksDifference, durationMap, mediaTypeMap } from './utils/util.js'
import path from 'path'

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

    let { year, week } = getCurrentYearAndWeek()
    week = week - 1
    if (week === 0) {
        year = year - 1
        week = getWeeksInYear(year)
    }

    console.log(`Fetching dub timetables for the previous week: Year ${year}, Week ${week}...`)
    fetchInProgress = fetchAiringSchedule({ type: 'timetables', year, week, token: BEARER_TOKEN }).then((data) => {
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
    const { matchKeys } = await import('./utils/anime.js')
    const { anilistClient } = await import('./utils/anilist.js')
    const { malDubs } = await import('./utils/animedubs.js')
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
        const fetchedData = await fetchAiringSchedule({type: 'timetables', year, week, token: BEARER_TOKEN})
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

    // Handle custom dubs
    let customDubs = loadJSON(path.join('./custom/custom-dubs.json'))
    const exactCustomDubs = structuredClone(customDubs)
    if (customDubs?.length) {
        console.log(`Detected ${customDubs?.length} custom dubs, handling...`)
        for (const dub of customDubs) {
            if (new Date(dub.episodeDate) < new Date()) {
                console.log(`Custom dub ${dub.route} has passed it episode date ${dub.episodeDate}, updating to reflect the next episodes air date.`)
                dub.episodeDate = past(new Date(dub.episodeDate), dub.episodeNumber, false)
                dub.episodeNumber = dub.episodeNumber + 1
                dub.airingStatus = 'aired'
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
    if (JSON.stringify(customDubs) !== JSON.stringify(exactCustomDubs)) {
        console.log(`Changes detected in the custom dubs lists.... saved!`)
        saveJSON(path.join(`./custom/custom-dubs.json`), customDubs, true)
    }
    airingLists.update((lists) => [...lists, ...customDubs])

    let timetables = await airingLists.value
    if (timetables) {
        timetables = timetables.filter((entry) => {
            const delayedText = entry.delayedText?.toLowerCase()
            const isPartial = delayedText?.includes('no dub') || delayedText?.includes('not dub') || delayedText?.includes('partial')
            if (isPartial && (weeksDifference(entry.delayedFrom, past(new Date(), 0, true)) <= 4) && (new Date(entry.delayedFrom) > new Date(entry.delayedUntil))) {
                const currentAiring = currentSchedule.findIndex((airingItem) => airingItem.route === entry.route)
                if (currentAiring !== -1) {
                    changes.push(`The series ${currentSchedule[currentAiring].media?.media?.title?.userPreferred} is marked as concluded at Episode ${entry.episodeNumber} as the remaining ${(entry.episodes - entry.episodeNumber) + 1} Episode(s) are not planned to be dubbed.`)
                    console.log(`The series ${currentSchedule[currentAiring].media?.media?.title?.userPreferred} is marked as concluded at Episode ${entry.episodeNumber} as the remaining ${(entry.episodes - entry.episodeNumber) + 1} Episode(s) are not planned to be dubbed, this is a partial dub.`)
                    const episodeFeed = loadJSON(path.join('./raw/dub-episode-feed.json'))?.filter(episode => {
                        if (episode.id === currentSchedule[currentAiring].media?.media?.id && episode.episode.aired >= entry.episodeNumber) {
                            changes.push(`(Dub) Removed Episode ${episode.episode.aired} for ${currentSchedule[currentAiring].media?.media?.title?.userPreferred} (Timetables Correction).`)
                            console.log(`Removed Episode ${episode.episode.aired} for ${currentSchedule[currentAiring].media?.media?.title?.userPreferred} as the episode is not planned to be dubbed.`)
                            return false
                        }
                        return true
                    }).sort((a, b) => new Date(b.episode.airedAt).getTime() - new Date(a.episode.airedAt).getTime())
                    saveJSON(path.join('./raw/dub-episode-feed.json'), episodeFeed)
                    saveJSON(path.join('./readable/dub-episode-feed-readable.json'), episodeFeed, true)
                    currentSchedule.splice(currentAiring, 1)
                }
                return false
            }
            return true
        })

        for (const entry of currentSchedule) { // need to re-add indefinitely delayed series to timetables, or correctly remove un-verified episodes.
            const existingInAiring = timetables.findIndex((airingItem) => airingItem.route === entry.route)
            let newEntry = entry
            if ((existingInAiring === -1) && entry.verified && entry.episodeNumber < (entry.episodes || 0)) { // highly likely this is an indefinitely delayed series.
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
            } else if ((existingInAiring === -1) && !entry.verified && !(entry.episodeNumber < 2) && !(daysAgo(new Date(entry.episodeDate)) >= 1 && getCurrentDay() === 1)) { // highly likely someone fucked up and realized their fuck-up, but we should keep any series older than 1 day if the current day is a Monday (roll-over) as they likely are batch drops instead of weekly releases.
                const previousWeek = (await fetchPreviousWeek()).find((airingItem) => airingItem.route === entry.route)
                if (!previousWeek || previousWeek.episodeNumber !== entry.episodes || !(previousWeek.subtractedEpisodeNumber <= 1)) {
                    const title = await fetchAiringSchedule({type: 'anime', route: entry.route, token: BEARER_TOKEN})
                    const oneYearAgo = new Date()
                    oneYearAgo.setFullYear(new Date().getFullYear() - 1)
                    if (title && (new Date(title.dubPremier) < new Date() && new Date(title.dubPremier) >= oneYearAgo)) {
                        const entryCopy = structuredClone(entry)
                        entryCopy.episodeDate = title.dubPremier
                        console.log(`The un-verified series ${entry.media?.media?.title?.userPreferred} was detected as missing from the timetables, a query for the title ${entry.route} states the dub has already aired! ... This was likely a database correction.`)
                        changes.push(...await updateDubFeed([entryCopy]))
                    } else {
                        changes.push(`(Dub) The un-verified series ${entry.media?.media?.title?.userPreferred} was removed from the timetables.`)
                        console.log(`The un-verified series ${entry.media?.media?.title?.userPreferred} is missing from the timetables, this was likely added by mistake...`)
                        const episodeFeed = loadJSON(path.join('./raw/dub-episode-feed.json'))?.filter(episode => {
                            if (episode.id === entry.media?.media?.id) {
                                changes.push(`(Dub) Removed Episode ${episode.episode.aired} for ${entry.media?.media?.title?.userPreferred} (Timetables Correction).`)
                                console.log(`Removed Episode ${episode.episode.aired} for ${entry.media?.media?.title?.userPreferred} as the un-verified series has been removed from the timetables.`)
                                return false
                            }
                            return true
                        }).sort((a, b) => new Date(b.episode.airedAt).getTime() - new Date(a.episode.airedAt).getTime())
                        saveJSON(path.join('./raw/dub-episode-feed.json'), episodeFeed)
                        saveJSON(path.join('./readable/dub-episode-feed-readable.json'), episodeFeed, true)
                    }
                }
            } else if ((existingInAiring === -1) && entry.verified && (new Date(entry.delayedUntil) > new Date(entry.episodeDate))) {
                changes.push(`The verified series ${entry.media?.media?.title?.userPreferred} is missing from the timetables, this is likely a mistake or a bug!`)
                console.log(`The verified series ${entry.media?.media?.title?.userPreferred} is missing from the timetables, this is likely a mistake or a bug, series will be re-added with the assumption the schedule continues as-is.`)
                timetables.push(newEntry)
            } else if ((existingInAiring !== -1) && (weeksDifference(timetables[existingInAiring].delayedFrom, past(new Date(), 0, true)) <= 4) && (new Date(timetables[existingInAiring].delayedFrom) > new Date(timetables[existingInAiring].delayedUntil))) { // highly likely this is an indefinitely delayed series.
                if (!entry.delayedIndefinitely) {
                    changes.push(`(Dub) The series ${entry.media?.media?.title?.userPreferred} Episode ${entry.episodeNumber} has been delayed indefinitely`)
                    console.log(`The series ${entry.media?.media?.title?.userPreferred} is has a delayedFrom date specified but no delayedUntil date, this is likely an indefinite delay!`)
                    timetables[existingInAiring] = {
                        ...timetables[existingInAiring],
                        verified: true,
                        delayedUntil: new Date(new Date().getFullYear() + 6, 0, 1).toISOString(),
                        delayedIndefinitely: true
                    }
                } else {
                    timetables[existingInAiring] = {
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
    const mediaID = /(?:https?:\/\/)?(?:www\.)?(?:myanimelist\.net\/anime\/|anilist\.co\/anime\/)(\d+)/
    const titles = []
    const order = []

    // Resolve routes as titles
    const parseObjs = await AnimeResolver.findAndCacheTitle(airing.map(item => item.romaji || item.route))

    for (const parseObj of parseObjs) {
        const media = AnimeResolver.animeNameCache[AnimeResolver.getCacheKeyForTitle(parseObj)]
        const threshold = parseObj?.anime_title?.length > 15 ? 0.2 : parseObj?.anime_title?.length > 9 ? 0.15 : 0.1 // play nice with small anime titles
        const verification = !matchKeys(media, parseObj.anime_title, ['title.userPreferred', 'title.english', 'title.romaji'], threshold)
        console.log(`Resolving route ${parseObj?.anime_title} as ${media?.title?.userPreferred} which is ${verification ? 'needs verification' : 'verified'}`)
        let item

        if (!media || verification) { // Resolve failed routes
            console.log(`Failed to resolve, trying alternative title(s) for ${parseObj?.anime_title}`)
            item = airing.find(i => matchKeys(i, parseObj?.anime_title, ['route', 'title', 'romaji', 'english', 'native'], threshold))
            const altTitles = [item.romaji, item.english, item.title, item.native].filter(Boolean)
            const fallbackTitles = await AnimeResolver.findAndCacheTitle(altTitles)
            let attempt = 0
            for (const parseObjAlt of fallbackTitles) {
                attempt++
                const mediaAlt = AnimeResolver.animeNameCache[AnimeResolver.getCacheKeyForTitle(parseObjAlt)]
                const altVerification = !matchKeys(mediaAlt, parseObjAlt.anime_title, ['title.userPreferred', 'title.english', 'title.romaji', 'title.native'], threshold)
                console.log(`Resolving ${parseObjAlt?.anime_title} as ${mediaAlt?.title?.userPreferred} which is ${altVerification ? 'needs verification' : 'verified'}`)
                if (mediaAlt && !altVerification) {
                    titles.push(parseObjAlt.anime_title)
                    order.push({route: item.route, title: mediaAlt.title.userPreferred})
                    console.log(`Resolved alternative title ${parseObjAlt?.anime_title} as ${mediaAlt?.title?.userPreferred}`)
                    break
                } else if (attempt === altTitles.length && (!mediaAlt || altVerification)) { // anilist is sometimes just crap at resolving some titles as they use weird uni characters in the name or some titles just have a very similar name and anilist just doesn't check itself...
                    console.log(`Failed to resolve alternatives title(s), trying to fetch database URL's directly for ${parseObj?.anime_title}`)
                    let fallback = false
                    const fallbackRoute = await fetchAiringSchedule({type: 'anime', route: item.route, token: BEARER_TOKEN})
                    for (const url of [fallbackRoute?.websites?.aniList, fallbackRoute?.websites?.mal].filter(Boolean)) {
                        if (!url || fallback) continue
                        const match = url.match(mediaID)
                        if (match) { // thank god there is at least one url...
                            console.log(`Found ID ${match[1]} from URL ${url}, attempting to locate media for ${parseObj?.anime_title}`)
                            const res = await anilistClient.searchIDS({...(url.toLowerCase().includes('anilist') ? { id: match[1] } : { idMal: match[1] })})
                            const media = res?.data?.Page?.media[0]
                            if (media) { // yippie the impossible was made possible.
                                AnimeResolver.cacheAnimeName(media.title.userPreferred, media)
                                titles.push(media.title.userPreferred)
                                order.push({route: item.route, title: media.title.userPreferred})
                                console.log(`Resolved route ${parseObj?.anime_title} from URL ${url} as ${media?.title?.userPreferred}`)
                                fallback = true
                            }
                        }
                    }
                    if (!fallback) { // well sucks to be you I guess...
                        changes.push(`Failed to resolve alternative title(s) ${parseObj?.anime_title}, things will not work as expected, this is a BIG deal!!`)
                        console.log(`Failed to resolve alternative title(s) ${parseObj?.anime_title}`)
                    }
                } else {
                    console.log(`Failed to resolve alternative title ${parseObjAlt?.anime_title} for ${parseObj?.anime_title}`)
                }
            }
        } else {
            item = airing.find(i => matchKeys(i, parseObj?.anime_title, ['route', 'romaji', 'english', 'title', 'native'], threshold))
            if (item) {
                titles.push(parseObj.anime_title)
                order.push({route: item.route, title: media.title.userPreferred})
                console.log(`Resolved route ${parseObj?.anime_title} as ${media?.title?.userPreferred}`)
            } else { // anilist is sometimes just crap at resolving some titles as they use weird uni characters in the name or some titles just have a very similar name and anilist just doesn't check itself...
                console.log(`Failed to resolve route ${parseObj?.anime_title}, trying to fetch database URL's directly`)
                let fallback = false
                const fallbackRoute = await fetchAiringSchedule({type: 'anime', route: item.route, token: BEARER_TOKEN})
                for (const url of [fallbackRoute?.websites?.aniList, fallbackRoute?.websites?.mal].filter(Boolean)) {
                    if (!url || fallback) continue
                    const match = url.match(mediaID)
                    if (match) { // thank god there is at least one url...
                        console.log(`Found ID ${match[1]} from URL ${url}, attempting to locate media for ${parseObj?.anime_title}`)
                        const res = await anilistClient.searchIDS({...(url.toLowerCase().includes('anilist') ? { id: match[1] } : { idMal: match[1] })})
                        const media = res?.data?.Page?.media[0]
                        if (media) { // yippie the impossible was made possible.
                            AnimeResolver.cacheAnimeName(media.title.userPreferred, media)
                            titles.push(media.title.userPreferred)
                            order.push({route: item.route, title: media.title.userPreferred})
                            console.log(`Resolved route ${parseObj?.anime_title} from URL ${url} as ${media?.title?.userPreferred}`)
                            fallback = true
                        }
                    }
                }
                if (!fallback) { // well sucks to be you I guess...
                    changes.push(`Failed to resolve route ${parseObj?.anime_title}, things will not work as expected, this is a BIG deal!!`)
                    console.log(`Failed to resolve route ${parseObj?.anime_title}`)
                }
            }
        }
    }

    // modify timetables entries for better functionality and fix any offset minutes.
    airing.forEach((entry) => {
        const episodeDate = new Date(entry.episodeDate)
        episodeDate.setMinutes(Math.floor((episodeDate.getMinutes() + 1) / 5) * 5, 0)
        entry.episodeDate = past(episodeDate, 0, true)
        entry.delayedFrom = fixTime(entry.delayedFrom, entry.episodeDate)
        entry.delayedUntil = fixTime(entry.delayedUntil, entry.episodeDate)
        entry.unaired = ((entry.episodeNumber <= 1 || (entry.subtractedEpisodeNumber <= 1 && entry.episodeNumber > 1)) && Math.floor(new Date(entry.episodeDate).getTime()) > Math.floor(Date.now()))
    })

    // Resolve found titles
    const results = await AnimeResolver.resolveFileAnime(titles)

    // Create combined results by mapping the resolved data to airingItems
    let combinedResults = airing.map(({ donghua, status, airType, imageVersionRoute, streams, airingStatus, ...airingItem }) => {
        // Find the resolved media match for the current airing item
        const entry = order.find(o => o.route === airingItem.route)
        const mediaMatch = results?.find(result => result.media?.title?.userPreferred === entry?.title)
        const numberOfEpisodes = airingItem.subtractedEpisodeNumber ? (airingItem.episodeNumber - airingItem.subtractedEpisodeNumber) : 1
        const predictedEpisode = airingItem.episodeNumber + ((numberOfEpisodes > 4) && (airingStatus === 'aired') && !airingItem.unaired ? 0 : ((new Date(airingItem.episodeDate) < new Date()) && (new Date(airingItem.delayedUntil) < new Date()) && (!airingItem.episodes || (airingItem.episodeNumber < airingItem.episodes)) ? ((airingItem.subtractedEpisodeNumber >= 1 && (airingItem.episodeNumber - airingItem.subtractedEpisodeNumber) > 1 ? (airingItem.episodeNumber - airingItem.subtractedEpisodeNumber) : 0) + 1) : 0))
        const range = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i)

        return {
            ...airingItem, // Include all original airing list data
            ...(mediaMatch && {
                media: {
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

    // Ensure all media on the schedule HAS a planned dub
    combinedResults = combinedResults.filter(entry => {
        if (malDubs.isDubMedia(entry)) return true
        else console.error(`Found unexpected media ${entry?.media?.media?.title?.userPreferred} on the dub schedule, this does not have a planned dub!`)
        return false
    })

    if (combinedResults) {
        if (combinedResults.length !== airingLists.value.length) {
            changes.push(`Something is wrong! There are ${combinedResults.length} dub titles resolved and there are ${airingLists.value.length} dub titles in the timetables, less than what is expected!`)
            console.error(`Something is wrong! There are ${combinedResults.length} dub titles resolved and there are ${airingLists.value.length} dub titles in the timetables, less than what is expected!`)
        }
        console.log(`Successfully resolved ${combinedResults.length} airing, saving...`)
        await writeFile('./raw/dub-schedule.json', JSON.stringify(combinedResults))
        await writeFile('./readable/dub-schedule-readable.json', JSON.stringify(combinedResults, null, 2))
        const existingDubbedFeed = loadJSON(path.join('./raw/dub-episode-feed.json'))
        let modified = false
        combinedResults.forEach(entry => {
            existingDubbedFeed.filter(media => media.id === entry.media.media.id).forEach(episode => {
                const media = entry.media.media
                if ((media.idMal && (episode.idMal !== media.idMal)) || (episode.format !== (media.format || mediaTypeMap(entry?.mediaTypes?.[0]?.route))) || (episode.duration !== (media.duration ? media.duration : (entry.lengthMin || durationMap[media.format || mediaTypeMap(entry?.mediaTypes?.[0]?.route)])))) {
                    changes.push(`(Dub) Updated Episode ${episode.episode.aired} for ${media.title.userPreferred} to correct its idMal, format, and duration.`)
                    console.log(`(Dub) Updated Episode ${episode.episode.aired} for ${media.title.userPreferred} to correct its idMal, format, and duration as it was found to be different than the current airing schedule.`)
                    if (media.idMal) episode.idMal = media.idMal
                    episode.format = media.format || mediaTypeMap(entry?.mediaTypes?.[0]?.route)
                    episode.duration = media.duration ? media.duration : (entry.lengthMin || durationMap[media.format || mediaTypeMap(entry?.mediaTypes?.[0]?.route)])
                    modified = true
                }
            })
        })
        if (modified) {
            const newFeed = Object.values([...existingDubbedFeed].reduce((acc, item) => { acc[`${item.id}_${item.episode.airedAt}`] = acc[`${item.id}_${item.episode.airedAt}`] || []; acc[`${item.id}_${item.episode.airedAt}`].push(item); return acc }, {})).map(group => group.sort((a, b) => b.episode.aired - a.episode.aired)).flat().sort((a, b) => new Date(b.episode.airedAt) - new Date(a.episode.airedAt))
            saveJSON(path.join(`./raw/dub-episode-feed.json`), newFeed)
            saveJSON(path.join(`./readable/dub-episode-feed-readable.json`), newFeed, true)
            console.log(`(Dub) Episodes have been corrected and saved...`)
        }
    } else {
        console.error('Error: Failed to resolve the dub airing schedule, it cannot be null!')
        process.exit(1)
    }

    // end of resolve airing lists //
    return changes
}

// update dub schedule episode feed //
export async function updateDubFeed(optSchedule) {
    const changes = []
    const schedule = optSchedule || loadJSON(path.join('./raw/dub-schedule.json'))
    const exactFeed = loadJSON(path.join('./raw/dub-episode-feed.json'))
    let existingFeed = structuredClone(exactFeed)
    const removedEpisodes = []
    const modifiedEpisodes = []

    // Filter out any existing episode feed entries that matches any delayed episodes
    schedule.filter(entry => {
        return (new Date(entry.delayedUntil) >= new Date(entry.episodeDate)) && (new Date(entry.delayedFrom) <= new Date(entry.episodeDate)) && (new Date(entry.delayedUntil) > new Date())
    }).forEach(entry => {
        existingFeed = existingFeed.filter(episode => {
            const foundEpisode = (episode.id === entry.media?.media?.id && ((entry.subtractedEpisodeNumber && (episode.episode.aired >= entry.subtractedEpisodeNumber) && episode.episode.aired <= entry.episodeNumber) || (episode.episode.aired === entry.episodeNumber)))
            if (foundEpisode) {
                changes.push(`(Dub) Removed Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} as it has been delayed`)
                console.log(`Removed Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed as it has been delayed!`)
                removedEpisodes.push(entry.media.media)
            }
            return !foundEpisode
        })
    })

    // Filter out any incorrect episodes that were added but haven't actually released.
    schedule.forEach(entry => {
        existingFeed = existingFeed.filter(episode => {
            const foundEpisode = (episode.id === entry.media?.media?.id) && ((episode.episode.aired > entry.episodeNumber) && ((episode.episode.aired > entry.media.media?.airingSchedule?.nodes[entry.media.media?.airingSchedule?.nodes?.length - 1]?.episode) || (new Date(entry.media.media?.airingSchedule?.nodes[entry.media.media?.airingSchedule?.nodes?.length - 1]?.airingAt) > new Date())))
            if (foundEpisode) {
                changes.push(`(Dub) Removed Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} as the air date has changed`)
                console.log(`Removed Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed as the air date has changed!`)
                removedEpisodes.push(episode)
            }
            return !foundEpisode
        })
    })

    // Filter out any incorrect episodes (last released) based on corrected air dates in the schedule and update all related episodes airing date.
    schedule.forEach(entry => {
        existingFeed = existingFeed.filter(episode => {
            const foundEpisode = (episode.id === entry.media?.media?.id) && (((entry.subtractedEpisodeNumber && (episode.episode.aired >= entry.subtractedEpisodeNumber) && episode.episode.aired <= entry.episodeNumber) || (episode.episode.aired === entry.episodeNumber)) && (new Date(episode.episode.airedAt) < new Date(entry.episodeDate)))
            if (foundEpisode) {
                changes.push(`(Dub) Removed Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} due to a correction in the airing date`)
                console.log(`Removed Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed due to a correction in the airing date.`)
                removedEpisodes.push(episode)
            }
            return !foundEpisode
        })
    })

    const { dstStart, dstEnd } = getDSTStartEndDates()
    // Filter out incorrect episodes and correct dates if necessary
    schedule.forEach(entry => {
        const latestEpisodeInFeed = existingFeed.filter(episode => episode.id === entry.media?.media?.id).sort((a, b) => b.episode.aired - a.episode.aired)[0]
        if (latestEpisodeInFeed && !dayTimeMatch(new Date(latestEpisodeInFeed.episode.airedAt), new Date(entry.episodeDate)) && (!entry.subtractedEpisodeNumber || (entry.subtractedEpisodeNumber > 1 && !((entry.episodeNumber - entry.subtractedEpisodeNumber) >= 6)))) {
            let mediaEpisodes = existingFeed.filter(episode => episode.id === entry.media.media.id)
            mediaEpisodes.sort((a, b) => b.episode.aired - a.episode.aired)  // Sort by episode number in descending order
            const isInDSTTransition = isDSTTransitionMonth()
            if (entry.episodeNumber < 4 || (!isInDSTTransition && daysAgo(new Date(latestEpisodeInFeed.episode.airedAt), new Date(entry.episodeDate)) <= 8)) {
                console.log(`Modifying existing episodes of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed due to a correction in the airing date`)
                const originalAiredAt = mediaEpisodes.map(episode => episode.episode.airedAt)
                let correctedDate = -1
                let usePredict = false
                let zeroIndexDate
                mediaEpisodes.forEach((episode, index) => {
                    const prevDate = episode.episode.airedAt
                    const predictDate = new Date(fixTime(new Date(prevDate), new Date(entry.episodeDate), true))
                    if (index !== 0) correctedDate = correctedDate - weeksDifference(prevDate, originalAiredAt[index - 1]) + (usePredict && index === 1 ? 1 : 0)
                    else {
                        zeroIndexDate = episode.episode.aired === entry.episodeNumber || (entry.subtractedEpisodeNumber && (episode.episode.aired >= entry.subtractedEpisodeNumber)) ? new Date(entry.episodeDate) : weeksDifference(entry.delayedFrom, past(new Date(), 0, true)) <= 1 ? new Date(entry.delayedFrom) : predictDate
                        usePredict = past(new Date(predictDate), 0, true) === past(new Date(zeroIndexDate), 0, true)
                    }
                    episode.episode.airedAt = past(new Date(zeroIndexDate), (!usePredict || index !== 0 ? correctedDate : 0), true)
                    changes.push(`(Dub) Modified Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} from ${prevDate} to ${episode.episode.airedAt}`)
                    console.log(`Modified Episode ${episode.episode.aired} of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed with aired date from ${prevDate} to ${episode.episode.airedAt}`)
                    modifiedEpisodes.push(episode)
                })
            } else if (isInDSTTransition) { // dst is active, and likely it was recent... only adjust the latest episode SINCE DST was active.
                const latestEpisode = mediaEpisodes[0]
                if (latestEpisode) {
                    const prevDate = latestEpisode.episode.airedAt
                    if ((dstStart && (new Date(prevDate) >= dstStart)) || (dstEnd && (new Date(prevDate) >= dstEnd))) {
                        latestEpisode.episode.airedAt = fixTime(new Date(prevDate), new Date(entry.episodeDate), true)
                        changes.push(`(Dub) Modified Episode ${latestEpisode.episode.aired} of ${entry.media.media.title.userPreferred} from ${prevDate} to ${latestEpisode.episode.airedAt}`)
                        console.log(`Modified Episode ${latestEpisode.episode.aired} of ${entry.media.media.title.userPreferred} from the Dubbed Episode Feed with aired date from ${prevDate} to ${latestEpisode.episode.airedAt} due to a correction in the airing date (Daylight Savings)`)
                        modifiedEpisodes.push(latestEpisode)
                    }
                }
            }
        }
    })

    const newEpisodes = (await Promise.all(schedule.map(async (entry) => {
        let newEpisodes = []

        // handle double-header (multi-header) releases
        const latestEpisode = entry.episodeNumber
        const existingEpisodes = existingFeed.filter(media => media.id === entry.media?.media?.id)
        const lastFeedEpisode = existingEpisodes.reduce((max, ep) => Math.max(max, ep.episode.aired), 0)
        let episodeType = 0
        if ((entry.unaired && new Date(entry.episodeDate) > new Date()) || (((new Date(entry.delayedUntil) > new Date()) || (new Date(entry.episodeDate) > new Date())) && entry.subtractedEpisodeNumber && (lastFeedEpisode === (entry.subtractedEpisodeNumber - 1)))) return newEpisodes
        for (let episodeNum = lastFeedEpisode + 1; episodeNum < latestEpisode; episodeNum++) {
            let baseEpisode = existingEpisodes.find(ep => ep.episode.aired <= episodeNum) || existingEpisodes.find(ep => ep.episode.aired === lastFeedEpisode)
            const previousWeek = (await fetchPreviousWeek()).find((airingItem) => airingItem.route === entry.route)
            const multiHeader =  entry.subtractedEpisodeNumber || (previousWeek && previousWeek.subtractedEpisodeNumber)  //|| (previousWeek && ((previousWeek.episodeNumber !== lastFeedEpisode) || (previousWeek.episodeNumber !== (entry.episodeNumber - 2)))) -- probably don't need this since these cases should never happen.
            episodeType = multiHeader && baseEpisode && (lastFeedEpisode + 1 !== entry.subtractedEpisodeNumber) ? 2 : multiHeader ? 1 : 0
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
                format: entry.media.media.format || mediaTypeMap(entry?.mediaTypes?.[0]?.route),
                duration: entry.media.media.duration ? entry.media.media.duration : (entry.media.media.format || !entry.lengthMin ? durationMap[entry.media.media.format] : entry.lengthMin),
                episode: {
                    aired: episodeNum,
                    airedAt: (multiHeader && (episodeNum === entry.episodeNumber || (entry.subtractedEpisodeNumber && (episodeNum >= entry.subtractedEpisodeNumber))) ? entry.episodeDate : (multiHeader && baseEpisode) ? baseEpisode.episode.airedAt : multiHeader ? entry.episodeDate : past(new Date(entry.episodeDate), -(latestEpisode - episodeNum), true)),
                    addedAt: past(new Date(), 0, true)
                }
            }

            if (entry.episodeNumber !== lastFeedEpisode && new Date(batchEpisode.episode.airedAt) <= new Date() && (new Date(entry.delayedUntil) <= new Date(batchEpisode.episode.airedAt) || new Date(entry.delayedFrom) > new Date(batchEpisode.episode.airedAt))) {
                newEpisodes.push(batchEpisode)
                changes.push(`(Dub) Added${episodeType === 2 ? ' Missing' : ''}${episodeType === 2 || episodeType === 1 ? ' (multi-header) release' : ''} Episode ${batchEpisode.episode.aired} for ${entry.media.media.title.userPreferred}`)
                console.log(`Adding${episodeType === 2 ? ' Missing' : ''}${episodeType === 2 || episodeType === 1 ? ' (multi-header) release' : ''} Episode ${batchEpisode.episode.aired} for ${entry.media.media.title.userPreferred} to the Dubbed Episode Feed.`)
            }
        }

        // handle single new episodes
        const newEpisode = {
            id: entry.media.media.id,
            ...(entry.media.media.idMal ? { idMal: entry.media.media.idMal } : {}),
            format: entry.media.media.format || mediaTypeMap(entry?.mediaTypes?.[0]?.route),
            duration: entry.media.media.duration ? entry.media.media.duration : (entry.media.media.format || !entry.lengthMin ? durationMap[entry.media.media.format] : entry.lengthMin),
            episode: {
                aired: latestEpisode,
                airedAt: entry.episodeDate,
                addedAt: past(new Date(), 0, true)
            }
        }

        if (entry.episodeNumber !== lastFeedEpisode && new Date(newEpisode.episode.airedAt) <= new Date() && (new Date(entry.delayedUntil) <= new Date(newEpisode.episode.airedAt) || new Date(entry.delayedFrom) > new Date(newEpisode.episode.airedAt))) {
            newEpisodes.push(newEpisode)
            changes.push(`(Dub) Added${episodeType === 2 ? ' Missing' : ''}${episodeType === 2 || episodeType === 1 ? ' (multi-header) release' : ''} Episode ${newEpisode.episode.aired} for ${entry.media.media.title.userPreferred}`)
            console.log(`Adding${episodeType === 2 ? ' Missing' : ''}${episodeType === 2 || episodeType === 1 ? ' (multi-header) release' : ''} Episode ${newEpisode.episode.aired} for ${entry.media.media.title.userPreferred} to the Dubbed Episode Feed.`)
        }

        return newEpisodes
    }))).flat().filter(({ id, episode }) => {
        return !existingFeed.some(media => media.id === id && media.episode.aired === episode.aired)
    }).sort((a, b) => b.episode.aired - a.episode.aired)

    const newFeed = Object.values([...newEpisodes.filter(({ id, episode }) => !existingFeed.some(media => media.id === id && media.episode.aired === episode.aired)), ...existingFeed].reduce((acc, item) => { acc[`${item.id}_${item.episode.airedAt}`] = acc[`${item.id}_${item.episode.airedAt}`] || []; acc[`${item.id}_${item.episode.airedAt}`].push(item); return acc }, {})).map(group => group.sort((a, b) => b.episode.aired - a.episode.aired)).flat().sort((a, b) => new Date(b.episode.airedAt) - new Date(a.episode.airedAt))
    if (JSON.stringify(newFeed) !== JSON.stringify(exactFeed || {})) { // helps prevent rebase conflicts
        saveJSON(path.join('./raw/dub-episode-feed.json'), newFeed)
        saveJSON(path.join('./readable/dub-episode-feed-readable.json'), newFeed, true)
    }

    if (newEpisodes.length > 0 || modifiedEpisodes.length > 0 || removedEpisodes.length > 0) {
        console.log(`${newEpisodes.length > 0 ? `Added ${newEpisodes.length}` : ``}${modifiedEpisodes.length > 0 ? `${newEpisodes.length > 0 ? ` and ` : ``}Modified ${modifiedEpisodes.length}` : ``}${removedEpisodes.length > 0 ? `${(newEpisodes.length > 0) || (modifiedEpisodes.length > 0) ? ` and ` : ``}Removed ${removedEpisodes.length}` : ``} episode(s) ${(modifiedEpisodes.length > 0) || (removedEpisodes.length > 0) ? `from` : `to`} the Dubbed Episodes Feed.`)
        console.log(`Logged a total of ${newEpisodes.length + existingFeed.length} Dubbed Episodes to date.`)
    } else {
        console.log(`No changes detected for the Dubbed Episodes Feed.`)
    }
    return changes
}
