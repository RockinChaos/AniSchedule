// noinspection JSUnresolvedReference,NpmUsedModulesInstalled

import { past, loadJSON, saveJSON, durationMap } from './utils/util.js'
import path from 'path'

// update sub schedule //
export async function fetchSubSchedule() {
    const { anilistClient } = await import('./utils/anilist.js')
    const { writeFile } = await import('node:fs/promises')
    const changes = []

    const date = new Date()
    const seasons = ['WINTER', 'SPRING', 'SUMMER', 'FALL']
    const years = [date.getFullYear(), date.getFullYear() - 1, date.getFullYear() - 2, date.getFullYear() - 3, date.getFullYear() - 4, date.getFullYear() - 5]
    const currentSeason = seasons[Math.floor((date.getMonth() / 12) * 4) % 4]
    const results = { data: { Page: { media: [], pageInfo: { hasNextPage: false } } } }

    // fetch series that are not currently releasing for the current season (typically not yet released).
    for (let page = 1, hasNextPage = true; hasNextPage; ++page) {
        const res = await anilistClient.search({ season: currentSeason, year: years[0], status_not: 'RELEASING', page, perPage: 50 })
        if (!res?.data && res?.errors) throw res.errors[0]
        hasNextPage = res.data.Page.pageInfo.hasNextPage
        res.data.Page.media.forEach(media => media?.airingSchedule?.nodes?.sort((a, b) => a.airingAt - b.airingAt || a.episode - b.episode))
        results.data.Page.media = results.data.Page.media.concat(res.data.Page.media)
    }

    // search each season for any currently releasing series, the duration is the current and past 5 years.
    for (let season of seasons) {
        for (let year of years) {
            for (let page = 1, hasNextPage = true; hasNextPage; ++page) {
                const res = await anilistClient.search({ season, year, status: 'RELEASING', page, perPage: 50 })
                if (!res?.data && res?.errors) throw res.errors[0]
                hasNextPage = res.data.Page.pageInfo.hasNextPage
                results.data.Page.media = results.data.Page.media.concat(res.data.Page.media)
            }
        }
   }

    // get the next years winter series if we have reached the end of the current year.
    if (currentSeason === 'FALL') {
        for (let page = 1, hasNextPage = true; hasNextPage; ++page) {
            const res = await anilistClient.search({ season: 'WINTER', year: years[0] + 1, page, perPage: 50 })
            if (!res?.data && res?.errors) throw res.errors[0]
            hasNextPage = res.data.Page.pageInfo.hasNextPage
            results.data.Page.media = results.data.Page.media.concat(res.data.Page.media)
        }
    }

    // fetch missing episodes not yet fetched airing in the next two weeks.
    const currentTime = Math.floor(date.getTime() / 1000)
    const airingSchedule = await anilistClient.fetchAiringSchedule({ from: currentTime, to: (currentTime + 14 * 24 * 60 * 60) })
    airingSchedule.data.Page.airingSchedules.forEach(schedule => {
        if (!results.data.Page.media.some(media => media.id === schedule.media.id)) {
            results.data.Page.media.push(schedule.media)
        }
    })

    results.data.Page.media.forEach(media => media?.airingSchedule?.nodes?.sort((a, b) => a.airingAt - b.airingAt || a.episode - b.episode))
    results.data.Page.media = results.data.Page.media.filter((media, index, self) => media.airingSchedule?.nodes?.[0]?.airingAt && self.findIndex(m => m.id === media.id) === index).sort((a, b) => a.airingSchedule.nodes[0].episode - b.airingSchedule.nodes[0].episode).sort((a, b) => a.airingSchedule.nodes[0].airingAt - b.airingSchedule.nodes[0].airingAt)

    const media = results?.data?.Page?.media
    media.forEach((a) => { if (new Date(a.airingSchedule.nodes[0].airingAt).getTime() > (new Date().getTime() / 1000) && !(a.airingSchedule.nodes[0].episode > 1)) a.unaired = true })
    if (media?.length > 0) {
        console.log(`Successfully resolved ${media.length} airing, saving...`)
        await writeFile('./raw/sub-schedule.json', JSON.stringify(media))
        await writeFile('./readable/sub-schedule-readable.json', JSON.stringify(media, null, 2))
        changes.push(...await updateSubFeed(false, (await anilistClient.searchAllIDS({ id: media.map((entry) => entry.id), aired: true }))?.data?.Page?.media)) // find any missing for the currently scheduled media.
        changes.push(...await findMissingEpisodes())
        const existingSubbedFeed = loadJSON(path.join('./raw/sub-episode-feed.json'))
        const existingHentaiFeed = loadJSON(path.join('./raw/hentai-episode-feed.json'))
        for (const type of ['Sub', 'Hentai']) {
            let modified = false
            media.forEach(entry => {
                (type !== 'Hentai' ? existingSubbedFeed : existingHentaiFeed).filter(media => media.id === entry.id).forEach(episode => {
                    if ((entry.idMal && (episode.idMal !== entry.idMal)) || episode.format !== entry.format || episode.duration !== (entry.duration ? entry.duration : durationMap[entry.format])) {
                        changes.push(`(${type}) Episode ${episode.episode.aired} for ${entry.title.userPreferred} has been updated to correct its idMal, format, and duration.`)
                        console.log(`(${type}) Episode ${episode.episode.aired} for ${entry.title.userPreferred} has been updated to correct its idMal, format, and duration as it was found to be different than the current airing schedule.`)
                        if (entry.idMal) episode.idMal = entry.idMal
                        episode.format = entry.format
                        episode.duration = entry.duration ? entry.duration : durationMap[entry.format]
                        modified = true
                    }
                })
            })
            if (modified) {
                const newFeed = Object.values([...(type !== 'Hentai' ? existingSubbedFeed : existingHentaiFeed)].reduce((acc, item) => { acc[`${item.id}_${item.episode.airedAt}`] = acc[`${item.id}_${item.episode.airedAt}`] || []; acc[`${item.id}_${item.episode.airedAt}`].push(item); return acc }, {})).map(group => group.sort((a, b) => b.episode.aired - a.episode.aired)).flat().sort((a, b) => new Date(b.episode.airedAt) - new Date(a.episode.airedAt))
                saveJSON(path.join(`./raw/${type !== 'Hentai' ? 'sub' : 'hentai'}-episode-feed.json`), newFeed)
                saveJSON(path.join(`./readable/${type !== 'Hentai' ? 'sub' : 'hentai'}-episode-feed-readable.json`), newFeed, true)
                console.log(`(${type}) Episodes have been corrected and saved...`)
            }
        }
        console.log(`${media.length} airing series have been saved to the schedule.`)
    } else {
        console.error('Error: Failed to resolve the sub airing schedule, it cannot be null!')
        process.exit(1)
    }
    return changes
}

// find and add any releases not found in the fetched airingSchedule, this should rarely ever be needed... //
async function findMissingEpisodes() {
    const { anilistClient } = await import('./utils/anilist.js')
    const changes = []
    const currentTime = Math.floor(new Date().getTime() / 1000)

    const airingSchedule = await anilistClient.fetchAiringSchedule({ from: (currentTime - 4 * 24 * 60 * 60), to: currentTime })
    const existingSubbedFeed = loadJSON(path.join('./raw/sub-episode-feed.json'))
    const existingHentaiFeed = loadJSON(path.join('./raw/hentai-episode-feed.json'))

    for (const type of ['Sub', 'Hentai']) {
        let missingEpisodes = []
        airingSchedule.data.Page.airingSchedules.filter((entry) => entry.media.seasonYear >= (new Date().getFullYear() - 1)).forEach((entry) => {
            if (((type !== 'Hentai' && !entry.media.genres?.includes('Hentai')) || (type === 'Hentai' && entry.media.genres?.includes('Hentai')))) {
                if ((entry.airingAt <= currentTime) && !(type !== 'Hentai' ? existingSubbedFeed : existingHentaiFeed).some((ep) => ep.id === entry.media.id && ep.episode.aired === entry.episode)) { // episode has aired and is missing from existing feed.
                    changes.push(`(${type}) Added Missing Episode ${entry.episode} for ${entry.media.title.userPreferred}`)
                    console.log(`(${type}) Adding Missing Episode ${entry.episode} for ${entry.media.title.userPreferred} to the episode feed.`)
                    const missingEpisode = {
                        id:entry.media.id,
                        ...(entry.media.idMal ? { idMal: entry.media.idMal } : {}),
                        format: entry.media.format,
                        duration: entry.media.duration ? entry.media.duration : durationMap[entry.media.format],
                        episode: {
                            aired: entry.episode,
                            airedAt: past(new Date(entry.airingAt * 1000), 0, false),
                            addedAt: past(new Date(), 0, true)
                        }
                    }
                    missingEpisodes.push(missingEpisode)
                }
            }
        })
        if (missingEpisodes.length > 0) { // save the missing episodes to the existing feed.
            const newFeed = Object.values([...missingEpisodes.filter(({ id, episode }) => !(type !== 'Hentai' ? existingSubbedFeed : existingHentaiFeed).some(media => media.id === id && media.episode.aired === episode.aired)), ...(type !== 'Hentai' ? existingSubbedFeed : existingHentaiFeed)].reduce((acc, item) => { acc[`${item.id}_${item.episode.airedAt}`] = acc[`${item.id}_${item.episode.airedAt}`] || []; acc[`${item.id}_${item.episode.airedAt}`].push(item); return acc }, {})).map(group => group.sort((a, b) => b.episode.aired - a.episode.aired)).flat().sort((a, b) => new Date(b.episode.airedAt) - new Date(a.episode.airedAt))
            saveJSON(path.join(`./raw/${type !== 'Hentai' ? 'sub' : 'hentai'}-episode-feed.json`), newFeed)
            saveJSON(path.join(`./readable/${type !== 'Hentai' ? 'sub' : 'hentai'}-episode-feed-readable.json`), newFeed, true)
            console.log(`Added ${missingEpisodes.length} Missing Episode(s) from the ${type} feed!`)
        } else {
            console.log(`No missing ${type} Episode(s) were found in the airing schedule.`)
        }
    }
    return changes
}

