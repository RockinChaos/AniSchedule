import Bottleneck from 'bottleneck'
import { sleep } from './util.js'

const queryObjects = /* js */`
id,
idMal,
title {
  romaji,
  english,
  native,
  userPreferred
},
format,
genres,
duration,
seasonYear,
coverImage {
  extraLarge,
  medium,
  color
},
isAdult,
bannerImage,
relations {
  edges {
    relationType(version:2),
    node {
      id,
      type,
      format,
      seasonYear
    }
  }
}`

const queryAiringObjects = /* js */`
airingSchedule(page: 1, perPage: 50, notYetAired: true) {
  nodes {
    episode,
    airingAt
  }
}`

const queryAiredObjects = /* js */`
airingSchedule(page: 1, perPage: 50, notYetAired: false) {
  nodes {
    episode,
    airingAt
  }
}`

class AnilistClient {

    limiter = new Bottleneck({
        reservoir: 90,
        reservoirRefreshAmount: 90,
        reservoirRefreshInterval: 60 * 1000,
        maxConcurrent: 10,
        minTime: 100
    })

    rateLimitPromise = null

    constructor () {
        console.log('Initializing Anilist Client')
        this.limiter.on('failed', async (error) => {
            console.log(`AniList Rate Limit: ${error.statusText || error.status}`)

            if (error.status === 500) return 1

            if (!error.statusText) {
                if (!this.rateLimitPromise) this.rateLimitPromise = sleep(61 * 1000).then(() => {
                    this.rateLimitPromise = null
                })
                return 61 * 1000
            }
            const time = (Number((error.headers.get('retry-after') || 60)) + 1) * 1000
            if (!this.rateLimitPromise) this.rateLimitPromise = sleep(time).then(() => {
                this.rateLimitPromise = null
            })
            return time
        })
    }

    /**
     * Searches for all media matching the query variables.
     * @param {Object} variables - The search parameters.
     * @returns {Promise<PagedQuery<{media: Media[]}>>} - The result of the search, containing media data.
     */
    async search (variables = {}) {
        console.log(`Searching ${JSON.stringify(variables)}`)
        const query = /* js */` 
        query($page: Int, $perPage: Int, $sort: [MediaSort], $search: String, $onList: Boolean, $status: MediaStatus, $status_not: MediaStatus, $season: MediaSeason, $year: Int, $genre: [String], $tag: [String], $format: MediaFormat, $id_not: [Int], $idMal_not: [Int], $idMal: [Int]) {
          Page(page: $page, perPage: $perPage) {
            pageInfo {
              hasNextPage
            },
            media(id_not_in: $id_not, idMal_not_in: $idMal_not, idMal_in: $idMal, type: ANIME, search: $search, sort: $sort, onList: $onList, status: $status, status_not: $status_not, season: $season, seasonYear: $year, genre_in: $genre, tag_in: $tag, format: $format, format_not: MUSIC) {
              ${queryObjects},${variables?.aired ? queryAiredObjects : queryAiringObjects}
            }
          }
        }`
        return await this.alRequest(query, variables)
    }

    /**
     * Searches for media by IDs.
     * @param {Object} variables - The search parameters.
     * @returns {Promise<PagedQuery<{media: Media[]}>>} - The result of the search, containing media data.
     */
    async searchIDS (variables) {
        console.log(`Searching for IDs ${JSON.stringify(variables)}`)
        const query = /* js */` 
            query($id: [Int], $idMal: [Int], $id_not: [Int], $page: Int, $perPage: Int, $status: [MediaStatus], $onList: Boolean, $sort: [MediaSort], $search: String, $season: MediaSeason, $year: Int, $genre: [String], $tag: [String], $format: MediaFormat) { 
              Page(page: $page, perPage: $perPage) {
                pageInfo {
                  hasNextPage
                },
                media(id_in: $id, idMal_in: $idMal, id_not_in: $id_not, type: ANIME, status_in: $status, onList: $onList, search: $search, sort: $sort, season: $season, seasonYear: $year, genre_in: $genre, tag_in: $tag, format: $format) {
                  ${queryObjects},${variables?.aired ? queryAiredObjects : queryAiringObjects}
                }
              }
            }`
        return await this.alRequest(query, variables)
    }

    /** returns {import('./al.d.ts').PagedQuery<{media: import('./al.d.ts').Media[]}>} */
    async searchAllIDS (variables) {
        console.log(`Searching for (ALL) IDs ${JSON.stringify(variables)}`)
        let fetchedIDS = []
        let currentPage = 1

        // cycle until all paged ids are resolved.
        let failedRes
        while (true) {
            const res = await this.searchIDS({ ...variables, page: currentPage, perPage: 50, ...( variables?.id && variables?.id?.length !== 0 ? { id: [...new Set(variables.id)] } : { idMal: [...new Set(variables.idMal)] }) })
            if (!res?.data && res?.errors) { failedRes = res }
            if (res?.data?.Page.media) fetchedIDS = fetchedIDS.concat(res?.data?.Page.media)
            if (!res?.data?.Page.pageInfo.hasNextPage) break
            currentPage++
        }
        return {
            data: {
                Page: {
                    pageInfo: {
                        hasNextPage: false
                    },
                    media: fetchedIDS
                }
            }
        }
    }

