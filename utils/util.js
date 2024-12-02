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
 * @param {Date} date1 The first date to compare
 * @param {Date} date2 The second date to compare
 * @returns {number} The number of weeks difference between the two dates rounded to the nearest integer.
 */
export function weeksDifference(date1, date2) {
    return Math.round((new Date(date2) - new Date(date1)) / (1000 * 60 * 60 * 24 * 7))
}

export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
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

export function getWeeksInYear(year) {
    const lastDayOfYear = new Date(year, 11, 31)
    return Math.ceil((Math.floor((lastDayOfYear - new Date(year, 0, 1)) / (24 * 60 * 60 * 1000)) + lastDayOfYear.getDay() + 1) / 7)
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

export function fixTime(delayedDate, episodeDate) {
    const delayed = new Date(delayedDate)
    const episodeAt = new Date(episodeDate)
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