// update sub schedule episode feed //
export async function updateSubFeed(scheduleUpdate, newSchedule) {
    const changes = []
    const schedule = newSchedule ? newSchedule : loadJSON(path.join('./raw/sub-schedule.json'))
    const existingSubbedFeed = loadJSON(path.join('./raw/sub-episode-feed.json'))
    const existingHentaiFeed = loadJSON(path.join('./raw/hentai-episode-feed.json'))

    const newEpisodes = []
    const newHentaiEpisodes = []
    schedule.forEach(entry => {
        entry.airingSchedule?.nodes?.forEach(node => {
            const existingEpisodes = [...existingSubbedFeed.filter(media => media.id === entry.id), ...existingHentaiFeed.filter(media => media.id === entry.id)]

            const newEpisode = {
                id: entry.id,
                ...(entry.idMal ? { idMal: entry.idMal } : {}),
                format: entry.format,
                duration: entry.duration ? entry.duration : durationMap[entry.format],
                episode: {
                    aired: node.episode,
                    airedAt: past(new Date(node.airingAt * 1000), 0, false),
                    addedAt: past(new Date(), 0, true)
                }
            }

            if (!existingEpisodes.some(ep => ep.episode.aired === node.episode) && (new Date(node.airingAt * 1000 - (scheduleUpdate ?  5 * 60 * 1000 : 0))) <= new Date()) {
                if (entry.genres?.includes('Hentai')) { // we don't need this in the main feed...
                    newHentaiEpisodes.push(newEpisode)
                    changes.push(`(Hentai) Added${newSchedule ? ' Missing' : ''} Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred}`)
                    console.log(`Adding${newSchedule ? ' Missing' : ''} Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred} to the Hentai Episode Feed.`)
                } else {
                    newEpisodes.push(newEpisode)
                    changes.push(`(Sub) Added${newSchedule ? ' Missing' : ''} Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred}`)
                    console.log(`Adding${newSchedule ? ' Missing' : ''} Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred} to the Subbed Episode Feed.`)
                }
            }
        })
    })

    const newFeed = Object.values([...newEpisodes.filter(({ id, episode }) => !existingSubbedFeed.some(media => media.id === id && media.episode.aired === episode.aired)), ...existingSubbedFeed].reduce((acc, item) => { acc[`${item.id}_${item.episode.airedAt}`] = acc[`${item.id}_${item.episode.airedAt}`] || []; acc[`${item.id}_${item.episode.airedAt}`].push(item); return acc }, {})).map(group => group.sort((a, b) => b.episode.aired - a.episode.aired)).flat().sort((a, b) => new Date(b.episode.airedAt) - new Date(a.episode.airedAt))
    const hentaiFeed = Object.values([...newHentaiEpisodes.filter(({ id, episode }) => !existingHentaiFeed.some(media => media.id === id && media.episode.aired === episode.aired)), ...existingHentaiFeed].reduce((acc, item) => { acc[`${item.id}_${item.episode.airedAt}`] = acc[`${item.id}_${item.episode.airedAt}`] || []; acc[`${item.id}_${item.episode.airedAt}`].push(item); return acc }, {})).map(group => group.sort((a, b) => b.episode.aired - a.episode.aired)).flat().sort((a, b) => new Date(b.episode.airedAt) - new Date(a.episode.airedAt))

    saveJSON(path.join('./raw/sub-episode-feed.json'), newFeed)
    saveJSON(path.join('./raw/hentai-episode-feed.json'), hentaiFeed)
    saveJSON(path.join('./readable/sub-episode-feed-readable.json'), newFeed, true)
    saveJSON(path.join('./readable/hentai-episode-feed-readable.json'), hentaiFeed, true)

    if (newHentaiEpisodes.length > 0 || newEpisodes.length > 0) {
        if (newHentaiEpisodes.length > 0) {
            console.log(`Added ${newHentaiEpisodes.length}${newSchedule ? ' Missing' : ''} episode(s) to the Hentai Episodes Feed.`)
            console.log(`Logged a total of ${newHentaiEpisodes.length + existingHentaiFeed.length} Hentai Episodes to date.`)
        } else {
            console.log(`No changes detected for the Hentai Episodes Feed.`)
        }
        if (newEpisodes.length > 0) {
            console.log(`Added ${newEpisodes.length}${newSchedule ? ' Missing' : ''} episode(s) to the Subbed Episodes Feed.`)
            console.log(`Logged a total of ${newEpisodes.length + existingSubbedFeed.length} Subbed Episodes to date.`)
        } else {
            console.log(`No changes detected for the Subbed Episodes Feed.`)
        }
    } else {
        console.log(`No changes detected for the Subbed or Hentai Episodes Feed.`)
    }

    return changes
}
