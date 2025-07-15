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
    results.data.Page.media = results.data.Page.media.filter((media, index, self) => media.airingSchedule?.nodes?.[0]?.airingAt && self.findIndex(m => m.id === media.id) === index).sort((a, b) => a.id - b.id)
	//.sort((a, b) => a.airingSchedule.nodes[0].episode - b.airingSchedule.nodes[0].episode).sort((a, b) => a.airingSchedule.nodes[0].airingAt - b.airingSchedule.nodes[0].airingAt) // probably best to retire sorting like this. It will help reduce the number of line changes in a commit, reducing complexity.

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
                    if ((entry.idMal && (episode.idMal !== entry.idMal)) || (episode.format !== entry.format) || (episode.duration !== (entry.duration ? entry.duration : durationMap[entry.format]))) {
                        changes.push(`(${type}) Updated Episode ${episode.episode.aired} for ${entry.title.userPreferred} to correct its idMal, format, and duration.`)
                        console.log(`(${type}) Updated Episode ${episode.episode.aired} for ${entry.title.userPreferred} to correct its idMal, format, and duration as it was found to be different than the current airing schedule.`)
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
    const exactSubbedFeed = loadJSON(path.join('./raw/sub-episode-feed.json'))
    const exactHentaiFeed = loadJSON(path.join('./raw/hentai-episode-feed.json'))
    const existingSubbedFeed = structuredClone(exactSubbedFeed)
    const existingHentaiFeed = structuredClone(exactHentaiFeed)

    const newEpisodes = []
    const modifiedEpisodes = []
    const removedEpisodes = []
    const newHentaiEpisodes = []
    const modifiedHentaiEpisodes = []
    const removedHentaiEpisodes = []
    schedule.forEach(entry => {
        const hentai = entry.genres?.includes('Hentai')
        entry.airingSchedule?.nodes?.forEach(node => {
            const scheduledAiringTime = new Date(node.airingAt * 1000)
            const existingEpisodes = [...existingSubbedFeed.filter(media => media.id === entry.id), ...existingHentaiFeed.filter(media => media.id === entry.id)]

            // Make any necessary corrections to aired episodes.
            existingEpisodes.forEach(existing => {
                if (existing.episode?.aired === node.episode) {
                    if (scheduledAiringTime > new Date()) { // Filter out any existing episode feed entries that matches any delayed episodes
                        const feed = hentai ? existingHentaiFeed : existingSubbedFeed
                        const index = feed.findIndex(ep => ep.id === entry.id && ep.episode.aired === node.episode)
                        if (index !== -1) {
                            feed.splice(index, 1)
                            changes.push(`(${hentai ? 'Hentai' : 'Sub'}) Removed Episode ${node.episode} of ${entry.title.userPreferred} as it has been delayed`)
                            console.log(`Removed Episode ${node.episode} of ${entry.title.userPreferred} from the ${hentai ? 'Hentai' : 'Subbed'} Episode Feed as it has been delayed!`)
                            if (hentai) removedHentaiEpisodes.push(existing)
                            else removedEpisodes.push(existing)
                        }
                    } else { // Filter out any existing episode feed entries that matches any delayed episodes
                        const airedAt = new Date(existing.episode.airedAt)
                        if (Math.abs(airedAt - scheduledAiringTime) > 30 * 1000) {
                            existing.episode.airedAt = past(scheduledAiringTime, 0, false)
                            changes.push(`(${hentai ? 'Hentai' : 'Sub'}) Modified Episode ${node.episode} of ${entry.title.userPreferred} from ${past(airedAt, 0, false)} to ${existing.episode.airedAt}`)
                            console.log(`Modified Episode ${node.episode} of ${entry.title.userPreferred} from the ${hentai ? 'Hentai' : 'Subbed'} Episode Feed with aired date from ${past(airedAt, 0, false)} to ${existing.episode.airedAt}`)
                            if (hentai) modifiedHentaiEpisodes.push(existing)
                            else modifiedEpisodes.push(existing)
                        }
                    }
                }
            })

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
                if (hentai) newHentaiEpisodes.push(newEpisode)
                else newEpisodes.push(newEpisode)
                changes.push(`(${hentai ? 'Hentai' : 'Sub'}) Added${newSchedule ? ' Missing' : ''} Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred}`)
                console.log(`Adding${newSchedule ? ' Missing' : ''} Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred} to the ${hentai ? 'Hentai' : 'Subbed'} Episode Feed.`)
            }
        })
    })

    const newFeed = Object.values([...newEpisodes.filter(({ id, episode }) => !existingSubbedFeed.some(media => media.id === id && media.episode.aired === episode.aired)), ...existingSubbedFeed].reduce((acc, item) => { acc[`${item.id}_${item.episode.airedAt}`] = acc[`${item.id}_${item.episode.airedAt}`] || []; acc[`${item.id}_${item.episode.airedAt}`].push(item); return acc }, {})).map(group => group.sort((a, b) => b.episode.aired - a.episode.aired)).flat().sort((a, b) => new Date(b.episode.airedAt) - new Date(a.episode.airedAt))
    const hentaiFeed = Object.values([...newHentaiEpisodes.filter(({ id, episode }) => !existingHentaiFeed.some(media => media.id === id && media.episode.aired === episode.aired)), ...existingHentaiFeed].reduce((acc, item) => { acc[`${item.id}_${item.episode.airedAt}`] = acc[`${item.id}_${item.episode.airedAt}`] || []; acc[`${item.id}_${item.episode.airedAt}`].push(item); return acc }, {})).map(group => group.sort((a, b) => b.episode.aired - a.episode.aired)).flat().sort((a, b) => new Date(b.episode.airedAt) - new Date(a.episode.airedAt))

    if (JSON.stringify(newFeed) !== JSON.stringify(exactSubbedFeed || {})) { // helps prevent rebase conflicts
        saveJSON(path.join('./raw/sub-episode-feed.json'), newFeed)
        saveJSON(path.join('./readable/sub-episode-feed-readable.json'), newFeed, true)
    }
    if (JSON.stringify(hentaiFeed) !== JSON.stringify(exactHentaiFeed || {})) { // helps prevent rebase conflicts
        saveJSON(path.join('./raw/hentai-episode-feed.json'), hentaiFeed)
        saveJSON(path.join('./readable/hentai-episode-feed-readable.json'), hentaiFeed, true)
    }

    if (newHentaiEpisodes.length > 0 || modifiedHentaiEpisodes.length > 0 || removedHentaiEpisodes.length > 0 || newEpisodes.length > 0 || modifiedEpisodes.length > 0 || removedEpisodes.length > 0) {
        if (newHentaiEpisodes.length > 0 || modifiedHentaiEpisodes.length > 0 || removedHentaiEpisodes.length > 0) {
            console.log(
                `${newHentaiEpisodes.length > 0 ? `Added ${newHentaiEpisodes.length}${newSchedule ? ' Missing' : ''}` : ''}`
                + `${modifiedHentaiEpisodes.length > 0 ? `${newHentaiEpisodes.length > 0 ? ' and ' : ''}Modified ${modifiedHentaiEpisodes.length}` : ''}`
                + `${removedHentaiEpisodes.length > 0 ? `${(newHentaiEpisodes.length > 0 || modifiedHentaiEpisodes.length > 0) ? ' and ' : ''}Removed ${removedHentaiEpisodes.length}` : ''}`
                + ` episode(s) ${(modifiedHentaiEpisodes.length > 0 || removedHentaiEpisodes.length > 0) ? 'from' : 'to'} the Hentai Episodes Feed.`)
            console.log(`Logged a total of ${existingHentaiFeed.length + newHentaiEpisodes.length} Hentai Episodes to date.`)
        } else console.log(`No changes detected for the Hentai Episodes Feed.`)

        if (newEpisodes.length > 0 || modifiedEpisodes.length > 0 || removedEpisodes.length > 0) {
            console.log(`${newEpisodes.length > 0 ? `Added ${newEpisodes.length}${newSchedule ? ' Missing' : ''}` : ''}`
                + `${modifiedEpisodes.length > 0 ? `${newEpisodes.length > 0 ? ' and ' : ''}Modified ${modifiedEpisodes.length}` : ''}`
                + `${removedEpisodes.length > 0 ? `${(newEpisodes.length > 0 || modifiedEpisodes.length > 0) ? ' and ' : ''}Removed ${removedEpisodes.length}` : ''}`
                + ` episode(s) ${(modifiedEpisodes.length > 0 || removedEpisodes.length > 0) ? 'from' : 'to'} the Subbed Episodes Feed.`)
            console.log(`Logged a total of ${existingSubbedFeed.length + newEpisodes.length} Subbed Episodes to date.`)
        } else console.log(`No changes detected for the Subbed Episodes Feed.`)

    } else console.log(`No changes detected for the Subbed or Hentai Episodes Feed.`)

    return changes
}
