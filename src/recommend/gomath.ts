/**
 * Floating-point helpers that reproduce Go's results bit for bit.
 *
 * The favorite score feeds a sort and is printed by the CLI, so it must match
 * the Go build exactly. Three things differ from naive JavaScript:
 *
 * - Go's `math.Log1p` is a pure-Go port of FreeBSD's s_log1p.c; V8's
 *   `Math.log1p` differs from it in the last ulp for ~1% of inputs.
 * - Go's arm64 (and ppc64, s390x, riscv64, loong64) backend fuses every
 *   `a ± x*y` into a single-rounding multiply-add, even across variable
 *   assignments, so Go's own result depends on the architecture. JavaScript
 *   has no fused multiply-add, so {@link fma} computes one exactly.
 * - `fmt`'s `%.2f` rounds exact binary ties half to even, while
 *   `Number.prototype.toFixed` rounds them away from zero.
 */

/** Whether the Go compiler fuses multiply-adds on this architecture. */
const GO_FUSES_FMA = ['arm64', 'ppc64', 's390x', 'riscv64', 'loong64'].includes(process.arch);

const view = new DataView(new ArrayBuffer(8));

function float64Bits(x: number): bigint {
  view.setFloat64(0, x);
  return view.getBigUint64(0);
}

function float64FromBits(bits: bigint): number {
  view.setBigUint64(0, BigInt.asUintN(64, bits));
  return view.getFloat64(0);
}

/** Splits a finite double into an exact `mantissa * 2^exponent`. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  const bits = float64Bits(x);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xfffffffffffffn;
  let exponent = -1074;
  if (biased !== 0) {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  return { mantissa: bits >> 63n === 1n ? -mantissa : mantissa, exponent };
}

function bitLength(value: bigint): number {
  return value.toString(2).length;
}

/** Rounds `value * 2^exponent` to the nearest double, ties to even. */
function roundToDouble(value: bigint, exponent: number): number {
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  // Keep 53 significant bits, fewer when the result is subnormal.
  const shift = Math.max(bitLength(magnitude) - 53, -1074 - exponent);
  if (shift > 0) {
    const big = BigInt(shift);
    const remainder = magnitude & ((1n << big) - 1n);
    const half = 1n << (big - 1n);
    magnitude >>= big;
    if (remainder > half || (remainder === half && (magnitude & 1n) === 1n)) {
      magnitude += 1n;
    }
    exponent += shift;
  }
  // magnitude <= 2^53 and exponent >= -1074, so each step below is exact
  // unless the result overflows, which then correctly yields Infinity.
  let result = Number(magnitude);
  while (exponent > 1023) {
    result *= 2 ** 1023;
    exponent -= 1023;
  }
  result *= 2 ** exponent;
  return negative ? -result : result;
}

/** Fused multiply-add: `x*y + z` with a single rounding, like Go's `math.FMA`. */
export function fma(x: number, y: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) {
    // Exact zero or non-finite products: plain arithmetic already rounds once.
    return x * y + z;
  }
  if (!Number.isFinite(z)) {
    // A finite product cannot change an infinite or NaN addend, even when
    // the rounded product would overflow.
    return z;
  }
  if (z === 0) {
    return x * y;
  }
  const a = decompose(x);
  const b = decompose(y);
  const c = decompose(z);
  const productExponent = a.exponent + b.exponent;
  const exponent = Math.min(productExponent, c.exponent);
  const sum =
    ((a.mantissa * b.mantissa) << BigInt(productExponent - exponent)) + (c.mantissa << BigInt(c.exponent - exponent));
  if (sum === 0n) {
    return 0;
  }
  return roundToDouble(sum, exponent);
}

/** `a + x*y`, fused where Go fuses it. */
function madd(a: number, x: number, y: number): number {
  return GO_FUSES_FMA ? fma(x, y, a) : a + x * y;
}

/** `a - x*y`, fused where Go fuses it. */
function msub(a: number, x: number, y: number): number {
  return GO_FUSES_FMA ? fma(-x, y, a) : a - x * y;
}

/** `x*y - a`, fused where Go fuses it. */
function nmsub(a: number, x: number, y: number): number {
  return GO_FUSES_FMA ? fma(x, y, -a) : x * y - a;
}

/**
 * Go's `math.Log1p`, including exactly the multiply-add fusions the Go
 * compiler applies to it (verified exhaustively against Go by the Rust port).
 */
