// Percentiles, and the test `diff` uses to tell a real change from run-to-run noise.

/// The p-th percentile of sorted values, between the two nearest ones.
pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = p / 100.0 * (sorted.len() - 1) as f64;
    let (lo, hi) = (rank.floor() as usize, rank.ceil() as usize);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64)
}

pub fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    percentile(&sorted, 50.0)
}

/// The two-sided p-value of the Mann-Whitney U test: how often two sets of values drawn from the
/// same distribution would sit at least this far apart. It assumes nothing about the distribution,
/// which suits timings, with their long tails.
pub fn mann_whitney(a: &[f64], b: &[f64]) -> f64 {
    let (n1, n2) = (a.len(), b.len());
    if n1 == 0 || n2 == 0 {
        return 1.0;
    }
    let mut all: Vec<(f64, bool)> = a
        .iter()
        .map(|&x| (x, true))
        .chain(b.iter().map(|&x| (x, false)))
        .collect();
    all.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut rank_a = 0.0;
    let mut ties = 0.0;
    let mut i = 0;
    while i < all.len() {
        let mut j = i;
        while j + 1 < all.len() && all[j + 1].0 == all[i].0 {
            j += 1;
        }
        let rank = (i + j) as f64 / 2.0 + 1.0;
        let t = (j - i + 1) as f64;
        ties += t * t * t - t;
        rank_a += rank * all[i..=j].iter().filter(|x| x.1).count() as f64;
        i = j + 1;
    }
    let u1 = rank_a - (n1 * (n1 + 1)) as f64 / 2.0;
    let u = u1.min((n1 * n2) as f64 - u1);
    if ties == 0.0 && n1 + n2 <= 40 {
        return exact(n1, n2, u as usize);
    }
    let n = (n1 + n2) as f64;
    let mean = (n1 * n2) as f64 / 2.0;
    let variance = (n1 * n2) as f64 / 12.0 * ((n + 1.0) - ties / (n * (n - 1.0)));
    if variance <= 0.0 {
        return 1.0;
    }
    let z = (mean - u - 0.5).max(0.0) / variance.sqrt();
    (2.0 * 0.5 * erfc(z / std::f64::consts::SQRT_2)).min(1.0)
}

/// The p-value under which `diff` calls a change.
pub const ALPHA: f64 = 0.05;

/// Whether n1 values against n2 can show a change at all. The smallest p-value the test can give
/// comes when every value of one set sits below every value of the other: 2 orderings out of
/// C(n1 + n2, n1). That is 0.1 for 3 against 3, so they can never show one, and 0.029 for 4
/// against 4.
pub fn can_show_change(n1: usize, n2: usize) -> bool {
    let mut orderings = 1.0f64;
    for i in 1..=n1.min(n2) {
        orderings = orderings * (n1 + n2 + 1 - i) as f64 / i as f64;
    }
    2.0 / orderings < ALPHA
}

/// The exact two-sided p-value for U = u, counting the orderings of n1 + n2 distinct values.
fn exact(n1: usize, n2: usize, u: usize) -> f64 {
    let size = n1 * n2 + 1;
    // ways[i][j][k]: orderings of i values from the first set and j from the second with U = k.
    let mut ways = vec![vec![vec![0.0f64; size]; n2 + 1]; n1 + 1];
    for i in 0..=n1 {
        for j in 0..=n2 {
            if i == 0 || j == 0 {
                ways[i][j][0] = 1.0;
                continue;
            }
            for k in 0..size {
                // The largest value is from the first set, beating all j, or from the second.
                let first = if k >= j { ways[i - 1][j][k - j] } else { 0.0 };
                ways[i][j][k] = first + ways[i][j - 1][k];
            }
        }
    }
    let all: f64 = ways[n1][n2].iter().sum();
    let tail: f64 = ways[n1][n2][..=u.min(size - 1)].iter().sum();
    (2.0 * tail / all).min(1.0)
}

/// The complementary error function, to about 1e-7 (Numerical Recipes' erfcc).
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let poly = -z * z - 1.265_512_23
        + t * (1.000_023_68
            + t * (0.374_091_96
                + t * (0.096_784_18
                    + t * (-0.186_288_06
                        + t * (0.278_868_07
                            + t * (-1.135_203_98
                                + t * (1.488_515_87 + t * (-0.822_152_23 + t * 0.170_872_77))))))));
    let r = t * poly.exp();
    if x >= 0.0 { r } else { 2.0 - r }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_interpolate() {
        let v = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(percentile(&v, 50.0), 2.5);
        assert_eq!(percentile(&v, 100.0), 4.0);
        assert_eq!(percentile(&[7.0], 95.0), 7.0);
    }

    #[test]
    fn five_runs_apart_are_a_change() {
        // Fully apart: the exact p-value is 2 / C(10, 5) = 2 / 252.
        let p = mann_whitney(
            &[10.0, 11.0, 12.0, 13.0, 14.0],
            &[20.0, 21.0, 22.0, 23.0, 24.0],
        );
        assert!((p - 2.0 / 252.0).abs() < 1e-9, "{p}");
    }

    #[test]
    fn three_runs_can_never_show_one() {
        // With 3 against 3 the smallest p-value is 2 / 20.
        let p = mann_whitney(&[1.0, 2.0, 3.0], &[10.0, 11.0, 12.0]);
        assert!((p - 0.1).abs() < 1e-9, "{p}");
    }

    #[test]
    fn enough_values_to_show_a_change() {
        // Smallest p-values: 3/3 2/20, 3/4 2/35 = 0.057, 3/5 2/56 = 0.036, 4/4 2/70 = 0.029.
        for (n1, n2, can) in [
            (0, 9, false),
            (3, 3, false),
            (3, 4, false),
            (3, 5, true),
            (4, 4, true),
        ] {
            assert_eq!(can_show_change(n1, n2), can, "{n1} against {n2}");
        }
    }

    #[test]
    fn mixed_values_are_no_change() {
        let p = mann_whitney(
            &[10.0, 14.0, 12.0, 16.0, 11.0],
            &[13.0, 9.0, 15.0, 12.5, 11.5],
        );
        assert!(p > 0.5, "{p}");
    }

    #[test]
    fn ties_use_the_normal_approximation() {
        let p = mann_whitney(&[5.0; 20], &[6.0; 20]);
        assert!(p < 1e-6, "{p}");
    }
}
