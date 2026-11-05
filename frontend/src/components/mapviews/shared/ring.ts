const DEFAULT_SIZE = 120;

/** Fixed-size ring of numbers (the last `size` samples), for frame and draw times. */
export class Ring {
  private readonly buf: Float64Array;
  private n = 0;
  private readonly size: number;
  constructor(size = DEFAULT_SIZE) {
    this.size = size;
    this.buf = new Float64Array(size);
  }
  push(v: number) {
    this.buf[this.n % this.size] = v;
    this.n++;
  }
  values(): Float64Array {
    return this.buf.subarray(0, Math.min(this.n, this.size));
  }
}
