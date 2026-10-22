//! A port of Go's pure-Go `math.Log1p` (itself from FreeBSD's s_log1p.c).
//!
//! The favorite score feeds a sort and is printed by the CLI, so it should be
//! bit-identical to the Go build. The platform libm `log1p` differs from Go's
//! implementation in the last ulp for ~1% of play counts, so the algorithm is
//! ported verbatim.
//!
//! Go's arm64 backend (and several others, but not amd64) fuses every
//! `a ± x*y` in SSA into a single-rounding multiply-add, even across variable
//! assignments. Go's own result therefore depends on the architecture. The
//! [`madd`]/[`msub`]/[`nmsub`] helpers reproduce exactly the fusions the Go
//! compiler performs on this function, so the port matches the Go binary
//! built for the same target.

/// Whether the Go compiler fuses multiply-adds on this architecture.
const GO_FUSES_FMA: bool = cfg!(any(
    target_arch = "aarch64",
    target_arch = "powerpc64",
    target_arch = "s390x",
    target_arch = "riscv64",
    target_arch = "loongarch64"
));

/// `a + x*y`
#[inline]
fn madd(a: f64, x: f64, y: f64) -> f64 {
    if GO_FUSES_FMA { x.mul_add(y, a) } else { a + x * y }
}

/// `a - x*y`
#[inline]
fn msub(a: f64, x: f64, y: f64) -> f64 {
    if GO_FUSES_FMA { (-x).mul_add(y, a) } else { a - x * y }
}

/// `x*y - a`
#[inline]
fn nmsub(a: f64, x: f64, y: f64) -> f64 {
    if GO_FUSES_FMA { x.mul_add(y, -a) } else { x * y - a }
}

#[allow(clippy::excessive_precision)]
pub(crate) fn log1p(x: f64) -> f64 {
    const SQRT2_M1: f64 = 4.142135623730950488017e-01; // Sqrt(2)-1
    const SQRT2_HALF_M1: f64 = -2.928932188134524755992e-01; // Sqrt(2)/2-1
    const SMALL: f64 = 1.0 / (1u64 << 29) as f64; // 2**-29
    const TINY: f64 = 1.0 / (1u64 << 54) as f64; // 2**-54
    const TWO53: f64 = (1u64 << 53) as f64; // 2**53
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const LP1: f64 = 6.666666666666735130e-01;
    const LP2: f64 = 3.999999999940941908e-01;
    const LP3: f64 = 2.857142874366239149e-01;
    const LP4: f64 = 2.222219843214978396e-01;
    const LP5: f64 = 1.818357216161805012e-01;
    const LP6: f64 = 1.531383769920937332e-01;
    const LP7: f64 = 1.479819860511658591e-01;

    if x < -1.0 || x.is_nan() {
        return f64::NAN;
    }
    if x == -1.0 {
        return f64::NEG_INFINITY;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }

    let absx = x.abs();
    let mut f = 0.0;
    let mut iu: u64 = 0;
    let mut k: i64 = 1;
    if absx < SQRT2_M1 {
        if absx < SMALL {
            if absx < TINY {
                return x;
            }
            return msub(x, x * x, 0.5);
        }
        if x > SQRT2_HALF_M1 {
            k = 0;
            f = x;
            iu = 1;
        }
    }
    let mut c = 0.0;
    if k != 0 {
        let mut u;
        if absx < TWO53 {
            u = 1.0 + x;
            iu = u.to_bits();
            k = ((iu >> 52) as i64) - 1023;
            c = if k > 0 { 1.0 - (u - x) } else { x - (u - 1.0) };
            c /= u;
        } else {
            u = x;
            iu = u.to_bits();
            k = ((iu >> 52) as i64) - 1023;
            c = 0.0;
        }
        iu &= 0x000f_ffff_ffff_ffff;
        if iu < 0x0006_a09e_667f_3bcd {
            u = f64::from_bits(iu | 0x3ff0_0000_0000_0000);
        } else {
            k += 1;
            u = f64::from_bits(iu | 0x3fe0_0000_0000_0000);
            iu = (0x0010_0000_0000_0000 - iu) >> 2;
        }
        f = u - 1.0;
    }
    // hfsq stays an unrounded product where Go fuses it into a subtraction.
    let half_f = 0.5 * f;
    let hfsq = half_f * f;
    let kf = k as f64;
    if iu == 0 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            c = madd(c, kf, LN2_LO);
            return madd(c, kf, LN2_HI);
        }
        // R = hfsq * w
        let w = msub(1.0, 0.66666666666666666, f);
        if k == 0 {
            return msub(f, hfsq, w);
        }
        let inner = nmsub(madd(c, kf, LN2_LO), hfsq, w) - f;
        return nmsub(inner, kf, LN2_HI);
    }
    let s = f / (2.0 + f);
    let z = s * s;
    // R = z * poly. In hfsq + R both operands are products; Go's SSA fuses
    // the hfsq product and rounds R (verified exhaustively against Go).
    let poly = madd(LP1, z, madd(LP2, z, madd(LP3, z, madd(LP4, z, madd(LP5, z, madd(LP6, z, LP7))))));
    let hfsq_plus_r = madd(z * poly, half_f, f);
    if k == 0 {
        return f - msub(hfsq, s, hfsq_plus_r);
    }
    let tail = madd(madd(c, kf, LN2_LO), s, hfsq_plus_r);
    let inner = nmsub(tail, half_f, f) - f;
    nmsub(inner, kf, LN2_HI)
}

#[cfg(test)]
mod tests {
    use super::log1p;

    #[test]
    fn matches_go_golden_values() {
        // Bits of Go's math.Log1p from Go's arm64 (fused) and amd64
        // (unfused) builds, including inputs where the two disagree.
        let cases: &[(f64, u64, u64)] = &[
            (0.0, 0x0, 0x0),
            (175.0, 0x4014ae935b3cb89d, 0x4014ae935b3cb89e),
            (2992.0, 0x402002106af4c307, 0x402002106af4c306),
            (21794.0, 0x4023fa9756708404, 0x4023fa9756708404),
            (1.0, 0x3fe62e42fefa39ef, 0x3fe62e42fefa39ef),
            (199999.0, 0x402869825a924dfa, 0x402869825a924dfa),
            (200000.0, 0x402869830257dec4, 0x402869830257dec4),
        ];
        for &(x, arm64, amd64) in cases {
            let want = if super::GO_FUSES_FMA { arm64 } else { amd64 };
            assert_eq!(log1p(x).to_bits(), want, "log1p({x})");
        }
        assert!(log1p(-2.0).is_nan());
        assert_eq!(log1p(-1.0), f64::NEG_INFINITY);
        assert_eq!(log1p(1e-30), 1e-30);
    }
}
