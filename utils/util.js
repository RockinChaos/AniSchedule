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
