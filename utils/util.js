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
