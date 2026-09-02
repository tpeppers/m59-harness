// Minimal binary min-heap used by the scheduler's single native timer.

const defaultCompare = (a, b) => a - b;

export class DeadlineHeap {
  constructor(compare = defaultCompare) {
    if (typeof compare !== 'function') throw new TypeError('DeadlineHeap needs a comparator');
    this.compare = compare;
    this.items = [];
  }

  get size() { return this.items.length; }
  peek() { return this.items[0] ?? null; }
  clear() { this.items.length = 0; }

  push(value) {
    const a = this.items;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(a[parent], value) <= 0) break;
      a[i] = a[parent];
      i = parent;
    }
    a[i] = value;
    return value;
  }

  pop() {
    const a = this.items;
    if (!a.length) return null;
    const first = a[0];
    const last = a.pop();
    if (!a.length) return first;

    let i = 0;
    while (true) {
      const left = i * 2 + 1;
      if (left >= a.length) break;
      const right = left + 1;
      let child = right < a.length && this.compare(a[right], a[left]) < 0 ? right : left;
      if (this.compare(a[child], last) >= 0) break;
      a[i] = a[child];
      i = child;
    }
    a[i] = last;
    return first;
  }
}
