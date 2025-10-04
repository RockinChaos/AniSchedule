import _anitomyscript from 'anitomyscript'
import AnimeResolver from './animeresolver.js'
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
 * Retrieves a nested value from an object using a dot-separated path.
 * @param {Object} obj - The object to retrieve the value from.
 * @param {string} path - The dot-separated path (e.g., 'title.userPreferred').
 * @returns {*} - The value at the specified path or undefined.
 */
function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, key) => acc && acc[key], obj)
}

/**
 * Sets a nested value in an object using a dot-separated path.
 * @param {Object} obj - The object to modify.
 * @param {string} path - The dot-separated path (e.g., 'title.userPreferred').
 * @param {*} value - The value to set.
 */
function setNestedValue(obj, path, value) {
    const keys = path.split('.')
    let current = obj
    while (keys.length > 1) {
        const key = keys.shift()
        if (!current[key] || typeof current[key] !== 'object') current[key] = {}
        current = current[key]
    }
    current[keys[0]] = value
}

function cleanText(text) {
    if (typeof text !== 'string') return ''
    return AnimeResolver.cleanFileName(text).replace(/['’]/gu, '').replace(/[^\p{L}\p{N}\p{Zs}\p{Pd}]/gu, ' ').replace(/\s+/g, ' ').trim()
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
    const match = new Fuse([nest], { includeScore: true, threshold, keys: keys }).search(phrase).length > 0
    if (match) return match
    else {
        let anyCleaned = false
        const cleanedNest = {}
        for (const key of keys) {
            const value = getNestedValue(nest, key)
            if (typeof value === 'string') {
                const cleaned = cleanText(value)
                setNestedValue(cleanedNest, key, cleaned)
                if (cleaned !== value) anyCleaned = true
            } else if (Array.isArray(value)) {
                const cleanedArray = value.filter(v => typeof v === 'string').map(cleanText)
                if (cleanedArray.length) {
                    setNestedValue(cleanedNest, key, cleanedArray)
                    if (JSON.stringify(cleanedArray) !== JSON.stringify(value)) anyCleaned = true
                }
            }
        }
        return (new Fuse([cleanedNest], { includeScore: true, threshold: anyCleaned ? threshold + .05 : threshold, keys: keys }).search(phrase).length > 0)
    }
    /*if (new Fuse([nest], { includeScore: true, threshold, keys: keys }).search(phrase).length > 0) return true
    const fuse = new Fuse([phrase], { includeScore: true, threshold, })
    return keys.some((key) => { // this was causing way too many problems as some title routes are just stupidly similar causing them to resolve as the incorrect series... probably don't ever use this again.
        const valueToMatch = nest[key]
        if (valueToMatch) return fuse.search(valueToMatch).length > 0
        return false
    })*/
}

function getByPath(obj, path) {
    return path.split('.').reduce((acc, part) => acc?.[part], obj)
}

export function exactMatch(nest, title, keys) {
    return keys.some(k => {
        const val = getByPath(nest, k)
        return val && AnimeResolver.cleanFileName(val.toLowerCase()) === AnimeResolver.cleanFileName(title?.toLowerCase())
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
        if (obj.episode_number?.includes('.')) { // stupid fix for 2.5 Dimensional Seduction. We resolve anime titles not video so there should be ZERO reason to use an "episode" that is a double.
            obj.anime_title = obj.file_name.replace(Number(obj.anime_season) > 1 ? /\b(?:\d+(?:st|nd|rd|th)?\s*Season|Season\s*\d+)\b/gi : '', '')
            delete obj.episode_number
        }
        if (Number(obj.anime_season || obj.episode_number) > 1) obj.anime_title += ' S' + (obj.anime_season || obj.episode_number) // use episode number as we are resolving anime titles not video. Anitomyscript is stupid sometimes...
    }

    return parseObjs
}