export function goLog1p(x: number): number {
  const SQRT2_M1 = 4.142135623730950488017e-1; // Sqrt(2)-1
  const SQRT2_HALF_M1 = -2.928932188134524755992e-1; // Sqrt(2)/2-1
  const SMALL = 2 ** -29;
  const TINY = 2 ** -54;
  const TWO53 = 2 ** 53;
  const LN2_HI = 6.9314718036912381649e-1;
  const LN2_LO = 1.90821492927058770002e-10;
  const LP1 = 6.66666666666673513e-1;
  const LP2 = 3.999999999940941908e-1;
  const LP3 = 2.857142874366239149e-1;
  const LP4 = 2.222219843214978396e-1;
  const LP5 = 1.818357216161805012e-1;
  const LP6 = 1.531383769920937332e-1;
  const LP7 = 1.479819860511658591e-1;

  if (x < -1 || Number.isNaN(x)) {
    return NaN;
  }
  if (x === -1) {
    return -Infinity;
  }
  if (x === Infinity) {
    return Infinity;
  }

  const absx = Math.abs(x);
  let f = 0;
  let iu = 0n;
  let k = 1;
  if (absx < SQRT2_M1) {
    if (absx < SMALL) {
      if (absx < TINY) {
        return x;
      }
      return msub(x, x * x, 0.5);
    }
    if (x > SQRT2_HALF_M1) {
      k = 0;
      f = x;
      iu = 1n;
    }
  }
  let c = 0;
  if (k !== 0) {
    let u: number;
    if (absx < TWO53) {
      u = 1 + x;
      iu = float64Bits(u);
      k = Number(iu >> 52n) - 1023;
      c = k > 0 ? 1 - (u - x) : x - (u - 1);
      c /= u;
    } else {
      u = x;
      iu = float64Bits(u);
      k = Number(iu >> 52n) - 1023;
      c = 0;
    }
    iu &= 0xfffffffffffffn;
    if (iu < 0x6a09e667f3bcdn) {
      u = float64FromBits(iu | 0x3ff0000000000000n);
    } else {
      k += 1;
      u = float64FromBits(iu | 0x3fe0000000000000n);
      iu = (0x10000000000000n - iu) >> 2n;
    }
    f = u - 1;
  }
  // hfsq stays an unrounded product where Go fuses it into a subtraction.
  const halfF = 0.5 * f;
  const hfsq = halfF * f;
  const kf = k;
  if (iu === 0n) {
    if (f === 0) {
      if (k === 0) {
        return 0;
      }
      c = madd(c, kf, LN2_LO);
      return madd(c, kf, LN2_HI);
    }
    // R = hfsq * w
    const w = msub(1, 0.66666666666666666, f);
    if (k === 0) {
      return msub(f, hfsq, w);
    }
    const inner = nmsub(madd(c, kf, LN2_LO), hfsq, w) - f;
    return nmsub(inner, kf, LN2_HI);
  }
  const s = f / (2 + f);
  const z = s * s;
  // R = z * poly. In hfsq + R both operands are products; Go's SSA fuses
  // the hfsq product and rounds R.
  const poly = madd(LP1, z, madd(LP2, z, madd(LP3, z, madd(LP4, z, madd(LP5, z, madd(LP6, z, LP7))))));
  const hfsqPlusR = madd(z * poly, halfF, f);
  if (k === 0) {
    return f - msub(hfsq, s, hfsqPlusR);
  }
  const tail = madd(madd(c, kf, LN2_LO), s, hfsqPlusR);
  const inner = nmsub(tail, halfF, f) - f;
  return nmsub(inner, kf, LN2_HI);
}

/** Go's `math.Round`: half away from zero, preserving -0. */
export function goRound(x: number): number {
  if (!Number.isFinite(x) || x === 0) {
    return x;
  }
  const truncated = Math.trunc(x);
  // x - trunc(x) is exact for every double.
  return Math.abs(x - truncated) >= 0.5 ? truncated + Math.sign(x) : truncated;
}

/**
 * Go's `fmt.Sprintf("%.<precision>f", value)`: the exact decimal value of
 * the double, rounded half to even, with Go's spellings of NaN and infinities.
 */
export function goFormatFixed(value: number, precision: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Infinity) {
    return '+Inf';
  }
  if (value === -Infinity) {
    return '-Inf';
  }
  const negative = value < 0 || Object.is(value, -0);
  const { mantissa, exponent } = decompose(Math.abs(value));
  const scale = 10n ** BigInt(precision);
  let digits: bigint;
  if (exponent >= 0) {
    digits = (mantissa << BigInt(exponent)) * scale;
  } else {
    const denominator = 1n << BigInt(-exponent);
    const scaled = mantissa * scale;
    digits = scaled / denominator;
    const twiceRemainder = (scaled % denominator) * 2n;
    if (twiceRemainder > denominator || (twiceRemainder === denominator && (digits & 1n) === 1n)) {
      digits += 1n;
    }
  }
  let text = digits.toString().padStart(precision + 1, '0');
  if (precision > 0) {
    text = `${text.slice(0, -precision)}.${text.slice(-precision)}`;
  }
  return negative ? `-${text}` : text;
}
