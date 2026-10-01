/**
 * A port of Go's `slices.SortFunc` (pattern-defeating quicksort).
 *
 * pdqsort is not stable, so elements that compare equal can come out in a
 * different order than with `Array.prototype.sort`. The summary sent to the
 * LLM must list tracks in the same order as the Go build, including those
 * rare full ties, so the algorithm is ported verbatim. It is deterministic:
 * the pattern breaker's xorshift is seeded from the slice length.
 */

type Cmp<E> = (a: E, b: E) => number;

const enum Hint {
  Unknown,
  Increasing,
  Decreasing,
}

/** Sorts `data` in place exactly as Go's `slices.SortFunc` would. */
export function goSortFunc<E>(data: E[], cmp: Cmp<E>): void {
  const n = data.length;
  pdqsort(data, 0, n, bitsLen(n), cmp);
}

function bitsLen(n: number): number {
  return n === 0 ? 0 : Math.floor(Math.log2(n)) + 1;
}

function swap<E>(data: E[], i: number, j: number): void {
  const tmp = data[i] as E;
  data[i] = data[j] as E;
  data[j] = tmp;
}

function less<E>(data: E[], i: number, j: number, cmp: Cmp<E>): boolean {
  return cmp(data[i] as E, data[j] as E) < 0;
}

function insertionSort<E>(data: E[], a: number, b: number, cmp: Cmp<E>): void {
  for (let i = a + 1; i < b; i++) {
    for (let j = i; j > a && less(data, j, j - 1, cmp); j--) {
      swap(data, j, j - 1);
    }
  }
}

function siftDown<E>(data: E[], lo: number, hi: number, first: number, cmp: Cmp<E>): void {
  let root = lo;
  for (;;) {
    let child = 2 * root + 1;
    if (child >= hi) {
      return;
    }
    if (child + 1 < hi && less(data, first + child, first + child + 1, cmp)) {
      child++;
    }
    if (!less(data, first + root, first + child, cmp)) {
      return;
    }
    swap(data, first + root, first + child);
    root = child;
  }
}

function heapSort<E>(data: E[], a: number, b: number, cmp: Cmp<E>): void {
  const first = a;
  const hi = b - a;
  for (let i = Math.floor((hi - 1) / 2); i >= 0; i--) {
    siftDown(data, i, hi, first, cmp);
  }
  for (let i = hi - 1; i >= 0; i--) {
    swap(data, first, first + i);
    siftDown(data, 0, i, first, cmp);
  }
}

function pdqsort<E>(data: E[], a: number, b: number, limit: number, cmp: Cmp<E>): void {
  const maxInsertion = 12;
  let wasBalanced = true;
  let wasPartitioned = true;

  for (;;) {
    const length = b - a;
    if (length <= maxInsertion) {
      insertionSort(data, a, b, cmp);
      return;
    }
    if (limit === 0) {
      heapSort(data, a, b, cmp);
      return;
    }
    if (!wasBalanced) {
      breakPatterns(data, a, b);
      limit--;
    }

    let [pivot, hint] = choosePivot(data, a, b, cmp);
    if (hint === Hint.Decreasing) {
      reverseRange(data, a, b);
      pivot = b - 1 - (pivot - a);
      hint = Hint.Increasing;
    }

    if (wasBalanced && wasPartitioned && hint === Hint.Increasing) {
      if (partialInsertionSort(data, a, b, cmp)) {
        return;
      }
    }

    if (a > 0 && !less(data, a - 1, pivot, cmp)) {
      a = partitionEqual(data, a, b, pivot, cmp);
      continue;
    }

    const [mid, alreadyPartitioned] = partition(data, a, b, pivot, cmp);
    wasPartitioned = alreadyPartitioned;

    const leftLen = mid - a;
    const rightLen = b - mid;
    const balanceThreshold = Math.floor(length / 8);
    if (leftLen < rightLen) {
      wasBalanced = leftLen >= balanceThreshold;
      pdqsort(data, a, mid, limit, cmp);
      a = mid + 1;
    } else {
      wasBalanced = rightLen >= balanceThreshold;
      pdqsort(data, mid + 1, b, limit, cmp);
      b = mid;
    }
  }
}

