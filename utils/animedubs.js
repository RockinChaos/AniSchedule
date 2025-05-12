import { writable } from 'simple-store-svelte'

/**
 * MAL (MyAnimeList) Dubs (Mal-Dubs)
 * Dub information is returned as MyAnimeList ids.
 */
class MALDubs {
    /** @type {import('simple-store-svelte').Writable<ReturnType<MALDubs['getDubs']>>} */
     dubLists = writable()

    constructor() {
        this.getMALDubs()
    }

    isDubMedia(entry) {
        if (this.dubLists.value?.dubbed && entry?.media?.media?.idMal) return this.dubLists.value.dubbed.includes(entry?.media?.media.idMal) || this.dubLists.value.incomplete.includes(entry?.media?.media.idMal)
        throw new Error(`Detected the route ${entry?.route} is missing resolved media, how did we get here!? The entry: ${JSON.stringify(entry)}`) // absolutely DO NOT continue if we can't verify.
    }

    async getMALDubs() {
        let res = {}
        try {
            res = await fetch(`https://raw.githubusercontent.com/MAL-Dubs/MAL-Dubs/main/data/dubInfo.json?timestamp=${new Date().getTime()}`)
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
            if (res.ok) this.printError(error)
        }
        if (!res.ok) {
            if (json) {
                for (const error of json?.errors || []) {
                    this.printError(error)
                }
            } else {
                this.printError(res)
            }
        }
        this.dubLists.value = await json
        return json
    }

    printError(error) {
        console.error(`Error: ${error.status || 429} - ${error.message}`)
    }
}

export const malDubs = new MALDubs()