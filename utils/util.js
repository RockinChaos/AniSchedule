import fs from 'fs'
import path from 'path'

/**
 * @template T
 * @param {T[]} arr
 * @param {number} n
 */
export function * chunks (arr, n) {
    for (let i = 0; i < arr.length; i += n) {
        yield arr.slice(i, i + n)
    }
}

/**
 * @param {Date} episodeDate The date to compare and correct
 * @param {number} weeks The number of weeks past the episodeDate
 * @param {boolean} skip Add the specified number of weeks regardless of the episodeDate having past
 * @returns {String} The corrected Date as an ISOString
 */
export function past(episodeDate, weeks = 0, skip) {
    if (episodeDate < new Date() || skip) return new Date(episodeDate.getTime() + ((7 * 24 * 60 * 60 * 1000) * weeks)).toISOString().slice(0, -5) + 'Z'
    return episodeDate.toISOString().slice(0, -5) + 'Z'
}

/**
 * @param {Date} date1 The first date to compare
 * @param {Date} date2 The second date to compare
 * @returns {boolean} True if the day and time match, (day of the week aka Monday, exact hours and minutes)
 */
export function dayTimeMatch(date1, date2) {
    return date1.getUTCDay() === date2.getUTCDay() && date1.getUTCHours() === date2.getUTCHours() && date1.getUTCMinutes() === date2.getUTCMinutes()
}

/**
 * @param {String} date1 The first date to compare
 * @param {String} date2 The second date to compare
 * @returns {number} The number of weeks difference between the two dates rounded to the nearest integer.
 */
export function weeksDifference(date1, date2) {
    return Math.round((new Date(date2) - new Date(date1)) / (1000 * 60 * 60 * 24 * 7))
}

export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export const durationMap = { // guesstimate durations based off format type.
    TV: 25,
    TV_SHORT: 5,
    MOVIE: 90,
    SPECIAL: 45,
    OVA: 25,
    ONA: 25,
    MUSIC: 5,
    undefined: 5,
    null: 5,
}

export function mediaTypeMap(mediaType) {
    if (!mediaType) return null
    switch (mediaType.toUpperCase()?.replace('-', '_')?.replace('_CHINESE', '')) {
        case 'TV': return 'TV'
        case 'TV_SHORT': return 'TV_SHORT'
        case 'MOVIE': return 'MOVIE'
        case 'SPECIAL': return 'SPECIAL'
        case 'OVA': return 'OVA'
        case 'ONA': return 'ONA'
        case 'MUSIC': return 'MUSIC'
        default: return null
    }
}

export function getCurrentYearAndWeek() {
    const now = new Date()
    const target = new Date(now.valueOf())
    const dayNumber = (now.getDay() + 6) % 7
    target.setDate(target.getDate() - dayNumber + 3)
    const year = target.getFullYear()

    const firstThursday = new Date(year, 0, 4)
    const week = Math.ceil((target - (firstThursday.getTime() - ((firstThursday.getDay() + 6) % 7) * 24 * 60 * 60 * 1000)) / (7 * 24 * 60 * 60 * 1000))
    const year_weeks = (new Date(year, 11, 31).getDay() === 4 || new Date(year, 0, 1).getDay() === 4) ? 53 : 52
    return { year, week, year_weeks }
}

// gets too many weeks, usually returns 53 when its actually 52 weeks in a year.
/*export function getWeeksInYear(year) {
    const lastDayOfYear = new Date(year, 11, 31)
    return Math.ceil((Math.floor((lastDayOfYear - new Date(year, 0, 1)) / (24 * 60 * 60 * 1000)) + lastDayOfYear.getDay() + 1) / 7)
}*/

export function getWeeksInYear(year) {
    return ((new Date(year, 0, 1).getDay() === 4) || (new Date(year, 11, 31).getDay() === 4)) ? 53 : 52
}

export function calculateWeeksToFetch() {
    const { year, week} = getCurrentYearAndWeek()
    const weeksInCurrentYear = getWeeksInYear(year)
    const remainingWeeksThisYear = weeksInCurrentYear - week

    if (remainingWeeksThisYear >= 26) {
        return { startYear: year, startWeek: week, endYear: year, endWeek: weeksInCurrentYear }
    } else {
        const extraWeeks = 26 - remainingWeeksThisYear
        const nextYear = year + 1
        const weeksInNextYear = getWeeksInYear(nextYear)

        return {
            startYear: year,
            startWeek: week,
            endYear: nextYear,
            endWeek: Math.min(extraWeeks, weeksInNextYear),
        }
    }
}

/**
 * Determines if the current month is a Daylight Saving Time (DST) transition month.
 *
 * This function checks whether the current month is:
 * - The month when DST **started** (e.g., March in the U.S.).
 * - The month when DST **ended** (e.g., November in the U.S.).
 *
 * @returns {boolean} `true` if the current month is the start or end month of DST, otherwise `false`.
 */
export function isDSTTransitionMonth() {
    const now = new Date()
    const year = now.getFullYear()
    const standardOffset = Math.max(new Date(year, 0, 1).getTimezoneOffset(), new Date(year, 6, 1).getTimezoneOffset())
    let dstStartMonth = null
    let dstEndMonth = null
    let lastOffset = standardOffset
    for (let month = 0; month < 12; month++) {
        for (let day = 1; day <= 31; day++) {
            const testDate = new Date(year, month, day)
            if (testDate.getMonth() !== month) break
            const testOffset = testDate.getTimezoneOffset()
            if (dstStartMonth === null && testOffset < standardOffset) dstStartMonth = month
            if (dstStartMonth !== null && dstEndMonth === null && testOffset === standardOffset) dstEndMonth = month
            lastOffset = testOffset
        }
    }
    return now.getMonth() === dstStartMonth || now.getMonth() === dstEndMonth
}

