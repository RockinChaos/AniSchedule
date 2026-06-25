const verifiedDubs = [183231]

/**
 * MAL (MyAnimeList) Dubs (Mal-Dubs)
 * Dub information is returned as MyAnimeList ids.
 */
class MALDubs {
    dubLists = null

    constructor() {
        this.getMALDubs()
    }

    isDubMedia(entry) {
        if (this.dubLists?.dubbed && (entry?.media?.media?.idMal || (entry?.media?.media?.id && verifiedDubs.includes(entry?.media?.media.id)))) return this.dubLists.dubbed.includes(entry?.media?.media.idMal) || this.dubLists.incomplete.includes(entry?.media?.media.idMal) || verifiedDubs.includes(entry?.media?.media.id)
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
        this.dubLists = json
        return json
    }

    printError(error) {
        console.error(`Error: ${error.status || 429} - ${error.message}`)
    }
}

export const malDubs = new MALDubs()