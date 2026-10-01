import { describe, expect, it } from 'vitest';
import { fma, goFormatFixed, goLog1p, goRound } from './gomath';
import { roundToTwoDecimals } from './taste';

function bits(x: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0);
}

const fusesFma = ['arm64', 'ppc64', 's390x', 'riscv64', 'loong64'].includes(process.arch);

describe('goLog1p', () => {
  it('matches Go golden values', () => {
    // Bits of Go's math.Log1p from Go's arm64 (fused) and amd64 (unfused)
    // builds, including inputs where the two disagree.
    const cases: Array<[number, bigint, bigint]> = [
      [0, 0x0n, 0x0n],
      [175, 0x4014ae935b3cb89dn, 0x4014ae935b3cb89en],
      [2992, 0x402002106af4c307n, 0x402002106af4c306n],
      [21794, 0x4023fa9756708404n, 0x4023fa9756708404n],
      [1, 0x3fe62e42fefa39efn, 0x3fe62e42fefa39efn],
      [199999, 0x402869825a924dfan, 0x402869825a924dfan],
      [200000, 0x402869830257dec4n, 0x402869830257dec4n],
    ];
    for (const [x, arm64, amd64] of cases) {
      expect(bits(goLog1p(x)), `log1p(${x})`).toBe(fusesFma ? arm64 : amd64);
    }
    expect(goLog1p(-2)).toBeNaN();
    expect(goLog1p(-1)).toBe(-Infinity);
    expect(goLog1p(Infinity)).toBe(Infinity);
    expect(goLog1p(1e-30)).toBe(1e-30);
  });
});

describe('fma', () => {
  it('rounds once', () => {
    // (1 + 2^-52)^2 - 1 needs the unrounded product: 2^-51 + 2^-104.
    const x = 1 + 2 ** -52;
    expect(fma(x, x, -1)).toBe(2 ** -51 + 2 ** -104);
    expect(x * x - 1).toBe(2 ** -51);
    // Ties in the final rounding go to even.
    expect(fma(2 ** 52 + 1, 1, 0.5)).toBe(2 ** 52 + 2);
    expect(fma(2 ** 52, 1, 0.5)).toBe(2 ** 52);
    expect(fma(3, 5, 7)).toBe(22);
    expect(Object.is(fma(-1, 1, 1), 0)).toBe(true);
    expect(fma(Infinity, 1, 1)).toBe(Infinity);
    expect(fma(2 ** 1000, 2 ** 1000, -Infinity)).toBe(-Infinity);
    // Subnormal results keep their reduced precision.
    expect(fma(2 ** -1074, 0.5, 2 ** -1074)).toBe(2 ** -1073);
  });
});

describe('goRound', () => {
  it('rounds half away from zero and keeps negative zero', () => {
    expect(goRound(2.5)).toBe(3);
    expect(goRound(-2.5)).toBe(-3);
    expect(goRound(0.49999999999999994)).toBe(0);
    expect(Object.is(goRound(-0.3), -0)).toBe(true);
    expect(goRound(2 ** 53 + 2)).toBe(2 ** 53 + 2);
    expect(roundToTwoDecimals(11 / 3)).toBe(3.67);
    expect(roundToTwoDecimals(4.125)).toBe(4.13);
  });
});

describe('goFormatFixed', () => {
  it('rounds exact binary ties half to even like fmt %.2f', () => {
    // Values checked against Go's fmt.Sprintf.
    const cases: Array<[number, number, string]> = [
      [0.125, 2, '0.12'],
      [0.375, 2, '0.38'],
      [2.5, 2, '2.50'],
      [2.5, 0, '2'],
      [1.5, 0, '2'],
      [0.5, 0, '0'],
      [-0.125, 2, '-0.12'],
      [-0.001, 2, '-0.00'],
      [-0, 2, '-0.00'],
      [1.005, 2, '1.00'],
      [0.005, 2, '0.01'],
      [0.015, 2, '0.01'],
      [0.025, 2, '0.03'],
      [123456789.125, 2, '123456789.12'],
      [1e22, 2, '10000000000000000000000.00'],
      [4.5, 2, '4.50'],
      [Infinity, 2, '+Inf'],
      [-Infinity, 2, '-Inf'],
      [NaN, 2, 'NaN'],
    ];
    for (const [value, precision, want] of cases) {
      expect(goFormatFixed(value, precision), `${value} %.${precision}f`).toBe(want);
    }
    // toFixed disagrees on exact ties, which is why the formatter exists.
    expect((0.125).toFixed(2)).toBe('0.13');
  });
});