    /** returns {import('./al.d.ts').PagedQuery<{media: import('./al.d.ts').Media[]}>} */
    async fetchAiringSchedule (variables) {
        if (!variables.to && variables.from) variables.to = (variables.from + 7 * 24 * 60 * 60)
        console.log(`Fetching airing schedule ${JSON.stringify(variables)}`)
        let fetchedSchedules = []
        let currentPage = 1

        // cycle until all paged episodes are resolved.
        let failedRes
        while (true) {
            const res = await this.searchAiringEpisodes({ page: currentPage, perPage: 50, ...variables })
            if (!res?.data && res?.errors) { failedRes = res }
            if (res?.data?.Page.airingSchedules) fetchedSchedules = fetchedSchedules.concat(res?.data?.Page.airingSchedules)
            if (!res?.data?.Page.pageInfo.hasNextPage) break
            currentPage++
        }
        return {
            data: {
                Page: {
                    pageInfo: {
                        hasNextPage: false
                    },
                    airingSchedules: fetchedSchedules
                }
            }
        }
    }

    async searchAiringEpisodes (variables = {}) {
        console.log(`Searching for episodes in the specified time ${JSON.stringify(variables)}`)
        if (!variables.to && variables.from) variables.to = (variables.from + 7 * 24 * 60 * 60)
        const query = /* js */` 
            query($page: Int, $perPage: Int, $from: Int, $to: Int) {
              Page(page: $page, perPage: $perPage) {
                pageInfo {
                  hasNextPage
                },
                airingSchedules(airingAt_greater: $from, airingAt_lesser: $to) {
                  episode,
                  timeUntilAiring,
                  airingAt,
                  media {
                    ${queryObjects},${variables?.aired ? queryAiredObjects : queryAiringObjects}
                  }
                }
              }
            }`
        /** @type {import('./al.d.ts').PagedQuery<{ airingSchedules: { timeUntilAiring: number, airingAt: number, episode: number, media: import('./al.d.ts').Media}[]}>} */
        return await this.alRequest(query, variables)
    }

    /** returns {import('./al.d.ts').PagedQuery<{media: import('./al.d.ts').Media[]}>} */
    async fetchEpisodes (variables) {
        console.log(`Fetching airing schedule ${JSON.stringify(variables)}`)
        let fetchedSchedules = []
        let currentPage = 1

        // cycle until all paged episodes are resolved.
        let failedRes
        while (true) {
            const res = await this.episodes({ page: currentPage, perPage: 50, ...variables })
            if (!res?.data && res?.errors) { failedRes = res }
            if (res?.data?.Page.airingSchedules) fetchedSchedules = fetchedSchedules.concat(res?.data?.Page.airingSchedules)
            if (!res?.data?.Page.pageInfo.hasNextPage) break
            currentPage++
        }
        return {
            data: {
                Page: {
                    pageInfo: {
                        hasNextPage: false
                    },
                    airingSchedules: fetchedSchedules
                }
            }
        }
    }

    /** @returns {Promise<import('./al.d.ts').PagedQuery<{ airingSchedules: { airingAt: number, episode: number }[]}>>} */
    async episodes (variables = {}) {
        console.log(`Getting episodes for ${variables.id}`)
        const query = /* js */` 
          query($page: Int, $perPage: Int, $id: [Int]) {
            Page(page: $page, perPage: $perPage) {
              pageInfo {
                hasNextPage
              },
              airingSchedules(mediaId_in: $id) {
                mediaId,
                airingAt,
                episode
              }
            }
          }`
        return await this.alRequest(query, variables)
    }

    /**
     * @param {string} query
     * @param {Record<string, any>} variables
     */
    alRequest (query, variables) {
        /** @type {RequestInit} */
        const options = {
            method: 'POST',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                query: query.replace(/\s/g, '').replaceAll('&nbsp;', ' '),
                variables: {
                    page: 1,
                    perPage: 50,
                    ...variables
                }
            })
        }
        return this.handleRequest(options)
    }

    /** @type {(options: RequestInit) => Promise<any>} */
    handleRequest = this.limiter.wrap(async opts => {
        await this.rateLimitPromise
        let res = {}
        try {
            res = await fetch('https://graphql.anilist.co', opts)
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
            if (res.ok) console.log(`(AniList) Failed getting json from query: ${error.status || 429} - ${error?.message}`)
        }
        if (!res.ok && res.status !== 404) {
            if (json) {
                for (const error of json?.errors || []) {
                    console.log(`(AniList) Error occurred with json: ${error.status || 429} - ${error?.message}`)
                }
            } else {
                console.log(`(AniList) Unknown error occurred query: ${res.status || 429} - ${res?.message}`)
            }
        }
        return json
    })
}

export const anilistClient = new AnilistClient()
