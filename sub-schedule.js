// noinspection JSUnresolvedReference,NpmUsedModulesInstalled

import { past, loadJSON, saveJSON } from './utils/util.js'
import path from 'path'

// update sub schedule //
export async function fetchSubSchedule() {
    const { anilistClient } = await import('./utils/anilist.js')
    const { writeFile } = await import('node:fs/promises')
    const changes = []

    const date = new Date()
    const seasons = ['WINTER', 'SPRING', 'SUMMER', 'FALL']
    const currentSeason = seasons[Math.floor((date.getMonth() / 12) * 4) % 4]
    const currentYear = date.getFullYear()
    const results = { data: { Page: { media: [], pageInfo: { hasNextPage: false } } } }

    for (let page = 1, hasNextPage = true; hasNextPage && page < 5; ++page) {
        const res = await anilistClient.search({ season: currentSeason, year: currentYear, page, perPage: 50 })
        if (!res?.data && res?.errors) throw res.errors[0]
        hasNextPage = res.data.Page.pageInfo.hasNextPage
        results.data.Page.media = results.data.Page.media.concat(res.data.Page.media)
    }

    for (let season of seasons) {
        const res = await anilistClient.search({ season: seasons.at(seasons.indexOf(season) - 1), year: season === 'WINTER' ? currentYear - 1 : currentYear, status: 'RELEASING', page: 1, perPage: 50 })
        if (!res?.data && res?.errors) throw res.errors[0]
        results.data.Page.media = results.data.Page.media.concat(res.data.Page.media).filter((media, index, self) => media.airingSchedule?.nodes?.[0]?.airingAt && self.findIndex(m => m.id === media.id) === index)
    }

    if (currentSeason === 'FALL') {
        for (let page = 1, hasNextPage = true; hasNextPage && page < 5; ++page) {
            const res = await anilistClient.search({ season: 'WINTER', year: currentYear + 1, page, perPage: 50 })
            if (!res?.data && res?.errors) throw res.errors[0]
            hasNextPage = res.data.Page.pageInfo.hasNextPage
            results.data.Page.media = results.data.Page.media.concat(res.data.Page.media)
        }
    }

    results.data.Page.media = results.data.Page.media.filter(media => media.airingSchedule?.nodes?.[0]?.airingAt).sort((a, b) => a.airingSchedule.nodes[0].airingAt - b.airingSchedule.nodes[0].airingAt)

    const media = results?.data?.Page?.media
    media.forEach((a) => { if (new Date(a.airingSchedule.nodes[0].airingAt).getTime() > (new Date().getTime() / 1000) && !(a.airingSchedule.nodes[0].episode > 1)) a.unaired = true })
    if (media?.length > 0) {
        console.log(`Successfully resolved ${media.length} airing, saving...`)
        await writeFile('./raw/sub-schedule.json', JSON.stringify(media))
        await writeFile('./readable/sub-schedule-readable.json', JSON.stringify(media, null, 2))
    } else {
        console.error('Error: Failed to resolve the sub airing schedule, it cannot be null!')
        process.exit(1)
    }
    return changes
}

// update sub schedule episode feed //
export async function updateSubFeed() {
    const changes = []
    const schedule = loadJSON(path.join('./raw/sub-schedule.json'))
    let existingSubbedFeed = loadJSON(path.join('./raw/sub-episode-feed.json'))
    let existingHentaiFeed = loadJSON(path.join('./raw/hentai-episode-feed.json'))

    const newEpisodes = []
    const newHentaiEpisodes = []
    schedule.forEach(entry => {
        entry.airingSchedule?.nodes?.forEach(node => {
            const existingEpisodes = [...existingSubbedFeed.filter(media => media.id === entry.id), ...existingHentaiFeed.filter(media => media.id === entry.id)]
            const lastFeedEpisode = existingEpisodes.reduce((max, ep) => Math.max(max, ep.episode.aired), 0)
            const airingAt = new Date(node.airingAt * 1000)

            const newEpisode = {
                id: entry.id,
                ...(entry.idMal ? { idMal: entry.idMal } : {}),
                format: entry.format,
                episode: {
                    aired: node.episode,
                    airedAt: past(airingAt, 0, false)
                }
            }

            if (node.episode !== lastFeedEpisode && airingAt <= new Date()) {
                if (entry.genres?.includes("Hentai")) { // we don't need this in the main feed...
                    newHentaiEpisodes.push(newEpisode)
                    changes.push(`(Hentai) Added Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred}`)
                    console.log(`Adding Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred} to the Hentai Episode Feed.`)
                } else {
                    newEpisodes.push(newEpisode)
                    changes.push(`(Sub) Added Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred}`)
                    console.log(`Adding Episode ${newEpisode.episode.aired} for ${entry.title.userPreferred} to the Subbed Episode Feed.`)
                }
            }
        })
    })

    const newFeed = [...(newEpisodes.filter(({ id, episode }) => !existingSubbedFeed.some(media => media.id === id && media.episode.aired === episode.aired)).sort((a, b) => b.episode.aired - a.episode.aired)), ...existingSubbedFeed].sort((a, b) => new Date(b.episode.airedAt).getTime() - new Date(a.episode.airedAt).getTime())
    const hentaiFeed = [...(newHentaiEpisodes.filter(({ id, episode }) => !existingHentaiFeed.some(media => media.id === id && media.episode.aired === episode.aired)).sort((a, b) => b.episode.aired - a.episode.aired)), ...existingHentaiFeed].sort((a, b) => new Date(b.episode.airedAt).getTime() - new Date(a.episode.airedAt).getTime())

    saveJSON(path.join('./raw/sub-episode-feed.json'), newFeed)
    saveJSON(path.join('./raw/hentai-episode-feed.json'), hentaiFeed)
    saveJSON(path.join('./readable/sub-episode-feed-readable.json'), newFeed, true)
    saveJSON(path.join('./readable/hentai-episode-feed-readable.json'), hentaiFeed, true)

    if (newHentaiEpisodes.length > 0 || newEpisodes.length > 0) {
        if (newHentaiEpisodes.length > 0) {
            console.log(`Added ${newHentaiEpisodes.length} episode(s) to the Hentai Episodes Feed.`)
            console.log(`Logged a total of ${newHentaiEpisodes.length + existingHentaiFeed.length} Hentai Episodes to date.`)
        } else {
            console.log(`No changes detected for the Hentai Episodes Feed.`)
        }
        if (newEpisodes.length > 0) {
            console.log(`Added ${newEpisodes.length} episode(s) to the Hentai Episodes Feed.`)
            console.log(`Logged a total of ${newEpisodes.length + existingSubbedFeed.length} Subbed Episodes to date.`)
        } else {
            console.log(`No changes detected for the Subbed Episodes Feed.`)
        }
    } else {
        console.log(`No changes detected for the Subbed or Hentai Episodes Feed.`)
    }

    return changes
}