/**
 * Determines the start and end dates of Daylight Saving Time (DST) for the current year.
 *
 * DST starts on the second Sunday of March at 2:00 AM (when clocks move forward by 1 hour).
 * DST ends on the first Sunday of November at 2:00 AM (when clocks move back by 1 hour).
 *
 * @returns {{ dstStart: Date | null, dstEnd: Date | null }} An object containing:
 *   - `dstStart`: The exact Date object representing when DST starts, or `null` if not found.
 *   - `dstEnd`: The exact Date object representing when DST ends, or `null` if not found.
 */
export function getDSTStartEndDates() {
    const year = new Date().getFullYear()
    let dstStart = null
    let dstEnd = null
    const janOffset = new Date(year, 0, 1).getTimezoneOffset()
    const julOffset = new Date(year, 6, 1).getTimezoneOffset()
    const standardOffset = Math.max(janOffset, julOffset)
    for (let month = 2; month < 3; month++) { // March
        for (let day = 1; day <= 31; day++) {
            const testDate = new Date(year, month, day, 2, 0, 0)
            if (testDate.getMonth() !== month) break
            if (testDate.getTimezoneOffset() < standardOffset) {
                dstStart = testDate
                break
            }
        }
        if (dstStart) break
    }
    for (let month = 10; month < 11; month++) { // November
        for (let day = 1; day <= 7; day++) {
            const testDate = new Date(year, month, day, 2, 0, 0)
            if (testDate.getMonth() !== month) break
            if (testDate.getDay() === 0 && testDate.getTimezoneOffset() === standardOffset) {
                dstEnd = testDate
                break
            }
        }
        if (dstEnd) break
    }
    if (dstStart && new Date() > dstEnd) dstStart = null
    return { dstStart, dstEnd }
}

/**
 * @param {Date} date1 The date to be compared to date2 (or today)
 * @param {Date} date2 The most recent date to be compared (leave empty for today's date).
 * @returns {number} The number of days difference between the specified date and today.
 */
export function daysAgo(date1, date2) {
    return Math.floor(((date2 || new Date()) - date1) / (1000 * 60 * 60 * 24));
}

/**
 * Monday - 1
 * Tuesday - 2
 * Wednesday - 3
 * Thursday - 4
 * Friday - 5
 * Saturday - 6
 * Sunday - 7
 */
export function getCurrentDay() {
    const day = (new Date()).getDay()
    return day === 0 ? 7 : day
}

export function fixTime(delayedDate, episodeDate, modify) {
    const delayed = new Date(delayedDate)
    const episodeAt = new Date(episodeDate)
    if (modify) delayed.setDate(delayed.getDate() + (episodeAt.getDay() - delayed.getDay()))
    delayed.setUTCHours(episodeAt.getUTCHours())
    delayed.setUTCMinutes(episodeAt.getUTCMinutes())
    delayed.setUTCSeconds(episodeAt.getUTCSeconds())
    return past(delayed, 0, false)
}

export function loadJSON(filePath) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify([]))
    try {
        return JSON.parse(fs.readFileSync(filePath))
    } catch (error) {
        return []
    }
}

function ensureDirectoryExists(filePath) {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
}

export function saveJSON(filePath, data, prettyPrint = false) {
    ensureDirectoryExists(filePath)
    fs.writeFileSync(filePath, JSON.stringify(data, null, prettyPrint ? 2 : 0))
}

/**
 * Used to fill in missing/needed info for the episode feed, helping fix issues that can occur when updating the script.
 * @param {String} type The type (key) to fetch and set, e.g. 'format'
 * @param {String} feed The episode feed to modify, either sub, dub, or hentai.
 */
export async function updateEpisodeFeed(type, feed) {
    const { anilistClient } = await import('./anilist.js')
    const episodeFeed = loadJSON(path.join(`./raw/${feed}-episode-feed.json`))
    const missingTypeIDs = Array.from(new Set(episodeFeed.filter(entry => !entry[type]).map(entry => entry.id)))

    if (missingTypeIDs.length === 0) {
        console.log(`No missing ${type}(s) detected for ${feed.includes('dub') ? 'Dubbed' : feed.includes('hentai') ? 'Hentai' : 'Subbed'} Episodes.`)
        return episodeFeed
    }

    console.log(`Fetching ${type}(s) for IDs: ${missingTypeIDs}`)

    const searchResponse = await anilistClient.searchAllIDS({ id: missingTypeIDs })
    const updatedFeed = episodeFeed.map(entry => {
        if (!entry[type]) {
            const matchedMedia = searchResponse.data.Page.media.find(media => media.id === entry.id)
            if (matchedMedia) {
                const { episode, ...rest } = entry
                return { ...rest, [type]: matchedMedia[type], episode }
            }
        }
        return entry
    }).sort((a, b) => new Date(b.episode.airedAt).getTime() - new Date(a.episode.airedAt).getTime())

    saveJSON(path.join(`./raw/${feed}-episode-feed.json`), updatedFeed)
    saveJSON(path.join(`./readable/${feed}-episode-feed-readable.json`), updatedFeed, true)
    console.log(`${feed.includes('dub') ? 'Dubbed' : feed.includes('hentai') ? 'Hentai' : 'Subbed'} Episode feed successfully updated with missing ${type}(s).`)
}
