import lavenshtein from 'js-levenshtein'
import Bottleneck from 'bottleneck'

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
coverImage {
  extraLarge,
  medium,
  color
},
isAdult,
bannerImage,
airingSchedule(page: 1, perPage: 1, notYetAired: true) {
  nodes {
    episode,
    airingAt
  }
}`

const queryComplexObjects = /* js */`
description(asHtml: false),
season,
seasonYear,
status,
episodes,
duration,
averageScore,
source,
countryOfOrigin,
synonyms,
tags {
  name,
  rank
},
studios(sort: NAME, isMain: true) {
  nodes {
    name
  }
},
stats {
  scoreDistribution {
    score,
    amount
    }
},
nextAiringEpisode {
  timeUntilAiring,
  episode
},
trailer {
  id,
  site
},
streamingEpisodes {
  title,
  thumbnail
},
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
},
studios(sort: NAME, isMain: true) {
  nodes {
    name
  }
},
recommendations {
  edges {
    node {
      rating,
      mediaRecommendation {
        id
      }
    }
  }
}`

/**
 * @param {import('./types/al.d.ts').Media & {lavenshtein?: number}} media
 * @param {string} name
 */
function getDistanceFromTitle (media, name) {
    if (media) {
        const titles = Object.values(media.title).filter(v => v).map(title => lavenshtein(title.toLowerCase(), name.toLowerCase()))
        const synonyms = media.synonyms.filter(v => v).map(title => lavenshtein(title.toLowerCase(), name.toLowerCase()) + 2)
        const distances = [...titles, ...synonyms]
        media.lavenshtein = distances.reduce((prev, curr) => prev < curr ? prev : curr)
        return media
    }
}

export const sleep = t => new Promise(resolve => setTimeout(resolve, t).unref?.())

class AnilistClient {

    ACCESS_TOKEN = process.env.ANILIST_TOKEN

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
            console.error(error)

            if (error.status === 500) return 1

            if (!error.statusText) {
                if (!this.rateLimitPromise) this.rateLimitPromise = sleep(61 * 1000).then(() => {
                    this.rateLimitPromise = null
                })
                return 61 * 1000
            }
            const time = ((error.headers.get('retry-after') || 60) + 1) * 1000
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
              ${queryObjects}
            }
          }
        }`
        return await this.alRequest(query, variables)
    }

    /**
     * Searches for a single media item by ID.
     * @param {Object} variables - The search parameters.
     * @returns {Promise<Query<{media: Media[]}>>} - The result of the search, containing a single media item.
     */
    async searchIDSingle (variables) {
        console.log(`Searching for ID: ${variables?.id}`)
        const query = /* js */` 
        query($id: Int) { 
          Media(id: $id, type: ANIME) {
            ${queryObjects}
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
                  ${queryObjects}
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
            const res = await this.searchIDS({ page: currentPage, perPage: 50, id: variables.id })
            if (!res?.data && res?.errors) { failedRes = res }
            if (res?.data?.Page.media) fetchedIDS = fetchedIDS.concat(res?.data?.Page.media)
            if (!res?.data?.Page.pageInfo.hasNextPage) break
            currentPage++
        }
        const data = new Promise((resolve) => {
            resolve({
                data: {
                    Page: {
                        media: fetchedIDS
                    }
                }
            })
        })
        return await data
    }

    /**
     * @param {{key: string, title: string, year?: string, isAdult: boolean}[]} flattenedTitles
     **/
    async alSearchCompound (flattenedTitles) {
        console.log(`Searching for ${flattenedTitles?.length} titles via compound search`)
        if (!flattenedTitles.length) return []
        // isAdult doesn't need an extra variable, as the title is the same regardless of type, so we re-use the same variable for adult and non-adult requests
        /** @type {Record<`v${number}`, string>} */
        const requestVariables = flattenedTitles.reduce((obj, { title, isAdult }, i) => {
            if (isAdult && i !== 0) return obj
            obj[`v${i}`] = title
            return obj
        }, {})

        const queryVariables = flattenedTitles.reduce((arr, { isAdult }, i) => {
            if (isAdult && i !== 0) return arr
            arr.push(`$v${i}: String`)
            return arr
        }, []).join(', ')
        const fragmentQueries = flattenedTitles.map(({ year, isAdult }, i) => /* js */`
    v${i}: Page(perPage: 10) {
      media(type: ANIME, search: $v${(isAdult && i !== 0) ? i - 1 : i}, status_in: [RELEASING, FINISHED], isAdult: ${!!isAdult} ${year ? `, seasonYear: ${year}` : ''}) {
        ...med
      }
    }`)

        const query = /* js */`
    query(${queryVariables}) {
      ${fragmentQueries}
    }
    
    fragment&nbsp;med&nbsp;on&nbsp;Media {
      id,
      title {
        romaji,
        english,
        native
      },
      synonyms
    }`

        /**
         * @type {import('./types/al.d.ts').Query<Record<string, {media: import('./types/al.d.ts').Media[]}>>}
         * @returns {Promise<[string, import('./types/al.d.ts').Media][]>}
         * */
        const res = await this.alRequest(query, requestVariables)

        /** @type {Record<string, number>} */
        const searchResults = {}
        for (const [variableName, { media }] of Object.entries(res.data)) {
            if (!media.length) continue
            const titleObject = flattenedTitles[Number(variableName.slice(1))]
            if (searchResults[titleObject.key]) continue
            searchResults[titleObject.key] = media.map(media => getDistanceFromTitle(media, titleObject.title)).reduce((prev, curr) => prev.lavenshtein <= curr.lavenshtein ? prev : curr).id
        }

        const ids = Object.values(searchResults)
        const search = await this.searchIDS({ id: ids, perPage: 50 })
        return Object.entries(searchResults).map(([filename, id]) => [filename, search.data.Page.media.find(media => media.id === id)])
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
        if (this.ACCESS_TOKEN) options.headers.Authorization = this.ACCESS_TOKEN
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
