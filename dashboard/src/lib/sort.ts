// Sorting a table by one of its columns (see components/SortTh.svelte).

export type SortDir = "asc" | "desc";
export type Sort<K extends string> = { key: K; dir: SortDir };

/**
 * What the sort becomes when a column heading is pressed: the same column
 * flips direction; another column starts in its natural direction (`first`).
 */
export function pressed<K extends string>(sort: Sort<K>, key: K, first: SortDir): Sort<K> {
  return { key, dir: sort.key === key ? (sort.dir === "asc" ? "desc" : "asc") : first };
}

/** Order two rows by a list of comparisons, the first that tells them apart wins. */
export function by<T>(...rules: ((a: T, b: T) => number)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const r of rules) {
      const d = r(a, b);
      if (d) return d;
    }
    return 0;
  };
}

/** Text, ignoring case. */
export const text = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });
