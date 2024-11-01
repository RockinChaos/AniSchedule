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
 * @param {Date} episodeDate
 * @param {number} weeks - the number of weeks past the episodeDate
 * @param {boolean} skip - Add the specified number of weeks regardless of the episodeDate having past.
 * @returns {String}
 */
export function past(episodeDate, weeks = 0, skip) {
    if (episodeDate < new Date() || skip) return new Date(episodeDate.getTime() + ((7 * 24 * 60 * 60 * 1000) * weeks)).toISOString().slice(0, -5) + 'Z'
    return episodeDate.toISOString().slice(0, -5) + 'Z'
}