function partition<E>(data: E[], a: number, b: number, pivot: number, cmp: Cmp<E>): [number, boolean] {
  swap(data, a, pivot);
  let i = a + 1;
  let j = b - 1;
  while (i <= j && less(data, i, a, cmp)) {
    i++;
  }
  while (i <= j && !less(data, j, a, cmp)) {
    j--;
  }
  if (i > j) {
    swap(data, j, a);
    return [j, true];
  }
  swap(data, i, j);
  i++;
  j--;
  for (;;) {
    while (i <= j && less(data, i, a, cmp)) {
      i++;
    }
    while (i <= j && !less(data, j, a, cmp)) {
      j--;
    }
    if (i > j) {
      break;
    }
    swap(data, i, j);
    i++;
    j--;
  }
  swap(data, j, a);
  return [j, false];
}

function partitionEqual<E>(data: E[], a: number, b: number, pivot: number, cmp: Cmp<E>): number {
  swap(data, a, pivot);
  let i = a + 1;
  let j = b - 1;
  for (;;) {
    while (i <= j && !less(data, a, i, cmp)) {
      i++;
    }
    while (i <= j && less(data, a, j, cmp)) {
      j--;
    }
    if (i > j) {
      break;
    }
    swap(data, i, j);
    i++;
    j--;
  }
  return i;
}

function partialInsertionSort<E>(data: E[], a: number, b: number, cmp: Cmp<E>): boolean {
  const maxSteps = 5;
  const shortestShifting = 50;
  let i = a + 1;
  for (let step = 0; step < maxSteps; step++) {
    while (i < b && !less(data, i, i - 1, cmp)) {
      i++;
    }
    if (i === b) {
      return true;
    }
    if (b - a < shortestShifting) {
      return false;
    }
    swap(data, i, i - 1);
    if (i - a >= 2) {
      for (let j = i - 1; j >= 1; j--) {
        if (!less(data, j, j - 1, cmp)) {
          break;
        }
        swap(data, j, j - 1);
      }
    }
    if (b - i >= 2) {
      for (let j = i + 1; j < b; j++) {
        if (!less(data, j, j - 1, cmp)) {
          break;
        }
        swap(data, j, j - 1);
      }
    }
  }
  return false;
}

function breakPatterns<E>(data: E[], a: number, b: number): void {
  const length = b - a;
  if (length < 8) {
    return;
  }
  let random = BigInt(length);
  const modulus = BigInt(2 ** bitsLen(length));
  const mask = (1n << 64n) - 1n;
  const half = Math.floor(length / 4) * 2;
  for (let idx = a + half - 1; idx <= a + half + 1; idx++) {
    random ^= (random << 13n) & mask;
    random ^= random >> 7n;
    random ^= (random << 17n) & mask;
    let other = Number(random & (modulus - 1n));
    if (other >= length) {
      other -= length;
    }
    swap(data, idx, a + other);
  }
}

function choosePivot<E>(data: E[], a: number, b: number, cmp: Cmp<E>): [number, Hint] {
  const shortestNinther = 50;
  const maxSwaps = 4 * 3;
  const l = b - a;
  const swaps = { count: 0 };
  let i = a + Math.floor(l / 4) * 1;
  let j = a + Math.floor(l / 4) * 2;
  let k = a + Math.floor(l / 4) * 3;

  if (l >= 8) {
    if (l >= shortestNinther) {
      i = median(data, i - 1, i, i + 1, swaps, cmp);
      j = median(data, j - 1, j, j + 1, swaps, cmp);
      k = median(data, k - 1, k, k + 1, swaps, cmp);
    }
    j = median(data, i, j, k, swaps, cmp);
  }

  switch (swaps.count) {
    case 0:
      return [j, Hint.Increasing];
    case maxSwaps:
      return [j, Hint.Decreasing];
    default:
      return [j, Hint.Unknown];
  }
}

function order2<E>(data: E[], a: number, b: number, swaps: { count: number }, cmp: Cmp<E>): [number, number] {
  if (less(data, b, a, cmp)) {
    swaps.count++;
    return [b, a];
  }
  return [a, b];
}

function median<E>(data: E[], a: number, b: number, c: number, swaps: { count: number }, cmp: Cmp<E>): number {
  [a, b] = order2(data, a, b, swaps, cmp);
  [b, c] = order2(data, b, c, swaps, cmp);
  [a, b] = order2(data, a, b, swaps, cmp);
  void c;
  return b;
}

function reverseRange<E>(data: E[], a: number, b: number): void {
  for (let i = a, j = b - 1; i < j; i++, j--) {
    swap(data, i, j);
  }
}
