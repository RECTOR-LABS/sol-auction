//! Pure helper functions extracted from instructions for testability.
//! No Anchor context dependencies — these operate on primitive types only.

/// Calculate auction fee and seller proceeds from a sale price.
/// Uses u128 intermediate to prevent overflow on large payments.
/// Returns (fee, seller_receives) or None on overflow.
pub fn calculate_fee(price: u64, fee_bps: u16) -> Option<(u64, u64)> {
    let fee_u128 = (price as u128)
        .checked_mul(fee_bps as u128)?
        .checked_div(10_000)?;
    let fee: u64 = fee_u128.try_into().ok()?;
    let seller_receives = price.checked_sub(fee)?;
    Some((fee, seller_receives))
}

/// Compute keccak256 commitment hash for sealed bids.
/// Format: keccak256(amount_le_bytes[8] || nonce[32])
pub fn compute_commitment_hash(amount: u64, nonce: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(40);
    input.extend_from_slice(&amount.to_le_bytes());
    input.extend_from_slice(nonce);
    solana_keccak_hasher::hash(&input).0
}

/// Update Vickrey second-price auction ranking after a bid reveal.
/// Returns (new_highest_bid, new_second_bid, is_new_winner).
pub fn update_vickrey_ranking(amount: u64, highest_bid: u64, second_bid: u64) -> (u64, u64, bool) {
    if amount > highest_bid {
        (amount, highest_bid, true)
    } else if amount > second_bid {
        (highest_bid, amount, false)
    } else {
        (highest_bid, second_bid, false)
    }
}

/// Calculate anti-snipe extension for English auctions.
/// If time remaining < anti_snipe_duration, returns Some(new_end_time).
/// Returns None if no extension needed or overflow.
pub fn calculate_anti_snipe_extension(
    current_time: i64,
    end_time: i64,
    anti_snipe_duration: i64,
) -> Option<i64> {
    let time_remaining = end_time.saturating_sub(current_time);
    if time_remaining < anti_snipe_duration {
        current_time.checked_add(anti_snipe_duration)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Fee Calculation ────────────────────────────────

    #[test]
    fn fee_standard_250bps() {
        let (fee, seller) = calculate_fee(1_000_000_000, 250).unwrap();
        assert_eq!(fee, 25_000_000); // 2.5% of 1 SOL
        assert_eq!(seller, 975_000_000);
    }

    #[test]
    fn fee_zero_bps() {
        let (fee, seller) = calculate_fee(1_000_000, 0).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(seller, 1_000_000);
    }

    #[test]
    fn fee_max_bps() {
        let (fee, seller) = calculate_fee(1_000_000, 10_000).unwrap();
        assert_eq!(fee, 1_000_000); // 100% fee
        assert_eq!(seller, 0);
    }

    #[test]
    fn fee_zero_price() {
        let (fee, seller) = calculate_fee(0, 250).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(seller, 0);
    }

    #[test]
    fn fee_large_price_no_overflow() {
        let result = calculate_fee(u64::MAX, 250);
        assert!(result.is_some());
        let (fee, seller) = result.unwrap();
        assert_eq!(fee + seller, u64::MAX);
    }

    #[test]
    fn fee_single_lamport_rounds_down() {
        let (fee, seller) = calculate_fee(1, 1).unwrap();
        assert_eq!(fee, 0); // 0.01% of 1 lamport rounds to 0
        assert_eq!(seller, 1);
    }

    // ── Commitment Hash ────────────────────────────────

    #[test]
    fn hash_deterministic() {
        let nonce = [42u8; 32];
        let h1 = compute_commitment_hash(1_000_000, &nonce);
        let h2 = compute_commitment_hash(1_000_000, &nonce);
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_different_amounts() {
        let nonce = [1u8; 32];
        let h1 = compute_commitment_hash(100, &nonce);
        let h2 = compute_commitment_hash(200, &nonce);
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_different_nonces() {
        let h1 = compute_commitment_hash(100, &[1u8; 32]);
        let h2 = compute_commitment_hash(100, &[2u8; 32]);
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_not_all_zeros() {
        let hash = compute_commitment_hash(0, &[0u8; 32]);
        assert_ne!(hash, [0u8; 32]); // keccak of any input != zeros
    }

    // ── Vickrey Ranking ────────────────────────────────

    #[test]
    fn vickrey_first_bid() {
        let (h, s, winner) = update_vickrey_ranking(100, 0, 0);
        assert_eq!((h, s, winner), (100, 0, true));
    }

    #[test]
    fn vickrey_higher_bid_displaces() {
        let (h, s, winner) = update_vickrey_ranking(200, 100, 50);
        assert_eq!((h, s, winner), (200, 100, true));
    }

    #[test]
    fn vickrey_lower_bid_updates_second() {
        let (h, s, winner) = update_vickrey_ranking(75, 100, 50);
        assert_eq!((h, s, winner), (100, 75, false));
    }

    #[test]
    fn vickrey_below_second_no_change() {
        let (h, s, winner) = update_vickrey_ranking(25, 100, 50);
        assert_eq!((h, s, winner), (100, 50, false));
    }

    #[test]
    fn vickrey_equal_to_highest_no_displacement() {
        // Equal doesn't displace (strictly greater required)
        let (h, s, winner) = update_vickrey_ranking(100, 100, 50);
        assert_eq!((h, s, winner), (100, 100, false));
    }

    // ── Anti-Snipe Extension ──────────────────────────

    #[test]
    fn anti_snipe_no_extension_plenty_time() {
        assert_eq!(calculate_anti_snipe_extension(100, 160, 10), None);
    }

    #[test]
    fn anti_snipe_triggered() {
        // 5s remaining, 10s threshold → extend to 110
        assert_eq!(calculate_anti_snipe_extension(100, 105, 10), Some(110));
    }

    #[test]
    fn anti_snipe_exact_boundary_no_extension() {
        // 10s remaining == 10s threshold → NOT triggered (< not <=)
        assert_eq!(calculate_anti_snipe_extension(100, 110, 10), None);
    }

    #[test]
    fn anti_snipe_zero_duration_never_triggers() {
        assert_eq!(calculate_anti_snipe_extension(100, 200, 0), None);
    }
}
