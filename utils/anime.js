import _anitomyscript from 'anitomyscript'
import Fuse from 'fuse.js'
import path from 'path'
import fs from 'fs'

globalThis.__dirname = '' // anitomyscript depression
globalThis.require = (module) => {
    if (module === 'path') {
        // noinspection JSUnusedGlobalSymbols
        return {
            ...path,
            normalize: (p) => {
                const parts = p.split('file://')
                return parts.length > 1 ? parts[1].replace(/^\/[A-Z]:/, '') : p
            }
        }
    }
    if (module === 'fs') return fs
    throw new Error(`Module ${module} not found`)
}

/**
 * @param {Object} nest The nested Object to use for looking up the keys.
 * @param {String} phrase The key phrase to look for.
 * @param {Array} keys Add the specified number of weeks regardless of the episodeDate having past.
 * @param {number} threshold The allowed tolerance, typically for misspellings.
 * @returns {boolean} If the target phrase has been found.
 */
export function matchKeys(nest, phrase, keys, threshold = 0.4) {
    if (!phrase) return true
    if (!nest) return false
    if (new Fuse([nest], { includeScore: true, threshold, keys: keys }).search(phrase).length > 0) return true
    const fuse = new Fuse([phrase], { includeScore: true, threshold, })
    return keys.some((key) => {
        const valueToMatch = nest[key]
        if (valueToMatch) return fuse.search(valueToMatch).length > 0
        return false
    })
}

// utility method for correcting anitomyscript woes for what's needed
export async function anitomyscript (...args) {
    // @ts-ignore
    const res = await _anitomyscript(...args)

    const parseObjs = Array.isArray(res) ? res : [res]

    for (const obj of parseObjs) {
        obj.anime_title ??= ''
        const seasonMatch = obj.anime_title.match(/S(\d{2})E(\d{2})|season-(\d+)/i)
        if (seasonMatch) {
            if (seasonMatch[1] && seasonMatch[2]) {
                obj.anime_season = seasonMatch[1]
                obj.episode_number = seasonMatch[2]
                obj.anime_title = obj.anime_title.replace(/S(\d{2})E(\d{2})/, '')
            } else if (seasonMatch[3]) {
                obj.anime_season = seasonMatch[3]
                obj.anime_title = obj.anime_title.replace(/season-\d+/i, '')
            }
        } else if (Array.isArray(obj.anime_season)) {
            obj.anime_season = obj.anime_season[0]
        }
        const yearMatch = obj.anime_title.match(/ (19[5-9]\d|20\d{2})/)
        if (yearMatch && Number(yearMatch[1]) <= (new Date().getUTCFullYear() + 1)) {
            obj.anime_year = yearMatch[1]
            obj.anime_title = obj.anime_title.replace(/ (19[5-9]\d|20\d{2})/, '')
        }
        if (Number(obj.anime_season) > 1) obj.anime_title += ' S' + obj.anime_season
    }

    return parseObjs
}
